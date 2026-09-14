import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runBackup } from "../src/core/backup.js";
import type { BackupManifest, PlaylistProvider } from "../src/core/models.js";
import { pruneExpiredBackups } from "../src/core/retention.js";
import { readManifest, resolveBackupFile } from "../src/core/storage.js";

vi.mock("node:fs/promises", async importOriginal => ({
  ...await importOriginal<typeof import("node:fs/promises")>(),
}));

const expiry = Date.parse("2026-01-31T00:00:00.000Z");
let scratch: string;
let root: string;

beforeEach(async () => {
  scratch = path.resolve(`.test-export-identity-${randomUUID()}`);
  root = path.join(scratch, "backups");
  await fs.mkdir(root, { recursive: true });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await fs.rm(scratch, { recursive: true, force: true });
});

async function backup(): Promise<BackupManifest> {
  const playlist = {
    provider: "youtube" as const, id: "fixture", title: "Original generation", description: "",
    url: "https://example.test/playlist", owner: "fixture", itemCount: 0, visibility: "private" as const,
  };
  const provider: PlaylistProvider = {
    id: "youtube", coverage: "Synthetic file generation fixture",
    listPlaylists: async () => [playlist],
    getPlaylist: async item => ({ playlist: item, entries: [], warnings: [] }),
  };
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  try {
    return await runBackup(provider, root);
  } finally {
    vi.useRealTimers();
  }
}

function restartedRetention(directory = root): { deleted: string[]; warnings: string[] } {
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import { pathToFileURL } from "node:url";
    import * as path from "node:path";
    const { pruneExpiredBackups } = await import(pathToFileURL(path.resolve("src", "core", "retention.ts")).href);
    process.stdout.write(JSON.stringify(await pruneExpiredBackups(process.argv[1], Number(process.argv[2]))));
  `, directory, String(expiry)], { cwd: process.cwd(), encoding: "utf8", timeout: 15_000 });
  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr).toBe(0);
  return JSON.parse(child.stdout);
}

async function contents(directory: string): Promise<Record<string, Buffer>> {
  return Object.fromEntries(await Promise.all((await fs.readdir(directory)).map(async name => [
    name, await fs.readFile(path.join(directory, name)),
  ])));
}

describe("persisted original export generations", () => {
  it("expires the original files in a fresh process despite publication changing ctime/link counts", async () => {
    const manifest = await backup();
    const directory = path.join(root, manifest.id);
    for (const format of ["json", "csv", "m3u"] as const) {
      const proof = manifest.playlists[0]!.integrity![format];
      const info = await fs.stat(path.join(directory, manifest.playlists[0]!.files![format]), { bigint: true });
      expect(proof.identity).toEqual({
        dev: info.dev.toString(), ino: info.ino.toString(), birthtimeNs: info.birthtimeNs.toString(),
      });
      expect(Object.keys(proof.identity!).sort()).toEqual(["birthtimeNs", "dev", "ino"]);
      expect(info.nlink).toBe(1n);
    }
    expect(restartedRetention()).toEqual({ deleted: [manifest.id], warnings: [] });
    await expect(fs.stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["json", "csv", "m3u"] as const)(
    "preserves an identical-byte recreated %s file between processes",
    async format => {
      const manifest = await backup();
      const directory = path.join(root, manifest.id);
      const name = manifest.playlists[0]!.files![format];
      const filename = path.join(directory, name);
      const bytes = await fs.readFile(filename);
      const original = await fs.stat(filename);
      // Keep the old generation allocated so recreation deterministically receives another inode.
      await fs.link(filename, path.join(scratch, "original-outside-run"));
      await fs.unlink(filename);
      await fs.writeFile(filename, bytes);
      await fs.utimes(filename, original.atime, original.mtime);
      const recreated = await fs.stat(filename, { bigint: true });
      expect(recreated.nlink).toBe(1n);
      expect(recreated.ino.toString()).not.toBe(manifest.playlists[0]!.integrity![format].identity!.ino);
      const before = await contents(directory);
      expect(await readManifest(root, manifest.id)).toEqual(manifest);
      await expect(resolveBackupFile(root, manifest.id, name)).rejects.toMatchObject({
        code: "BACKUP_RECOVERY_ERROR", message: expect.stringContaining("original file identity"),
      });
      const result = restartedRetention();
      expect(result.deleted).toEqual([]);
      expect(result.warnings.join(" ")).toContain("original file identity");
      expect(await contents(directory)).toEqual(before);
      expect(await fs.readFile(path.join(scratch, "original-outside-run"))).toEqual(bytes);
    },
  );

  it("does not adopt a copied archive's new files as the recorded originals", async () => {
    const manifest = await backup();
    const copiedRoot = path.join(scratch, "copied-backups");
    const copied = path.join(copiedRoot, manifest.id);
    await fs.cp(path.join(root, manifest.id), copied, { recursive: true });
    const before = await contents(copied);
    expect(await readManifest(copiedRoot, manifest.id)).toEqual(manifest);
    const result = restartedRetention(copiedRoot);
    expect(result.deleted).toEqual([]);
    expect(result.warnings.join(" ")).toContain("original file identity");
    expect(await contents(copied)).toEqual(before);
    expect(await readManifest(root, manifest.id)).toEqual(manifest);
  });

  it("keeps hash-only legacy exports readable, without backfilling generation evidence", async () => {
    const manifest = await backup();
    const directory = path.join(root, manifest.id);
    for (const proof of Object.values(manifest.playlists[0]!.integrity!)) delete proof.identity;
    await fs.writeFile(path.join(directory, "manifest.json"), JSON.stringify(manifest));
    const before = await contents(directory);
    expect(await readManifest(root, manifest.id)).toEqual(manifest);
    expect(await resolveBackupFile(root, manifest.id, manifest.playlists[0]!.files!.json))
      .toBe(path.join(directory, manifest.playlists[0]!.files!.json));
    const result = restartedRetention();
    expect(result.deleted).toEqual([]);
    expect(result.warnings.join(" ")).toContain("no original file identity evidence");
    expect(await contents(directory)).toEqual(before);
  });

  it.each(["dev", "ino", "birthtimeNs"] as const)("binds the persisted %s component", async component => {
    const manifest = await backup();
    const directory = path.join(root, manifest.id);
    const identity = manifest.playlists[0]!.integrity!.m3u.identity!;
    identity[component] = (BigInt(identity[component]) + 1n).toString();
    await fs.writeFile(path.join(directory, "manifest.json"), JSON.stringify(manifest));
    const before = await contents(directory);
    const result = restartedRetention();
    expect(result.deleted).toEqual([]);
    expect(result.warnings.join(" ")).toContain("original file identity");
    expect(await contents(directory)).toEqual(before);
  });

  it("retries an interrupted expiry in a fresh process without requiring already-deleted files", async () => {
    const manifest = await backup();
    const unlink = fs.unlink;
    vi.spyOn(fs, "unlink").mockImplementation(async filename => {
      if (String(filename).endsWith(".csv")) throw new Error("Synthetic file lock");
      await unlink(filename);
    });
    const result = await pruneExpiredBackups(root, expiry);
    expect(result.warnings.join(" ")).toContain("safe retry");
    await expect(fs.stat(path.join(root, manifest.id, manifest.playlists[0]!.files!.json)))
      .rejects.toMatchObject({ code: "ENOENT" });
    vi.restoreAllMocks();
    expect(restartedRetention()).toEqual({ deleted: [manifest.id], warnings: [] });
  });
});
