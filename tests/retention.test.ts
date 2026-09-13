import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listBackups, readManifest, recoverInterruptedBackups, resolveBackupFile, runBackup } from "../src/core/backup.js";
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

async function runContents(manifest: BackupManifest): Promise<Record<string, Buffer>> {
  return Object.fromEntries(await Promise.all((await fs.readdir(runPath(manifest))).map(async name => [
    name, await fs.readFile(runPath(manifest, name)),
  ])));
}

async function backupWithStatus(status: "complete" | "partial" | "interrupted"): Promise<BackupManifest> {
  const fixture = provider();
  if (status === "partial") {
    const [playlist] = await fixture.listPlaylists();
    const original = fixture.getPlaylist;
    fixture.listPlaylists = async () => [playlist!, { ...playlist!, id: "failed" }];
    fixture.getPlaylist = async item => {
      if (item.id === "failed") throw new Error("Synthetic playlist failure");
      return original(item);
    };
  }
  const manifest = await backup(startedAt, fixture);
  if (status === "interrupted") {
    await fs.writeFile(runPath(manifest, "manifest.json"), JSON.stringify({
      ...manifest, status: "running", completedAt: null,
    }));
    return (await recoverInterruptedBackups(root))[0]!;
  }
  return manifest;
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

describe("original integrity evidence for completed exports", () => {
  it.each(["json", "csv", "m3u"] as const)(
    "preserves the entire run after a same-size %s replacement, even with the original mtime",
    async format => {
      const manifest = await backup();
      const filename = runPath(manifest, manifest.playlists[0]!.files![format]);
      const before = await fs.stat(filename);
      const replacement = Buffer.alloc(before.size, "x");
      await fs.unlink(filename);
      await fs.writeFile(filename, replacement);
      await fs.utimes(filename, before.atime, before.mtime);
      const contents = await runContents(manifest);
      const unlink = vi.spyOn(fs, "unlink");
      const result = await pruneExpiredBackups(root, expiry);
      expect(result.deleted).toEqual([]);
      expect(result.warnings.join(" ")).toContain("recorded contents");
      expect(unlink).not.toHaveBeenCalled();
      expect(await runContents(manifest)).toEqual(contents);
      expect(await fs.readFile(filename)).toEqual(replacement);
    },
  );

  it.each(["complete", "partial", "interrupted"] as const)(
    "requires original evidence for every completed playlist of a %s run",
    async status => {
      const manifest = await backupWithStatus(status);
      expect(manifest.status).toBe(status);
      const filename = runPath(manifest, manifest.playlists[0]!.files!.csv);
      await fs.writeFile(filename, "Unrelated user content");
      const before = await runContents(manifest);
      const unlink = vi.spyOn(fs, "unlink");
      const result = await pruneExpiredBackups(root, expiry);
      expect(result.deleted).toEqual([]);
      expect(result.warnings.join(" ")).toContain("recorded size");
      expect(unlink).not.toHaveBeenCalled();
      expect(await runContents(manifest)).toEqual(before);
    },
  );

  it.each(["complete", "partial", "interrupted"] as const)(
    "keeps %s legacy archives readable but never backfills or deletes unverifiable exports",
    async status => {
      const manifest = await backupWithStatus(status);
      for (const playlist of manifest.playlists) delete playlist.integrity;
      await fs.writeFile(runPath(manifest, "manifest.json"), JSON.stringify(manifest));
      expect(await readManifest(root, manifest.id)).toEqual(manifest);
      expect(await listBackups(root)).toEqual([manifest]);
      expect(await resolveBackupFile(root, manifest.id, manifest.playlists[0]!.files!.json))
        .toBe(runPath(manifest, manifest.playlists[0]!.files!.json));
      const before = await runContents(manifest);
      expect(await recoverInterruptedBackups(root)).toEqual([]);
      const unlink = vi.spyOn(fs, "unlink");
      const result = await pruneExpiredBackups(root, expiry);
      expect(result.deleted).toEqual([]);
      expect(result.warnings.join(" ")).toContain("no original integrity evidence");
      expect(unlink).not.toHaveBeenCalled();
      expect(await runContents(manifest)).toEqual(before);
      expect((await readManifest(root, manifest.id)).playlists[0]!.integrity).toBeUndefined();
    },
  );

  it("verifies the last export's hash before unlinking the first export", async () => {
    const manifest = await backup();
    const filename = runPath(manifest, manifest.playlists[0]!.files!.m3u);
    const bytes = await fs.readFile(filename);
    bytes[0] = bytes[0] === 35 ? 32 : 35;
    await fs.writeFile(filename, bytes);
    const before = await runContents(manifest);
    const unlink = vi.spyOn(fs, "unlink");
    expect((await pruneExpiredBackups(root, expiry)).warnings.join(" ")).toContain("recorded contents");
    expect(unlink).not.toHaveBeenCalled();
    expect(await runContents(manifest)).toEqual(before);
  });

  it.each(["size", "sha256"] as const)("preserves a run when persisted %s evidence is changed", async field => {
    const manifest = await backup();
    const proof = manifest.playlists[0]!.integrity!.m3u;
    if (field === "size") proof.size++;
    else proof.sha256 = "0".repeat(64);
    await fs.writeFile(runPath(manifest, "manifest.json"), JSON.stringify(manifest));
    const before = await runContents(manifest);
    const unlink = vi.spyOn(fs, "unlink");
    const result = await pruneExpiredBackups(root, expiry);
    expect(result.deleted).toEqual([]);
    expect(result.warnings.join(" ")).toContain("recorded");
    expect(unlink).not.toHaveBeenCalled();
    expect(await runContents(manifest)).toEqual(before);
  });

  it("rechecks the pathname when a file is replaced while its original open handle is being verified", async () => {
    const manifest = await backup();
    const filename = runPath(manifest, manifest.playlists[0]!.files!.json);
    const outside = path.join(scratch, "moved-original.json");
    const bytes = await fs.readFile(filename);
    const open = fs.open;
    let verifications = 0;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (String(args[0]) === filename && ++verifications === 2) {
        const stat = handle.stat.bind(handle);
        let stats = 0;
        vi.spyOn(handle, "stat").mockImplementation(async () => {
          const info = await stat();
          if (++stats === 2) {
            await fs.rename(filename, outside);
            await fs.writeFile(filename, Buffer.alloc(bytes.length, "u"));
          }
          return info;
        });
      }
      return handle;
    });
    const unlink = vi.spyOn(fs, "unlink");
    const result = await pruneExpiredBackups(root, expiry);
    expect(verifications).toBe(2);
    expect(result.deleted).toEqual([]);
    expect(result.warnings.join(" ")).toContain("replaced while");
    expect(unlink).not.toHaveBeenCalled();
    expect(await fs.readFile(filename)).toEqual(Buffer.alloc(bytes.length, "u"));
    expect(await fs.readFile(outside)).toEqual(bytes);
  });

  it("preserves a replacement recreated at a path already deleted by an interrupted retention pass", async () => {
    const manifest = await backup();
    const files = manifest.playlists[0]!.files!;
    const original = await fs.readFile(runPath(manifest, files.json));
    const unlink = fs.unlink;
    vi.spyOn(fs, "unlink").mockImplementation(async filename => {
      if (String(filename).endsWith(".csv")) throw new Error("Locked");
      await unlink(filename);
    });
    expect((await pruneExpiredBackups(root, expiry)).warnings.join(" ")).toContain("safe retry");
    await expect(fs.stat(runPath(manifest, files.json))).rejects.toMatchObject({ code: "ENOENT" });
    vi.restoreAllMocks();
    await fs.writeFile(runPath(manifest, files.json), Buffer.alloc(original.length, "u"));
    const before = await runContents(manifest);
    const retryUnlink = vi.spyOn(fs, "unlink");
    expect((await pruneExpiredBackups(root, expiry)).warnings.join(" ")).toContain("recorded contents");
    expect(retryUnlink).not.toHaveBeenCalled();
    expect(await runContents(manifest)).toEqual(before);
  });

  it("rejects a hard-linked completed export before unlinking any file", async () => {
    const manifest = await backup();
    const filename = runPath(manifest, manifest.playlists[0]!.files!.m3u);
    const outside = path.join(scratch, "user-copy");
    const original = await fs.readFile(filename);
    await fs.link(filename, outside);
    const unlink = vi.spyOn(fs, "unlink");
    const result = await pruneExpiredBackups(root, expiry);
    expect(result.deleted).toEqual([]);
    expect(result.warnings.join(" ")).toContain("unlinked file");
    expect(unlink).not.toHaveBeenCalled();
    expect(await fs.readFile(outside)).toEqual(original);
    expect(await fs.readFile(filename)).toEqual(original);
  });

  it.each(["replace", "hardlink", "manifest"] as const)(
    "rejects a concurrent %s after hashing but before the first deletion",
    async mutation => {
      const manifest = await backup();
      const output = runPath(manifest, manifest.playlists[0]!.files!.m3u);
      const bytes = await fs.readFile(output);
      const readdir = fs.readdir;
      let runReads = 0;
      const hook = vi.spyOn(fs, "readdir").mockImplementation(async (...args) => {
        const entries = await (readdir as (...values: unknown[]) => Promise<unknown>)(...args);
        if (String(args[0]) === runPath(manifest) && ++runReads === 2) {
          if (mutation === "replace") await fs.writeFile(output, Buffer.alloc(bytes.length, "r"));
          if (mutation === "hardlink") await fs.link(output, path.join(scratch, "user-link"));
          if (mutation === "manifest") await fs.appendFile(runPath(manifest, "manifest.json"), " ");
        }
        return entries as Awaited<ReturnType<typeof fs.readdir>>;
      });
      const unlink = vi.spyOn(fs, "unlink");
      const result = await pruneExpiredBackups(root, expiry);
      expect(runReads).toBeGreaterThanOrEqual(2);
      expect(result.deleted).toEqual([]);
      expect(result.warnings.join(" ")).toMatch(/changed|unlinked/);
      expect(unlink).not.toHaveBeenCalled();
      hook.mockRestore();
      expect(await fs.readdir(runPath(manifest))).toContain(manifest.playlists[0]!.files!.json);
    },
  );

  it.each(["missing", "deleted"] as const)(
    "does not adopt a %s export that reappears during a retention pass",
    async boundary => {
      const manifest = await backup();
      const files = manifest.playlists[0]!.files!;
      const json = runPath(manifest, files.json);
      const bytes = await fs.readFile(json);
      if (boundary === "missing") await fs.unlink(json);
      const readdir = fs.readdir;
      let runReads = 0;
      vi.spyOn(fs, "readdir").mockImplementation(async (...args) => {
        if (String(args[0]) === runPath(manifest) && ++runReads === (boundary === "missing" ? 2 : 3)) {
          await fs.writeFile(json, Buffer.alloc(bytes.length, "u"));
        }
        return (readdir as (...values: unknown[]) => Promise<Awaited<ReturnType<typeof fs.readdir>>>)(...args);
      });
      const unlink = vi.spyOn(fs, "unlink");
      const result = await pruneExpiredBackups(root, expiry);
      expect(result.deleted).toEqual([]);
      expect(result.warnings.join(" ")).toContain("reappeared");
      expect(unlink).toHaveBeenCalledTimes(boundary === "missing" ? 0 : 1);
      expect(await fs.readFile(json)).toEqual(Buffer.alloc(bytes.length, "u"));
      expect(await fs.stat(runPath(manifest, files.csv))).toBeDefined();
      expect((await readManifest(root, manifest.id)).playlists[0]!.integrity).toEqual(manifest.playlists[0]!.integrity);
    },
  );
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
