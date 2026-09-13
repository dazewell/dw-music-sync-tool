import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runBackup } from "../src/core/backup.js";
import type { PlaylistProvider } from "../src/core/models.js";
import { pruneExpiredBackups } from "../src/core/retention.js";
import {
  BACKUP_OWNER_FILENAME, BACKUP_PENDING_FILENAME, createBackupRun, listBackups,
  readManifest, recoverInterruptedBackups, resolveBackupFile,
} from "../src/core/storage.js";

vi.mock("node:fs/promises", async importOriginal => ({
  ...await importOriginal<typeof import("node:fs/promises")>(),
}));

const startedAt = "2026-01-01T00:00:00.000Z";
const expiry = Date.parse("2026-01-31T00:00:00.000Z");
let scratch: string;
let root: string;

beforeEach(async () => {
  scratch = path.resolve(`.test-recovery-${randomUUID()}`);
  root = path.join(scratch, "crashed");
  await fs.mkdir(root, { recursive: true });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await fs.rm(scratch, { recursive: true, force: true });
});

function provider(): PlaylistProvider {
  const playlist = {
    provider: "youtube" as const, id: "fixture", title: "Fixture", description: "",
    url: "https://example.test/playlist", owner: "fixture", itemCount: 0, visibility: "private" as const,
  };
  return {
    id: "youtube", coverage: "Synthetic fixture",
    listPlaylists: async () => [playlist],
    getPlaylist: async item => ({ playlist: item, warnings: [], entries: [] }),
  };
}

type Boundary = "owner" | "initial-manifest-stage" | "intent-stage" | "intent"
  | "json-stage" | "json" | "csv-stage" | "csv" | "m3u-stage" | "full"
  | "checkpoint-stage" | "checkpoint" | "cleanup";

/** Copy the actual durable bytes at a write boundary, without a real process crash. */
async function snapshot(boundary: Boundary, playlistCount = 1): Promise<string> {
  let id: string | undefined;
  let captures = 0;
  const capture = async (directory: string) => {
    if (id || ++captures !== playlistCount) return;
    id = path.basename(directory);
    await fs.cp(directory, path.join(root, id), { recursive: true });
  };
  const rename = fs.rename;
  const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
    const directory = path.dirname(String(destination));
    const file = path.basename(String(destination));
    const isExport = file.startsWith("Fixture-");
    let before: Boundary | undefined;
    let after: Boundary | undefined;
    if (file === BACKUP_OWNER_FILENAME) after = "owner";
    if (file === BACKUP_PENDING_FILENAME) {
      before = "intent-stage";
      after = "intent";
    }
    if (isExport) {
      const intent = JSON.parse(await fs.readFile(path.join(directory, BACKUP_PENDING_FILENAME), "utf8"));
      const output = intent.outputs.find((item: { file: string }) => item.file === file);
      expect(output.temporary).toBe(path.basename(String(source)));
      const text = await fs.readFile(source);
      expect(output.size).toBe(text.length);
      expect(output.sha256).toBe(createHash("sha256").update(text).digest("hex"));
      const format = file.endsWith(".json") ? "json" : file.endsWith(".csv") ? "csv" : "m3u";
      expect(intent.result.integrity[format]).toEqual({ size: output.size, sha256: output.sha256 });
      if (file.endsWith(".json")) { before = "json-stage"; after = "json"; }
      if (file.endsWith(".csv")) { before = "csv-stage"; after = "csv"; }
      if (file.endsWith(".m3u8")) { before = "m3u-stage"; after = "full"; }
    }
    if (file === "manifest.json") {
      const manifest = JSON.parse(await fs.readFile(source, "utf8"));
      if (manifest.status === "running" && manifest.totals.playlists === 0) before = "initial-manifest-stage";
      if (manifest.status === "running" && manifest.playlists.length === 1) {
        before = "checkpoint-stage";
        after = "checkpoint";
      }
    }
    if (before === boundary) await capture(directory);
    await rename(source, destination);
    if (after === boundary) await capture(directory);
  });
  const unlink = fs.unlink;
  const unlinkSpy = vi.spyOn(fs, "unlink").mockImplementation(async filename => {
    await unlink(filename);
    if (boundary === "cleanup" && path.basename(String(filename)) === BACKUP_PENDING_FILENAME) {
      await capture(path.dirname(String(filename)));
    }
  });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(startedAt));
  try {
    const fixture = provider();
    if (playlistCount > 1) {
      const [playlist] = await fixture.listPlaylists();
      fixture.listPlaylists = async () => Array.from({ length: playlistCount }, (_, index) => ({
        ...playlist!, id: `fixture-${index}`,
      }));
    }
    await runBackup(fixture, path.join(scratch, "source"));
  } finally {
    vi.useRealTimers();
    renameSpy.mockRestore();
    unlinkSpy.mockRestore();
  }
  expect(id).toBeDefined();
  return id!;
}

async function contents(id: string): Promise<Record<string, Buffer>> {
  const directory = path.join(root, id);
  return Object.fromEntries(await Promise.all((await fs.readdir(directory)).map(async name => [
    name, await fs.readFile(path.join(directory, name)),
  ])));
}

async function pending(id: string) {
  return JSON.parse(await fs.readFile(path.join(root, id, BACKUP_PENDING_FILENAME), "utf8"));
}

describe("durable interruption boundaries", () => {
  it("reconciles an owner-only orphan that history previously skipped, without inventing a provider", async () => {
    const id = await snapshot("owner");
    expect(await listBackups(root)).toEqual([]);
    const recursive = vi.spyOn(fs, "rm");
    expect(await recoverInterruptedBackups(root)).toEqual([]);
    expect(recursive).not.toHaveBeenCalled();
    await expect(fs.stat(path.join(root, id))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await recoverInterruptedBackups(root)).toEqual([]);
    expect(await pruneExpiredBackups(root, expiry)).toEqual({ deleted: [], warnings: [] });
  });

  it.each([
    "intent", "json-stage", "json", "csv-stage", "csv", "m3u-stage", "full",
    "checkpoint-stage", "checkpoint", "cleanup",
  ] as const)("recovers %s and expires only explicitly journaled artifacts", async boundary => {
    const id = await snapshot(boundary);
    const before = await contents(id);
    const [recovered] = await recoverInterruptedBackups(root);
    const checkpointed = boundary === "checkpoint" || boundary === "cleanup";
    expect(recovered).toMatchObject({
      id, status: "interrupted", completedAt: null,
      totals: { playlists: 1, completed: checkpointed ? 1 : 0, failed: 0, entries: 0 },
    });
    expect(recovered!.playlists).toHaveLength(checkpointed ? 1 : 0);
    if (checkpointed) {
      for (const format of ["json", "csv", "m3u"] as const) {
        const bytes = before[recovered!.playlists[0]!.files![format]]!;
        expect(recovered!.playlists[0]!.integrity![format]).toEqual({
          size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
        });
      }
    }
    for (const [name, bytes] of Object.entries(before)) {
      if (name !== "manifest.json") expect(await fs.readFile(path.join(root, id, name))).toEqual(bytes);
    }
    if (!checkpointed) {
      const intent = await pending(id);
      await expect(resolveBackupFile(root, id, intent.result.files.json))
        .rejects.toMatchObject({ code: "BACKUP_FILE_NOT_FOUND" });
    }
    expect(await recoverInterruptedBackups(root)).toEqual([]);
    expect(await pruneExpiredBackups(root, expiry - 1)).toEqual({ deleted: [], warnings: [] });
    const recursive = vi.spyOn(fs, "rm");
    expect(await pruneExpiredBackups(root, expiry)).toEqual({ deleted: [id], warnings: [] });
    expect(recursive).not.toHaveBeenCalled();
    expect(await pruneExpiredBackups(root, expiry)).toEqual({ deleted: [], warnings: [] });
  });

  it.each(["initial-manifest-stage", "intent-stage"] as const)(
    "reports and preserves an uncommitted %s rather than claiming its staging filename",
    async boundary => {
      const id = await snapshot(boundary);
      const before = await contents(id);
      await expect(recoverInterruptedBackups(root)).rejects.toMatchObject({
        code: "BACKUP_RECOVERY_ERROR", message: expect.stringContaining("unexpected"),
      });
      expect(await contents(id)).toEqual(before);
      expect((await pruneExpiredBackups(root, expiry)).deleted).toEqual([]);
      expect(await contents(id)).toEqual(before);
    },
  );

  it("refuses owner-only recovery while the originating run is locally active", async () => {
    const run = await createBackupRun(root);
    try {
      await expect(recoverInterruptedBackups(root)).rejects.toMatchObject({ code: "BACKUP_ACTIVE" });
      expect(await fs.readdir(run.directory)).toEqual([BACKUP_OWNER_FILENAME]);
    } finally {
      await run.release();
    }
    expect(await recoverInterruptedBackups(root)).toEqual([]);
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("keeps readable legacy archives without a journal or ownership marker", async () => {
    const id = await snapshot("cleanup");
    await fs.unlink(path.join(root, id, BACKUP_OWNER_FILENAME));
    const [recovered] = await recoverInterruptedBackups(root);
    expect(recovered!.playlists).toHaveLength(1);
    expect(recovered!.status).toBe("interrupted");
    expect(await pruneExpiredBackups(root, expiry)).toEqual({ deleted: [], warnings: [] });
  });
});

describe("unprovable ownership remains protected", () => {
  it.each(["owner", "intent", "json", "full", "checkpoint"] as const)(
    "preserves unrelated user files at the %s boundary, including export-looking names",
    async boundary => {
      const id = await snapshot(boundary);
      await fs.writeFile(path.join(root, id, "personal.csv"), "User data");
      const before = await contents(id);
      const unlink = vi.spyOn(fs, "unlink");
      await expect(recoverInterruptedBackups(root)).rejects.toMatchObject({
        code: "BACKUP_RECOVERY_ERROR", message: expect.stringContaining("unexpected"),
      });
      expect(unlink).not.toHaveBeenCalled();
      expect(await contents(id)).toEqual(before);
      expect((await pruneExpiredBackups(root, expiry)).deleted).toEqual([]);
      expect(await contents(id)).toEqual(before);
    },
  );

  it.each(["id", "timestamp", "extra-field", "invalid-json"] as const)(
    "preserves an owner-only orphan with %s tampering",
    async corruption => {
      const id = await snapshot("owner");
      const filename = path.join(root, id, BACKUP_OWNER_FILENAME);
      const owner = JSON.parse(await fs.readFile(filename, "utf8"));
      if (corruption === "id") owner.id = `${startedAt.replace(/[:.]/g, "-")}_${randomUUID()}`;
      if (corruption === "timestamp") owner.createdAt = "2025-01-01T00:00:00.000Z";
      if (corruption === "extra-field") owner.untrusted = true;
      await fs.writeFile(filename, corruption === "invalid-json" ? "{" : JSON.stringify(owner));
      const before = await contents(id);
      await expect(recoverInterruptedBackups(root)).rejects.toMatchObject({ code: "BACKUP_RECOVERY_ERROR" });
      expect(await contents(id)).toEqual(before);
    },
  );

  it.each(["id", "index", "checkpoint", "file", "metadata-path", "hash", "size", "result", "invalid-json"] as const)(
    "rejects pending intent %s tampering before any cleanup",
    async corruption => {
      const id = await snapshot("full");
      const intent = await pending(id);
      if (corruption === "id") intent.id = `${startedAt.replace(/[:.]/g, "-")}_${randomUUID()}`;
      if (corruption === "index") intent.index++;
      if (corruption === "checkpoint") intent.checkpoint = "0".repeat(64);
      if (corruption === "file") intent.outputs[0].file = "../user.json";
      if (corruption === "metadata-path") {
        intent.result.files = { json: BACKUP_OWNER_FILENAME, csv: ".backup-owner.csv", m3u: ".backup-owner.m3u8" };
        intent.outputs[0].file = BACKUP_OWNER_FILENAME;
        intent.outputs[1].file = ".backup-owner.csv";
        intent.outputs[2].file = ".backup-owner.m3u8";
      }
      if (corruption === "hash") intent.outputs[0].sha256 = "0".repeat(64);
      if (corruption === "size") intent.outputs[0].size++;
      if (corruption === "result") intent.result.status = "failed";
      await fs.writeFile(path.join(root, id, BACKUP_PENDING_FILENAME), corruption === "invalid-json" ? "{" : JSON.stringify(intent));
      const before = await contents(id);
      const unlink = vi.spyOn(fs, "unlink");
      await expect(recoverInterruptedBackups(root)).rejects.toMatchObject({ code: "BACKUP_RECOVERY_ERROR" });
      expect(unlink).not.toHaveBeenCalled();
      expect(await contents(id)).toEqual(before);
    },
  );

  it("rejects tampered manifest metadata without modifying pending exports", async () => {
    const id = await snapshot("full");
    const manifest = await readManifest(root, id);
    manifest.coverage = "Altered manifest";
    await fs.writeFile(path.join(root, id, "manifest.json"), JSON.stringify(manifest));
    const before = await contents(id);
    await expect(recoverInterruptedBackups(root)).rejects.toMatchObject({ code: "BACKUP_RECOVERY_ERROR" });
    expect(await contents(id)).toEqual(before);
  });

  it.each(["changed", "truncated-stage", "duplicate-stage"] as const)(
    "preserves %s files instead of trusting the recorded filename alone",
    async corruption => {
      const id = await snapshot(corruption === "truncated-stage" ? "json-stage" : "full");
      const intent = await pending(id);
      const output = intent.outputs[0];
      if (corruption === "changed") await fs.writeFile(path.join(root, id, output.file), "Personal replacement");
      if (corruption === "truncated-stage") await fs.truncate(path.join(root, id, output.temporary), 3);
      if (corruption === "duplicate-stage") {
        await fs.copyFile(path.join(root, id, output.file), path.join(root, id, output.temporary));
      }
      const before = await contents(id);
      await expect(recoverInterruptedBackups(root)).rejects.toMatchObject({ code: "BACKUP_RECOVERY_ERROR" });
      expect(await contents(id)).toEqual(before);
    },
  );

  it.each(["owner", "manifest", "intent", "export", "stage"] as const)(
    "rejects hard-linked %s files, preserving the link target",
    async kind => {
      const id = await snapshot(kind === "owner" ? "owner" : kind === "stage" ? "json-stage" : "full");
      const intent = kind === "owner" ? undefined : await pending(id);
      const name = kind === "owner" ? BACKUP_OWNER_FILENAME : kind === "manifest" ? "manifest.json"
        : kind === "intent" ? BACKUP_PENDING_FILENAME
        : kind === "stage" ? intent.outputs[0].temporary : intent.outputs[0].file;
      const file = path.join(root, id, name);
      const outside = path.join(scratch, "outside");
      const original = await fs.readFile(file);
      await fs.link(file, outside);
      const unlink = vi.spyOn(fs, "unlink");
      await expect(recoverInterruptedBackups(root)).rejects.toMatchObject({ code: "BACKUP_RECOVERY_ERROR" });
      expect(unlink).not.toHaveBeenCalled();
      expect(await fs.readFile(outside)).toEqual(original);
      expect(await fs.readFile(file)).toEqual(original);
    },
  );

  it.each(["run", "intent", "export"] as const)("rejects a linked %s without touching the target", async kind => {
    const id = await snapshot("full");
    const intent = await pending(id);
    const directory = path.join(root, id);
    const file = kind === "run" ? directory : path.join(directory, kind === "intent" ? BACKUP_PENDING_FILENAME : intent.outputs[0].file);
    const outside = path.join(scratch, "outside");
    if (kind === "run") await fs.rename(directory, outside);
    else {
      await fs.unlink(file);
      await fs.mkdir(outside);
      await fs.writeFile(path.join(outside, "personal.txt"), "Keep me");
    }
    await fs.symlink(outside, file, process.platform === "win32" ? "junction" : "dir");
    const before = await fs.readdir(outside);
    const unlink = vi.spyOn(fs, "unlink");
    await expect(recoverInterruptedBackups(root)).rejects.toMatchObject({ code: "UNSAFE_BACKUP_PATH" });
    expect(unlink).not.toHaveBeenCalled();
    expect(await fs.readdir(outside)).toEqual(before);
  });
});

describe("recovery and journal retention retries", () => {
  it("still accepts original evidence from a legacy pending journal without backfilling a manifest", async () => {
    const id = await snapshot("checkpoint");
    const manifest = await readManifest(root, id);
    delete manifest.playlists[0]!.integrity;
    const intent = await pending(id);
    delete intent.result.integrity;
    await fs.writeFile(path.join(root, id, "manifest.json"), JSON.stringify(manifest));
    await fs.writeFile(path.join(root, id, BACKUP_PENDING_FILENAME), JSON.stringify(intent));
    const [recovered] = await recoverInterruptedBackups(root);
    expect(recovered!.playlists[0]!.integrity).toBeUndefined();
    expect((await readManifest(root, id)).playlists[0]!.integrity).toBeUndefined();
    expect(await pruneExpiredBackups(root, expiry)).toEqual({ deleted: [id], warnings: [] });
  });

  it.each([false, true])(
    "checks earlier checkpointed exports alongside a later interrupted playlist (replacement: %s)",
    async replace => {
      const id = await snapshot("full", 2);
      const [manifest] = await recoverInterruptedBackups(root);
      expect(manifest!.playlists).toHaveLength(1);
      expect(manifest!.playlists[0]!.integrity).toBeDefined();
      expect((await pending(id)).index).toBe(1);
      if (replace) {
        const filename = path.join(root, id, manifest!.playlists[0]!.files!.csv);
        const bytes = await fs.readFile(filename);
        await fs.writeFile(filename, Buffer.alloc(bytes.length, "u"));
      }
      const before = await contents(id);
      const unlink = vi.spyOn(fs, "unlink");
      const result = await pruneExpiredBackups(root, expiry);
      if (replace) {
        expect(result.deleted).toEqual([]);
        expect(result.warnings.join(" ")).toContain("recorded contents");
        expect(unlink).not.toHaveBeenCalled();
        expect(await contents(id)).toEqual(before);
      } else {
        expect(result).toEqual({ deleted: [id], warnings: [] });
      }
    },
  );

  it.each(["export-cleanup", "checkpoint", "journal-cleanup"] as const)(
    "retains a usable intent after a caught %s failure, not just an abrupt stop",
    async boundary => {
      const rename = fs.rename;
      const unlink = fs.unlink;
      let failed = false;
      vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
        const name = path.basename(String(destination));
        if (boundary === "export-cleanup" && name.endsWith(".csv")) throw new Error("Disk full");
        if (boundary === "checkpoint" && !failed && name === "manifest.json") {
          const manifest = JSON.parse(await fs.readFile(source, "utf8"));
          if (manifest.status === "running" && manifest.playlists.length === 1) {
            failed = true;
            throw new Error("Checkpoint locked");
          }
        }
        await rename(source, destination);
      });
      vi.spyOn(fs, "unlink").mockImplementation(async filename => {
        const name = path.basename(String(filename));
        if (!failed && (boundary === "export-cleanup" ? name.startsWith("Fixture-") && name.endsWith(".json")
          : boundary === "journal-cleanup" && name === BACKUP_PENDING_FILENAME)) {
          failed = true;
          throw new Error("Cleanup locked");
        }
        await unlink(filename);
      });
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(startedAt));
      await expect(runBackup(provider(), root)).rejects.toBeDefined();
      vi.useRealTimers();
      vi.restoreAllMocks();
      const [manifest] = await listBackups(root);
      expect(manifest!.status).toBe("failed");
      expect(manifest!.playlists[0]!.status).toBe(boundary === "export-cleanup" ? "failed" : "complete");
      expect(await pending(manifest!.id)).toBeDefined();
      expect(await recoverInterruptedBackups(root)).toEqual([]);
      expect(await pruneExpiredBackups(root, expiry)).toEqual({ deleted: [manifest!.id], warnings: [] });
    },
  );

  it("never overwrites a user file found at an intended output path", async () => {
    const fixture = provider();
    const original = fixture.getPlaylist;
    let userFile: string | undefined;
    fixture.getPlaylist = async playlist => {
      const [run] = await listBackups(root);
      const hash = createHash("sha256").update("youtube:fixture").digest("hex").slice(0, 12);
      userFile = path.join(root, run!.id, `Fixture-${hash}-0001.csv`);
      await fs.writeFile(userFile, "User data");
      return original(playlist);
    };
    await expect(runBackup(fixture, root)).rejects.toMatchObject({ code: "BACKUP_RECOVERY_ERROR" });
    expect(await fs.readFile(userFile!, "utf8")).toBe("User data");
    const [manifest] = await listBackups(root);
    expect(manifest!.playlists[0]!.status).toBe("failed");
    expect(await fs.readdir(path.join(root, manifest!.id))).not.toContain(BACKUP_PENDING_FILENAME);
  });

  it("restores an owner-only marker if removing the empty directory fails", async () => {
    const id = await snapshot("owner");
    const before = await contents(id);
    vi.spyOn(fs, "rmdir").mockRejectedValueOnce(new Error("Directory locked"));
    await expect(recoverInterruptedBackups(root)).rejects.toMatchObject({ code: "BACKUP_STORAGE_ERROR" });
    expect(await contents(id)).toEqual(before);
    expect(await recoverInterruptedBackups(root)).toEqual([]);
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("retains the intent and prior checkpoint when the recovery checkpoint fails, then retries", async () => {
    const id = await snapshot("full");
    const before = await contents(id);
    vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("Disk full"));
    await expect(recoverInterruptedBackups(root)).rejects.toMatchObject({ code: "BACKUP_STORAGE_ERROR" });
    expect(await contents(id)).toEqual(before);
    expect((await recoverInterruptedBackups(root))[0]!.status).toBe("interrupted");
    expect(await pruneExpiredBackups(root, expiry)).toEqual({ deleted: [id], warnings: [] });
  });

  it.each(["export", "journal", "manifest", "directory"] as const)(
    "retries interrupted retention at %s without losing ownership of leftovers",
    async boundary => {
      const id = await snapshot("checkpoint-stage");
      await recoverInterruptedBackups(root);
      const intentText = await fs.readFile(path.join(root, id, BACKUP_PENDING_FILENAME), "utf8");
      if (boundary === "directory") vi.spyOn(fs, "rmdir").mockRejectedValueOnce(new Error("Locked"));
      else {
        const original = fs.unlink;
        let failed = false;
        vi.spyOn(fs, "unlink").mockImplementation(async filename => {
          const name = path.basename(String(filename));
          if (!failed && (boundary === "export" ? name.endsWith(".csv")
            : name === (boundary === "journal" ? BACKUP_PENDING_FILENAME : "manifest.json"))) {
            failed = true;
            throw new Error("Locked");
          }
          await original(filename);
        });
      }
      const first = await pruneExpiredBackups(root, expiry);
      expect(first.deleted).toEqual([]);
      expect(first.warnings.join(" ")).toContain("safe retry");
      expect(await fs.readFile(path.join(root, id, BACKUP_PENDING_FILENAME), "utf8")).toBe(intentText);
      expect((await readManifest(root, id)).status).toBe("interrupted");
      expect(await recoverInterruptedBackups(root)).toEqual([]);
      expect(await pruneExpiredBackups(root, expiry)).toEqual({ deleted: [id], warnings: [] });
    },
  );

  it("does not let a user addition after recovery become retention-owned", async () => {
    const id = await snapshot("full");
    await recoverInterruptedBackups(root);
    await fs.writeFile(path.join(root, id, "extra.m3u8"), "User playlist");
    const before = await contents(id);
    const result = await pruneExpiredBackups(root, expiry);
    expect(result.deleted).toEqual([]);
    expect(result.warnings.join(" ")).toContain("unexpected entry");
    expect(await contents(id)).toEqual(before);
  });

  it("rechecks the pending content during retention, not only during startup", async () => {
    const id = await snapshot("full");
    await recoverInterruptedBackups(root);
    const intent = await pending(id);
    const filename = path.join(root, id, intent.outputs[0].file);
    const bytes = await fs.readFile(filename);
    bytes[0] = bytes[0] === 123 ? 32 : 123;
    await fs.writeFile(filename, bytes);
    const before = await contents(id);
    const result = await pruneExpiredBackups(root, expiry);
    expect(result.deleted).toEqual([]);
    expect(result.warnings.join(" ")).toContain("recorded contents");
    expect(await contents(id)).toEqual(before);
  });
});
