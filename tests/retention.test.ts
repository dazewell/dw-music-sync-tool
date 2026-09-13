import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readManifest, runBackup } from "../src/core/backup.js";
import type { BackupManifest, PlaylistProvider } from "../src/core/models.js";
import { backupExpiresAt, pruneExpiredBackups, RETENTION_DAYS } from "../src/core/retention.js";
import { BACKUP_OWNER_APP, BACKUP_OWNER_FILENAME } from "../src/core/storage.js";

vi.mock("node:fs/promises", async importOriginal => ({
  ...await importOriginal<typeof import("node:fs/promises")>(),
}));

const startedAt = "2026-01-01T00:00:00.000Z";
const expiry = Date.parse("2026-01-31T00:00:00.000Z");
let scratch: string;
let root: string;

beforeEach(async () => {
  scratch = path.resolve(`.test-retention-${randomUUID()}`);
  root = path.join(scratch, "backups");
  await fs.mkdir(root, { recursive: true });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await fs.rm(scratch, { recursive: true, force: true });
});

function provider(): PlaylistProvider {
  const playlist = {
    provider: "youtube" as const, id: "fixture", title: "Retention fixture", description: "",
    url: "https://example.test/playlist", owner: "fixture", itemCount: 1, visibility: "private" as const,
  };
  return {
    id: "youtube", coverage: "Synthetic test data",
    listPlaylists: async () => [playlist],
    getPlaylist: async () => ({
      playlist, warnings: [], entries: [{
        id: "item", mediaId: "media", position: 0, title: "Test item", artist: null,
        album: null, url: "https://example.test/media", availability: "available",
        addedAt: null, providerData: {},
      }],
    }),
  };
}

async function backup(date = startedAt, fixture = provider(), directory = root): Promise<BackupManifest> {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(date));
  try {
    return await runBackup(fixture, directory);
  } finally {
    vi.useRealTimers();
  }
}

function runPath(manifest: BackupManifest, file?: string): string {
  return file ? path.join(root, manifest.id, file) : path.join(root, manifest.id);
}

describe("rolling 30-day expiration", () => {
  it("calculates exactly 30 elapsed UTC days and rejects invalid timestamps", () => {
    expect(RETENTION_DAYS).toBe(30);
    expect(backupExpiresAt(startedAt)).toBe("2026-01-31T00:00:00.000Z");
    expect(backupExpiresAt("2026-02-01T23:30:00.000Z")).toBe("2026-03-03T23:30:00.000Z");
    expect(() => backupExpiresAt("not a date")).toThrow(expect.objectContaining({ code: "INVALID_RETENTION_TIME" }));
    expect(() => backupExpiresAt("2026-02-30T00:00:00.000Z")).toThrow();
  });

  it("writes persistent exact ownership metadata before provider listing", async () => {
    const fixture = provider();
    const original = fixture.listPlaylists;
    fixture.listPlaylists = async () => {
      const [id] = await fs.readdir(root);
      expect(JSON.parse(await fs.readFile(path.join(root, id!, BACKUP_OWNER_FILENAME), "utf8"))).toEqual({
        app: BACKUP_OWNER_APP, schemaVersion: 1, id, createdAt: startedAt,
      });
      expect((await readManifest(root, id!)).status).toBe("running");
      return original();
    };
    const manifest = await backup(startedAt, fixture);
    expect(await fs.stat(runPath(manifest, BACKUP_OWNER_FILENAME))).toBeDefined();
  });

  it("preserves a run one millisecond before expiry and deletes only that run at the exact threshold", async () => {
    const old = await backup();
    const recent = await backup("2026-01-02T00:00:00.000Z");
    const recentManifest = await fs.readFile(runPath(recent, "manifest.json"));
    expect(await pruneExpiredBackups(root, expiry - 1)).toEqual({ deleted: [], warnings: [] });
    const recursiveRemoval = vi.spyOn(fs, "rm");
    expect(await pruneExpiredBackups(root, expiry)).toEqual({ deleted: [old.id], warnings: [] });
    expect(recursiveRemoval).not.toHaveBeenCalled();
    await expect(fs.stat(runPath(old))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(runPath(recent, "manifest.json"))).toEqual(recentManifest);
  });

  it("handles missing roots without writes and rejects invalid injected time", async () => {
    expect(await pruneExpiredBackups(path.join(scratch, "missing"), expiry)).toEqual({ deleted: [], warnings: [] });
    await expect(pruneExpiredBackups(root, Number.NaN)).rejects.toMatchObject({ code: "INVALID_RETENTION_TIME" });
  });

  it("silently preserves recent active runs and warns only when an active run expires", async () => {
    const fixture = provider();
    const original = fixture.listPlaylists;
    fixture.listPlaylists = async () => {
      const [id] = await fs.readdir(root);
      expect(await pruneExpiredBackups(root, expiry - 1)).toEqual({ deleted: [], warnings: [] });
      const result = await pruneExpiredBackups(root, expiry);
      expect(result.deleted).toEqual([]);
      expect(result.warnings.join(" ")).toContain("running");
      expect((await readManifest(root, id!)).status).toBe("running");
      return original();
    };
    const manifest = await backup(startedAt, fixture);
    expect(manifest.status).toBe("complete");
  });
});

describe("positive ownership and deletion preflight", () => {
  it("never deletes an unmarked backup or unrelated user files", async () => {
    const manifest = await backup();
    await fs.unlink(runPath(manifest, BACKUP_OWNER_FILENAME));
    const before = await fs.readdir(runPath(manifest));
    await fs.writeFile(path.join(root, "notes.txt"), "User notes");
    await fs.mkdir(path.join(root, "personal"));
    await fs.writeFile(path.join(root, "personal", "data.txt"), "Personal data");
    const result = await pruneExpiredBackups(root, expiry);
    expect(result.deleted).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(await fs.readdir(runPath(manifest))).toEqual(before);
    expect(await fs.readFile(path.join(root, "notes.txt"), "utf8")).toBe("User notes");
    expect(await fs.readFile(path.join(root, "personal", "data.txt"), "utf8")).toBe("Personal data");
  });

  it("ignores a demo subfolder and notes.txt without blocking real-root cleanup", async () => {
    const real = await backup();
    const demoRoot = path.join(root, "demo");
    const demo = await backup(startedAt, provider(), demoRoot);
    const demoManifest = path.join(demoRoot, demo.id, "manifest.json");
    const original = await fs.readFile(demoManifest);
    await fs.writeFile(path.join(root, "notes.txt"), "User notes");
    expect(await pruneExpiredBackups(root, expiry)).toEqual({ deleted: [real.id], warnings: [] });
    expect(await fs.readFile(demoManifest)).toEqual(original);
    expect(await fs.readFile(path.join(root, "notes.txt"), "utf8")).toBe("User notes");
  });

  it("silently preserves a folder explicitly marked as owned by another app", async () => {
    const manifest = await backup();
    const ownerPath = runPath(manifest, BACKUP_OWNER_FILENAME);
    const owner = JSON.parse(await fs.readFile(ownerPath, "utf8"));
    await fs.writeFile(ownerPath, JSON.stringify({ ...owner, app: "someone-else" }));
    const before = await fs.readdir(runPath(manifest));
    expect(await pruneExpiredBackups(root, expiry)).toEqual({ deleted: [], warnings: [] });
    expect(await fs.readdir(runPath(manifest))).toEqual(before);
  });

  it.each(["file", "directory", "link"] as const)("preserves the whole expired run when an unexpected %s is present", async kind => {
    const manifest = await backup();
    const addition = runPath(manifest, "user-addition");
    if (kind === "file") await fs.writeFile(addition, "Keep me");
    if (kind === "directory") await fs.mkdir(addition);
    if (kind === "link") {
      const target = path.join(scratch, "outside");
      await fs.mkdir(target);
      await fs.writeFile(path.join(target, "private.txt"), "Keep target");
      await fs.symlink(target, addition, process.platform === "win32" ? "junction" : "dir");
    }
    const before = await fs.readdir(runPath(manifest));
    const unlink = vi.spyOn(fs, "unlink");
    const result = await pruneExpiredBackups(root, expiry);
    expect(result.deleted).toEqual([]);
    expect(result.warnings.join(" ")).toContain("unexpected entry");
    expect(unlink).not.toHaveBeenCalled();
    expect(await fs.readdir(runPath(manifest))).toEqual(before);
    if (kind === "link") expect(await fs.readFile(path.join(scratch, "outside", "private.txt"), "utf8")).toBe("Keep target");
  });

  it.each(["malformed-marker", "wrong-id", "wrong-time", "malformed-manifest"] as const)(
    "preserves expired runs with %s and emits a warning",
    async corruption => {
      const manifest = await backup();
      const ownerPath = runPath(manifest, BACKUP_OWNER_FILENAME);
      const owner = JSON.parse(await fs.readFile(ownerPath, "utf8"));
      if (corruption === "malformed-marker") await fs.writeFile(ownerPath, "{bad");
      if (corruption === "wrong-id") await fs.writeFile(ownerPath, JSON.stringify({ ...owner, id: "other" }));
      if (corruption === "wrong-time") await fs.writeFile(ownerPath, JSON.stringify({ ...owner, createdAt: "2025-01-01T00:00:00.000Z" }));
      if (corruption === "malformed-manifest") await fs.writeFile(runPath(manifest, "manifest.json"), "{}");
      const before = await fs.readdir(runPath(manifest));
      const result = await pruneExpiredBackups(root, expiry);
      expect(result.deleted).toEqual([]);
      expect(result.warnings).toHaveLength(1);
      expect(await fs.readdir(runPath(manifest))).toEqual(before);
    },
  );

  it("rejects linked run directories without touching their targets", async () => {
    const manifest = await backup();
    const target = path.join(scratch, "outside");
    await fs.rename(runPath(manifest), target);
    await fs.symlink(target, runPath(manifest), process.platform === "win32" ? "junction" : "dir");
    const before = await fs.readdir(target);
    const result = await pruneExpiredBackups(root, expiry);
    expect(result.deleted).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(await fs.readdir(target)).toEqual(before);
  });

  it("rejects links at declared export paths before deleting any files", async () => {
    const manifest = await backup();
    const file = manifest.playlists[0]!.files!.csv;
    await fs.unlink(runPath(manifest, file));
    const target = path.join(scratch, "outside");
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, "private.txt"), "Keep target");
    await fs.symlink(target, runPath(manifest, file), process.platform === "win32" ? "junction" : "dir");
    const unlink = vi.spyOn(fs, "unlink");
    const result = await pruneExpiredBackups(root, expiry);
    expect(result.deleted).toEqual([]);
    expect(result.warnings.join(" ")).toContain("unlinked file");
    expect(unlink).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(target, "private.txt"), "utf8")).toBe("Keep target");
  });

  it("preserves runs with a live legacy active marker", async () => {
    const manifest = await backup();
    await fs.writeFile(runPath(manifest, ".active.json"), JSON.stringify({ pid: process.pid, token: randomUUID() }));
    const result = await pruneExpiredBackups(root, expiry);
    expect(result.deleted).toEqual([]);
    expect(result.warnings.join(" ")).toContain("live process");
    expect(await readManifest(root, manifest.id)).toEqual(manifest);
  });

  it("removes only a validated stale legacy active marker alongside an expired managed run", async () => {
    const manifest = await backup();
    await fs.writeFile(runPath(manifest, ".active.json"), JSON.stringify({ pid: 123456, token: randomUUID() }));
    vi.spyOn(process, "kill").mockImplementationOnce(() => {
      throw Object.assign(new Error("No such process"), { code: "ESRCH" });
    });
    expect(await pruneExpiredBackups(root, expiry)).toEqual({ deleted: [manifest.id], warnings: [] });
  });

  it("rejects manifest exports that collide with ownership metadata", async () => {
    const manifest = await backup();
    manifest.playlists[0]!.files = {
      json: BACKUP_OWNER_FILENAME, csv: ".backup-owner.csv", m3u: ".backup-owner.m3u8",
    };
    await fs.writeFile(runPath(manifest, "manifest.json"), JSON.stringify(manifest));
    const unlink = vi.spyOn(fs, "unlink");
    const result = await pruneExpiredBackups(root, expiry);
    expect(result.deleted).toEqual([]);
    expect(result.warnings.join(" ")).toContain("protected run metadata");
    expect(unlink).not.toHaveBeenCalled();
  });
});

describe("safe retries after partial filesystem failure", () => {
  it("keeps ownership and manifest when export unlink fails, then retries missing exports safely", async () => {
    const manifest = await backup();
    const original = fs.unlink;
    let failed = false;
    vi.spyOn(fs, "unlink").mockImplementation(async filename => {
      if (!failed && String(filename).endsWith(".csv")) {
        failed = true;
        throw Object.assign(new Error("File is locked"), { code: "EACCES" });
      }
      return original(filename);
    });
    const first = await pruneExpiredBackups(root, expiry);
    expect(first.deleted).toEqual([]);
    expect(first.warnings.join(" ")).toContain("safe retry");
    expect(await readManifest(root, manifest.id)).toEqual(manifest);
    expect(await fs.stat(runPath(manifest, BACKUP_OWNER_FILENAME))).toBeDefined();
    await expect(fs.stat(runPath(manifest, manifest.playlists[0]!.files!.json))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await pruneExpiredBackups(root, expiry)).toEqual({ deleted: [manifest.id], warnings: [] });
  });

  it.each(["marker", "directory"] as const)("restores deletion metadata if removing the final %s fails", async failing => {
    const manifest = await backup();
    const marker = await fs.readFile(runPath(manifest, BACKUP_OWNER_FILENAME), "utf8");
    if (failing === "marker") {
      const original = fs.unlink;
      let failed = false;
      vi.spyOn(fs, "unlink").mockImplementation(async filename => {
        if (!failed && path.basename(String(filename)) === BACKUP_OWNER_FILENAME) {
          failed = true;
          throw new Error("Marker is locked");
        }
        return original(filename);
      });
    } else {
      vi.spyOn(fs, "rmdir").mockRejectedValueOnce(new Error("Directory is locked"));
    }
    const first = await pruneExpiredBackups(root, expiry);
    expect(first.deleted).toEqual([]);
    expect(first.warnings.join(" ")).toContain("safe retry");
    expect(await readManifest(root, manifest.id)).toEqual(manifest);
    expect(await fs.readFile(runPath(manifest, BACKUP_OWNER_FILENAME), "utf8")).toBe(marker);
    expect(await pruneExpiredBackups(root, expiry)).toEqual({ deleted: [manifest.id], warnings: [] });
  });
});
