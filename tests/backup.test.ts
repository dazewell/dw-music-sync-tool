import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listBackups, readManifest, recoverInterruptedBackups, resolveBackupFile, runBackup } from "../src/core/backup.js";
import type { BackupManifest, Playlist, PlaylistEntry, PlaylistProvider } from "../src/core/models.js";
import { fingerprintPlaylist } from "../src/core/sync.js";
import { BACKUP_OWNER_FILENAME } from "../src/core/storage.js";

vi.mock("node:fs/promises", async importOriginal => ({
  ...await importOriginal<typeof import("node:fs/promises")>(),
}));

let root: string;

beforeEach(async () => {
  root = path.resolve(`.test-backup-${randomUUID()}`);
  await fs.mkdir(root);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

function playlist(id: string, title = "Favorites"): Playlist {
  return {
    provider: "youtube", id, title, description: "Original description", owner: "Local fixture",
    url: `https://example.test/playlist/${id}`, itemCount: 3, visibility: "private",
    snapshotId: `snapshot-${id}`,
  };
}

function entry(id: string, mediaId: string | null, position: number): PlaylistEntry {
  return {
    id, position, mediaId, title: mediaId ? `Song ${mediaId}` : "Unavailable song",
    artist: null, album: null, url: mediaId ? `https://example.test/watch?v=${mediaId}` : null,
    availability: mediaId ? "available" : "unavailable", addedAt: null,
    providerData: { original: { itemId: id, nested: [1, null, "value"] } },
  };
}

function provider(playlists = [playlist("one")], entries?: PlaylistEntry[]): PlaylistProvider {
  return {
    id: "youtube",
    coverage: "Fixture playlists visible to the account; no audio is downloaded.",
    listPlaylists: vi.fn(async () => playlists),
    getPlaylist: vi.fn(async item => ({
      playlist: entries ? { ...item, itemCount: entries.length } : item,
      entries: entries ?? [entry("first", "a", 0), entry("missing", null, 1), entry("last", "a", 2)],
      warnings: ["An unavailable item remains in its original position."],
    })),
  };
}

async function writeManifest(manifest: BackupManifest): Promise<void> {
  await fs.writeFile(path.join(root, manifest.id, "manifest.json"), JSON.stringify(manifest));
}

async function successfulBackup(): Promise<BackupManifest> {
  return runBackup(provider(), root);
}

describe("complete local playlist archives", () => {
  it("initializes before listing and checkpoints sequentially, preserving duplicate names and item order", async () => {
    const playlists = [playlist("one"), playlist("two"), playlist("one")];
    const fixture = provider(playlists);
    const getContents = fixture.getPlaylist;
    let lastManifest: BackupManifest | undefined;
    fixture.listPlaylists = async () => {
      const runs = await listBackups(root);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ status: "running", completedAt: null, playlists: [] });
      lastManifest = runs[0];
      return playlists;
    };
    let requested = 0;
    fixture.getPlaylist = async item => {
      expect(lastManifest).toBeDefined();
      const checkpoint = await readManifest(root, lastManifest!.id);
      expect(checkpoint.status).toBe("running");
      expect(checkpoint.totals.playlists).toBe(3);
      expect(checkpoint.playlists).toHaveLength(requested++);
      for (const result of checkpoint.playlists) {
        for (const file of Object.values(result.files!)) {
          expect(await fs.stat(await resolveBackupFile(root, checkpoint.id, file))).toBeDefined();
        }
      }
      return getContents(item);
    };
    const progress = vi.fn();
    const manifest = await runBackup(fixture, root, progress);
    expect(manifest).toMatchObject({
      status: "complete", schemaVersion: 1, error: null,
      totals: { playlists: 3, completed: 3, failed: 0, entries: 9 },
    });
    expect(manifest.completedAt).not.toBeNull();
    expect(manifest.id).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z_[0-9a-f-]{36}$/);
    expect(progress).toHaveBeenLastCalledWith({ current: 3, total: 3, playlistTitle: "Favorites" });
    const filenames = manifest.playlists.flatMap(result => Object.values(result.files!));
    expect(new Set(filenames).size).toBe(9);
    for (const [index, result] of manifest.playlists.entries()) {
      const hash = createHash("sha256").update(`youtube:${playlists[index]!.id}`).digest("hex").slice(0, 12);
      const basename = `Favorites-${hash}-${String(index + 1).padStart(4, "0")}`;
      expect(result.files).toEqual({ json: `${basename}.json`, csv: `${basename}.csv`, m3u: `${basename}.m3u8` });
      for (const format of ["json", "csv", "m3u"] as const) {
        const bytes = await fs.readFile(await resolveBackupFile(root, manifest.id, result.files![format]));
        expect(result.integrity![format]).toEqual({
          size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
        });
      }
      const archive = JSON.parse(await fs.readFile(await resolveBackupFile(root, manifest.id, result.files!.json), "utf8"));
      expect(archive).toMatchObject({
        schemaVersion: 1, playlist: playlists[index],
        entries: [entry("first", "a", 0), entry("missing", null, 1), entry("last", "a", 2)],
        warnings: ["An unavailable item remains in its original position."],
      });
      expect(archive.fingerprint).toBe(result.fingerprint);
      expect(result.fingerprint).toBe(fingerprintPlaylist("youtube", archive.entries));
      expect(archive.exportedAt).toMatch(/Z$/);
      const m3u = await fs.readFile(await resolveBackupFile(root, manifest.id, result.files!.m3u), "utf8");
      expect(m3u).toBe([
        "#EXTM3U",
        "# Playlist URL references only; no audio is downloaded or included.",
        "#PLAYLIST:Favorites",
        "#EXTINF:-1,Song a", "https://example.test/watch?v=a",
        "#UNAVAILABLE:1 missing Unavailable song",
        "#EXTINF:-1,Song a", "https://example.test/watch?v=a", "",
      ].join("\n"));
    }
    expect((await fs.readdir(path.join(root, manifest.id))).sort()).toEqual([...filenames, BACKUP_OWNER_FILENAME, "manifest.json"].sort());
    expect(await readManifest(root, manifest.id)).toEqual(manifest);
  });

  it("exports exact quoted UTF-8 CSV rows and neutralizes formula injection without changing canonical JSON", async () => {
    const items = [
      { ...entry("row-1", "a", 0), title: '=SUM("a",1)\r\nnext', artist: "+Band", album: "Café, 日", addedAt: "2026-09-13T00:00:00Z" },
      { ...entry("row-2", null, 1), title: " \t@hidden", artist: "\tTabbed", album: "-1" },
    ];
    const manifest = await runBackup(provider([playlist("csv")], items), root);
    const files = manifest.playlists[0]!.files!;
    const csv = await fs.readFile(await resolveBackupFile(root, manifest.id, files.csv), "utf8");
    expect(csv).toBe(
      '\ufeff"position","entry_id","media_id","title","artist","album","url","availability","added_at"\r\n'
      + '"0","row-1","a","\'=SUM(""a"",1)\r\nnext","\'+Band","Café, 日","https://example.test/watch?v=a","available","2026-09-13T00:00:00Z"\r\n'
      + '"1","row-2","","\' \t@hidden","\'\tTabbed","\'-1","","unavailable",""\r\n',
    );
    const archive = JSON.parse(await fs.readFile(await resolveBackupFile(root, manifest.id, files.json), "utf8"));
    expect(archive.entries).toEqual(items);
  });

  it("keeps unsafe, missing, or unavailable M3U URLs as comments rather than executable references", async () => {
    const items = [
      { ...entry("one", "a", 0), title: "a\n#EXTM3U", url: "file:///private/local-file" },
      { ...entry("two", "b", 1), url: "https://example.test/\n#EXTINF:injected" },
      { ...entry("three", "c", 2), availability: "unavailable" as const },
      { ...entry("four", "d", 3), url: "not a URL" },
    ];
    const manifest = await runBackup(provider([playlist("m3u", "Title\n#injected")], items), root);
    const text = await fs.readFile(await resolveBackupFile(root, manifest.id, manifest.playlists[0]!.files!.m3u), "utf8");
    expect(text.match(/^#UNAVAILABLE:/gm)).toHaveLength(4);
    expect(text).toContain("#PLAYLIST:Title #injected");
    expect(text).not.toContain("\nfile:");
    expect(text).not.toContain("\nhttps:");
    expect(text).not.toContain("\n#injected");
  });

  it("uses Windows-safe, bounded filenames for hostile and Unicode titles", async () => {
    const titles = ["../CON:<bad>|?*\\title. ", "CON", "...", "日".repeat(400)];
    const manifest = await runBackup(provider(titles.map((title, index) => playlist(`p${index}`, title)), []), root);
    for (const result of manifest.playlists) {
      for (const filename of Object.values(result.files!)) {
        expect(filename).not.toMatch(/[<>:"/\\|?*\u0000-\u001f]/u);
        expect(Buffer.byteLength(filename)).toBeLessThanOrEqual(255);
        expect(path.basename(filename)).toBe(filename);
        expect(await fs.stat(await resolveBackupFile(root, manifest.id, filename))).toBeDefined();
      }
    }
  });

  it("accepts zero playlists and empty individual playlists", async () => {
    const empty = await runBackup(provider([]), root);
    expect(empty).toMatchObject({
      status: "complete", playlists: [], totals: { playlists: 0, completed: 0, failed: 0, entries: 0 },
    });
    const emptyPlaylist = await runBackup(provider([playlist("empty")], []), root);
    expect(emptyPlaylist).toMatchObject({
      status: "complete", totals: { playlists: 1, completed: 1, failed: 0, entries: 0 },
    });
    const archive = JSON.parse(await fs.readFile(await resolveBackupFile(
      root, emptyPlaylist.id, emptyPlaylist.playlists[0]!.files!.json,
    ), "utf8"));
    expect(archive.entries).toEqual([]);
  });

  it("never clobbers past exports, even when runs share an exact timestamp", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-09-13T00:00:00.000Z"));
      const first = await successfulBackup();
      const firstFile = await resolveBackupFile(root, first.id, first.playlists[0]!.files!.json);
      const original = await fs.readFile(firstFile);
      const second = await runBackup(provider([playlist("one")], []), root);
      expect(second.id).not.toBe(first.id);
      expect(second.startedAt).toBe(first.startedAt);
      expect(await fs.readFile(firstFile)).toEqual(original);
      expect(await readManifest(root, first.id)).toEqual(first);
      expect(await listBackups(root)).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("failures and recoverable checkpoints", () => {
  it.each([0, 2, 4])("rejects a declared count of %i with three fetched rows and continues later playlists", async expectedCount => {
    const fixture = provider([playlist("incomplete"), playlist("complete")]);
    const original = fixture.getPlaylist;
    fixture.getPlaylist = async item => {
      const contents = await original(item);
      if (item.id === "incomplete") {
        return { ...contents, playlist: { ...item, itemCount: expectedCount } };
      }
      return contents;
    };
    const manifest = await runBackup(fixture, root);
    expect(manifest).toMatchObject({
      status: "partial", totals: { playlists: 2, completed: 1, failed: 1, entries: 3 },
    });
    expect(manifest.playlists[0]).toMatchObject({
      status: "failed", entries: 0, files: null, fingerprint: null,
      error: expect.stringContaining(`expected ${expectedCount} entries but fetched 3`),
    });
    expect(manifest.playlists[1]!.status).toBe("complete");
    expect(await readManifest(root, manifest.id)).toEqual(manifest);
    expect(await fs.readdir(path.join(root, manifest.id))).toHaveLength(5);
  });

  it("uses a known inventory count when returned contents omit it", async () => {
    const fixture = provider([{ ...playlist("incomplete"), itemCount: 5 }]);
    const original = fixture.getPlaylist;
    fixture.getPlaylist = async item => ({
      ...await original(item),
      playlist: { ...item, itemCount: null },
    });
    const manifest = await runBackup(fixture, root);
    expect(manifest.status).toBe("failed");
    expect(manifest.playlists[0]!.error).toContain("expected 5 entries but fetched 3");
    expect((await fs.readdir(path.join(root, manifest.id))).sort()).toEqual([BACKUP_OWNER_FILENAME, "manifest.json"].sort());
  });

  it("allows unknown counts and counts unavailable placeholders as fetched entries", async () => {
    const fixture = provider([{ ...playlist("unknown"), itemCount: null }, playlist("known")]);
    const manifest = await runBackup(fixture, root);
    expect(manifest).toMatchObject({
      status: "complete", totals: { playlists: 2, completed: 2, failed: 0, entries: 6 },
    });
    expect(manifest.playlists.every(result => result.warnings.length > 0)).toBe(true);
  });

  it("continues after a playlist failure and records a partial run without inventing files", async () => {
    const fixture = provider([playlist("one"), playlist("fail"), playlist("three")]);
    const original = fixture.getPlaylist;
    fixture.getPlaylist = async item => {
      if (item.id === "fail") throw new Error("Playlist access denied");
      if (item.id === "three") {
        const [checkpoint] = await listBackups(root);
        expect(checkpoint!.playlists.map(result => result.status)).toEqual(["complete", "failed"]);
        expect(checkpoint!.totals).toEqual({ playlists: 3, completed: 1, failed: 1, entries: 3 });
      }
      return original(item);
    };
    const manifest = await runBackup(fixture, root);
    expect(manifest.status).toBe("partial");
    expect(manifest.playlists.map(result => result.status)).toEqual(["complete", "failed", "complete"]);
    expect(manifest.playlists[1]).toMatchObject({
      error: "Playlist access denied", files: null, fingerprint: null, entries: 0,
    });
    expect(await readManifest(root, manifest.id)).toEqual(manifest);
  });

  it("reports all failed playlists as a failed run", async () => {
    const fixture = provider();
    fixture.getPlaylist = async () => { throw new Error("Denied"); };
    const manifest = await runBackup(fixture, root);
    expect(manifest).toMatchObject({ status: "failed", totals: { failed: 1, completed: 0 } });
    expect(manifest.completedAt).not.toBeNull();
    expect(await listBackups(root)).toEqual([manifest]);
  });

  it("persists inventory failure instead of claiming a successful empty backup", async () => {
    const fixture = provider();
    fixture.listPlaylists = async () => {
      const [initial] = await listBackups(root);
      expect(initial!.status).toBe("running");
      throw new Error("Quota exceeded during discovery");
    };
    const manifest = await runBackup(fixture, root);
    expect(manifest).toMatchObject({
      status: "failed", playlists: [],
      error: "Playlist discovery failed: Quota exceeded during discovery",
      totals: { playlists: 0, completed: 0, failed: 0, entries: 0 },
    });
    expect(fixture.getPlaylist).not.toHaveBeenCalled();
    expect(await readManifest(root, manifest.id)).toEqual(manifest);
  });

  it("isolates progress callback failures and persists a warning", async () => {
    const manifest = await runBackup(provider(), root, () => { throw new Error("UI disconnected"); });
    expect(manifest.status).toBe("complete");
    expect(manifest.warnings).toHaveLength(1);
    expect(await readManifest(root, manifest.id)).toEqual(manifest);
  });

  it("publishes atomic complete files and never leaves temporary files", async () => {
    const originalRename = fs.rename;
    const originalLink = fs.link;
    let renames = 0;
    let links = 0;
    const inspect = async (source: Parameters<typeof fs.rename>[0], destination: Parameters<typeof fs.rename>[1]) => {
      const sourceName = String(source);
      const destinationName = String(destination);
      expect(path.basename(sourceName)).toMatch(/^\.write-[0-9a-f-]+\.tmp$/);
      expect(path.dirname(sourceName)).toBe(path.dirname(destinationName));
      const contents = await fs.readFile(sourceName, "utf8");
      expect(contents.length).toBeGreaterThan(0);
      if (destinationName.endsWith(".json")) expect(() => JSON.parse(contents)).not.toThrow();
    };
    vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
      await inspect(source, destination);
      expect(path.basename(String(destination))).toBe("manifest.json");
      await originalRename(source, destination);
      renames++;
    });
    vi.spyOn(fs, "link").mockImplementation(async (source, destination) => {
      await inspect(source, destination);
      expect(path.basename(String(destination))).not.toBe("manifest.json");
      await originalLink(source, destination);
      links++;
    });
    const manifest = await successfulBackup();
    expect(renames).toBeGreaterThanOrEqual(4);
    expect(links).toBe(5);
    expect(await fs.readdir(path.join(root, manifest.id))).not.toEqual(expect.arrayContaining([expect.stringMatching(/\.tmp$/)]));
  });

  it("fails loudly on disk writes, removes only its partial exports, and saves failure metadata", async () => {
    const originalLink = fs.link;
    vi.spyOn(fs, "link").mockImplementation(async (source, destination) => {
      if (String(destination).endsWith(".csv")) {
        throw Object.assign(new Error("Disk full"), { code: "ENOSPC" });
      }
      return originalLink(source, destination);
    });
    await expect(successfulBackup()).rejects.toMatchObject({ code: "BACKUP_STORAGE_ERROR", status: 500 });
    const [manifest] = await listBackups(root);
    expect(manifest).toMatchObject({
      status: "failed", totals: { playlists: 1, completed: 0, failed: 1, entries: 0 },
    });
    expect(manifest!.playlists[0]!.files).toBeNull();
    expect(manifest!.error).toContain("Disk full");
    expect((await fs.readdir(path.join(root, manifest!.id))).sort()).toEqual([BACKUP_OWNER_FILENAME, "manifest.json"].sort());
  });

  it("preserves the prior atomic checkpoint when completion and failure persistence both fail", async () => {
    const originalRename = fs.rename;
    let lastGoodManifest = "";
    vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
      if (String(destination).endsWith("manifest.json")) {
        const text = await fs.readFile(source, "utf8");
        if (JSON.parse(text).status !== "running") throw new Error("Cannot replace manifest");
        lastGoodManifest = text;
      }
      return originalRename(source, destination);
    });
    await expect(successfulBackup()).rejects.toMatchObject({
      code: "BACKUP_STORAGE_ERROR", message: expect.stringContaining("failure manifest also could not be saved"),
    });
    const [manifest] = await listBackups(root);
    expect(manifest!.status).toBe("running");
    expect(manifest!.playlists[0]!.status).toBe("complete");
    expect(await fs.readFile(path.join(root, manifest!.id, "manifest.json"), "utf8")).toBe(lastGoodManifest);
    expect((await fs.readdir(path.join(root, manifest!.id))).filter(file => file.endsWith(".tmp"))).toEqual([]);
  });

  it("persists startup interruption recovery without modifying complete runs or checkpointed exports", async () => {
    const manifest = await successfulBackup();
    const complete = await successfulBackup();
    const archivePath = await resolveBackupFile(root, manifest.id, manifest.playlists[0]!.files!.json);
    const archive = await fs.readFile(archivePath);
    const abandoned = { ...manifest, status: "running" as const, completedAt: null };
    await writeManifest(abandoned);
    expect(await readManifest(root, manifest.id)).toEqual(abandoned);
    const recovered = await recoverInterruptedBackups(root);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({
      status: "interrupted", completedAt: null, playlists: manifest.playlists,
    });
    expect(await readManifest(root, manifest.id)).toEqual(recovered[0]);
    expect(JSON.parse(await fs.readFile(path.join(root, manifest.id, "manifest.json"), "utf8"))).toEqual(recovered[0]);
    expect(await readManifest(root, complete.id)).toEqual(complete);
    expect(await fs.readFile(archivePath)).toEqual(archive);
    expect(await recoverInterruptedBackups(root)).toEqual([]);
  });

  it("refuses recovery of an active local run without marking any manifest interrupted", async () => {
    const fixture = provider();
    fixture.listPlaylists = async () => {
      const [active] = await listBackups(root);
      await expect(recoverInterruptedBackups(root)).rejects.toMatchObject({ code: "BACKUP_ACTIVE", status: 409 });
      expect(await readManifest(root, active!.id)).toEqual(active);
      return [];
    };
    const manifest = await runBackup(fixture, root);
    expect(manifest.status).toBe("complete");
    expect(await recoverInterruptedBackups(root)).toEqual([]);
  });

  it("does not conceal failed recovery writes and leaves the last good checkpoint readable", async () => {
    const manifest = await successfulBackup();
    const abandoned = { ...manifest, status: "running" as const, completedAt: null };
    await writeManifest(abandoned);
    vi.spyOn(fs, "rename").mockRejectedValueOnce(Object.assign(new Error("Read-only disk"), { code: "EACCES" }));
    await expect(recoverInterruptedBackups(root)).rejects.toMatchObject({ code: "BACKUP_STORAGE_ERROR" });
    expect(await readManifest(root, manifest.id)).toEqual(abandoned);
    expect((await fs.readdir(path.join(root, manifest.id))).filter(file => file.endsWith(".tmp"))).toEqual([]);
    expect((await recoverInterruptedBackups(root))[0]!.status).toBe("interrupted");
  });
});

describe("safe backup discovery and file resolution", () => {
  it.each(["hash", "negative-size", "fractional-size", "missing-format", "extra-field", "null"] as const)(
    "rejects invalid completed integrity metadata: %s",
    async corruption => {
      const manifest = await successfulBackup();
      const result = manifest.playlists[0]!;
      const integrity = structuredClone(result.integrity!) as unknown as Record<string, unknown>;
      if (corruption === "hash") integrity.json = { size: 1, sha256: "invalid" };
      if (corruption === "negative-size") integrity.json = { ...result.integrity!.json, size: -1 };
      if (corruption === "fractional-size") integrity.json = { ...result.integrity!.json, size: 0.5 };
      if (corruption === "missing-format") delete integrity.csv;
      if (corruption === "extra-field") integrity.other = result.integrity!.json;
      await fs.writeFile(path.join(root, manifest.id, "manifest.json"), JSON.stringify({
        ...manifest,
        playlists: [{ ...result, integrity: corruption === "null" ? null : integrity }],
      }));
      await expect(readManifest(root, manifest.id)).rejects.toMatchObject({ code: "INVALID_MANIFEST" });
    },
  );

  it("returns an empty collection for missing roots and ignores unrelated directories", async () => {
    expect(await listBackups(path.join(root, "not-created"))).toEqual([]);
    expect(await recoverInterruptedBackups(path.join(root, "not-created"))).toEqual([]);
    await fs.mkdir(path.join(root, "unrelated"));
    await fs.writeFile(path.join(root, "note.txt"), "not a backup");
    expect(await listBackups(root)).toEqual([]);
  });

  it("rejects malformed, inconsistent, or path-injected disk manifests", async () => {
    const original = await successfulBackup();
    const filename = path.join(root, original.id, "manifest.json");
    await fs.writeFile(filename, "{not-json");
    await expect(readManifest(root, original.id)).rejects.toMatchObject({ code: "INVALID_MANIFEST" });
    const corruptions = [
      { ...original, schemaVersion: 2 },
      { ...original, id: original.id.replace(/.$/, original.id.endsWith("a") ? "b" : "a") },
      { ...original, totals: { ...original.totals, completed: 50 } },
      { ...original, completedAt: null },
      { ...original, playlists: [{ ...original.playlists[0], files: { json: "../outside.json", csv: "a.csv", m3u: "a.m3u8" } }] },
      { ...original, playlists: [{ ...original.playlists[0], status: "failed" }] },
    ];
    for (const corrupted of corruptions) {
      await fs.writeFile(filename, JSON.stringify(corrupted));
      await expect(readManifest(root, original.id)).rejects.toMatchObject({ code: "INVALID_MANIFEST" });
      await expect(listBackups(root)).rejects.toMatchObject({ code: "INVALID_MANIFEST" });
    }
  });

  it("resolves only declared exports and the manifest, rejecting traversal and Windows aliases", async () => {
    const manifest = await successfulBackup();
    expect(await resolveBackupFile(root, manifest.id, "manifest.json")).toBe(path.join(root, manifest.id, "manifest.json"));
    for (const id of ["..", "../outside", "..\\outside", "C:\\outside", "%2e%2e"]) {
      await expect(readManifest(root, id)).rejects.toMatchObject({ code: "INVALID_BACKUP_ID", status: 400 });
    }
    for (const file of ["../manifest.json", "..\\manifest.json", "C:\\manifest.json", "manifest.json:secret", "CON", "x.", "x ", "."]) {
      await expect(resolveBackupFile(root, manifest.id, file)).rejects.toMatchObject({ code: "INVALID_BACKUP_FILE", status: 400 });
    }
    for (const file of [".active.json", "private.json", "%2e%2e%2fsecret.json"]) {
      await expect(resolveBackupFile(root, manifest.id, file)).rejects.toMatchObject({ code: "BACKUP_FILE_NOT_FOUND", status: 404 });
    }
    await fs.unlink(path.join(root, manifest.id, manifest.playlists[0]!.files!.csv));
    await expect(resolveBackupFile(root, manifest.id, manifest.playlists[0]!.files!.csv))
      .rejects.toMatchObject({ code: "BACKUP_NOT_FOUND", status: 404 });
  });

  it("rejects a linked run directory even when the target has valid archive contents", async () => {
    const manifest = await successfulBackup();
    const run = path.join(root, manifest.id);
    const outside = path.join(root, "outside");
    await fs.rename(run, outside);
    await fs.symlink(outside, run, process.platform === "win32" ? "junction" : "dir");
    await expect(readManifest(root, manifest.id)).rejects.toMatchObject({ code: "UNSAFE_BACKUP_PATH" });
    await expect(listBackups(root)).rejects.toMatchObject({ code: "UNSAFE_BACKUP_PATH" });
  });

  it("rejects linked archive files rather than serving their targets", async context => {
    const manifest = await successfulBackup();
    const file = manifest.playlists[0]!.files!.json;
    const archive = path.join(root, manifest.id, file);
    const outside = path.join(root, "private.json");
    await fs.rename(archive, outside);
    try {
      await fs.symlink(outside, archive, "file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        context.skip();
        return;
      }
      throw error;
    }
    await expect(resolveBackupFile(root, manifest.id, file)).rejects.toMatchObject({ code: "UNSAFE_BACKUP_PATH" });
  });
});
