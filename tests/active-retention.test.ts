import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runBackup } from "../src/core/backup.js";
import type { PlaylistProvider } from "../src/core/models.js";
import { backupExpiresAt, pruneExpiredBackups } from "../src/core/retention.js";
import {
  activeBackupStartedAt, BACKUP_OWNER_FILENAME, createBackupRun, readManifest,
} from "../src/core/storage.js";
import { RetentionController } from "../src/services/retention.js";

vi.mock("node:fs/promises", async importOriginal => ({
  ...await importOriginal<typeof import("node:fs/promises")>(),
}));

let root: string;

beforeEach(async () => {
  root = path.resolve(`.test-active-retention-${randomUUID()}`);
  await fs.mkdir(root);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await fs.rm(root, { recursive: true, force: true });
});

function provider(): PlaylistProvider {
  return {
    id: "youtube",
    coverage: "Synthetic empty inventory",
    listPlaylists: async () => [],
    getPlaylist: async () => { throw new Error("No fixture playlists"); },
  };
}

describe("retention during active initialization", () => {
  it.each(["published-owner", "owner-only"] as const)(
    "does not cache a false warning at %s or block the next preflight",
    async boundary => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      const checks = vi.fn();
      const controller = new RetentionController(root, checks);
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const link = fs.link;
      const unlink = fs.unlink;
      let stage: string | undefined;
      let observed = 0;
      const inspectWindow = async (directory: string) => {
        const id = path.basename(directory);
        await expect(readManifest(root, id)).rejects.toMatchObject({ code: "BACKUP_NOT_FOUND" });
        observed++;
        await controller.check(true);
      };
      vi.spyOn(fs, "link").mockImplementation(async (source, destination) => {
        await link(source, destination);
        if (path.basename(String(destination)) === BACKUP_OWNER_FILENAME) {
          stage = String(source);
          if (boundary === "published-owner") await inspectWindow(path.dirname(stage));
        }
      });
      vi.spyOn(fs, "unlink").mockImplementation(async filename => {
        await unlink(filename);
        if (boundary === "owner-only" && String(filename) === stage) {
          await inspectWindow(path.dirname(String(filename)));
        }
      });
      try {
        expect((await runBackup(provider(), root)).status).toBe("complete");
        expect(observed).toBe(1);
        expect(controller.status().error).toBeNull();
        await controller.check();
        expect(checks).toHaveBeenCalledTimes(1);
        expect(controller.status().error).toBeNull();
        expect((await runBackup(provider(), root)).status).toBe("complete");
        expect(observed).toBe(2);
        expect(controller.status().error).toBeNull();
        expect(errors).not.toHaveBeenCalled();
      } finally {
        await controller.stop();
      }
    },
  );

  it("protects a live owner-only run but reports that same missing manifest after release", async () => {
    const run = await createBackupRun(root);
    const now = Date.parse(run.startedAt) + 1_000;
    try {
      expect(await pruneExpiredBackups(root, now)).toEqual({ deleted: [], warnings: [] });
      expect(await fs.readdir(run.directory)).toEqual([BACKUP_OWNER_FILENAME]);
    } finally {
      await run.release();
    }
    const result = await pruneExpiredBackups(root, now);
    expect(result.deleted).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain(run.id);
    expect(result.warnings[0]).toContain("does not exist");
    expect(await fs.readdir(run.directory)).toEqual([BACKUP_OWNER_FILENAME]);
  });

  it("still warns on expired active runs without requiring a first manifest", async () => {
    const run = await createBackupRun(root);
    try {
      const result = await pruneExpiredBackups(root, Date.parse(backupExpiresAt(run.startedAt)));
      expect(result.deleted).toEqual([]);
      expect(result.warnings.join(" ")).toContain("running");
      expect(result.warnings.join(" ")).not.toContain("does not exist");
      expect(await fs.readdir(run.directory)).toEqual([BACKUP_OWNER_FILENAME]);
    } finally {
      await run.release();
    }
  });

  it.each(["manifest", "owner"] as const)("continues reporting corrupt %s metadata after release", async kind => {
    const run = await createBackupRun(root);
    const filename = path.join(run.directory, kind === "manifest" ? "manifest.json" : BACKUP_OWNER_FILENAME);
    try {
      await fs.writeFile(filename, "{invalid");
    } finally {
      await run.release();
    }
    const result = await pruneExpiredBackups(root, Date.parse(run.startedAt) + 1_000);
    expect(result.deleted).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain(run.id);
    expect(await fs.readFile(filename, "utf8")).toBe("{invalid");
  });

  it("does not suppress another orphan just because a different run is active", async () => {
    const orphan = await createBackupRun(root);
    await orphan.release();
    const active = await createBackupRun(root);
    try {
      const result = await pruneExpiredBackups(root, Date.parse(active.startedAt) + 1_000);
      expect(result.deleted).toEqual([]);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain(orphan.id);
      expect(result.warnings[0]).not.toContain(active.id);
    } finally {
      await active.release();
    }
  });

  it("reserves before publishing a directory and releases the reservation if mkdir fails", async () => {
    const mkdir = fs.mkdir;
    let attempted: string | undefined;
    vi.spyOn(fs, "mkdir").mockImplementation(async (...args) => {
      const directory = String(args[0]);
      if (path.dirname(directory) === root) {
        attempted = directory;
        expect(activeBackupStartedAt(directory)).toBeDefined();
        throw new Error("Directory creation denied");
      }
      return (mkdir as (...values: unknown[]) => Promise<string | undefined>)(...args);
    });
    await expect(createBackupRun(root)).rejects.toMatchObject({ code: "BACKUP_STORAGE_ERROR" });
    expect(attempted).toBeDefined();
    expect(activeBackupStartedAt(attempted!)).toBeUndefined();
    expect(await fs.readdir(root)).toEqual([]);
  });
});
