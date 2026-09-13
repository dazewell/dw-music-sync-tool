import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackupManifest } from "../src/core/models.js";
import { atomicWrite, checkpointManifest, createBackupRun, readManifest } from "../src/core/storage.js";

vi.mock("node:fs/promises", async importOriginal => ({
  ...await importOriginal<typeof import("node:fs/promises")>(),
}));

let root: string;

beforeEach(async () => {
  root = path.resolve(`.test-replacement-filesystem-${randomUUID()}`);
  await fs.mkdir(root);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

// Every filesystem operation is real; the retry probe only observes failure and releases its reader.
describe("existing-destination replacement on the host filesystem", () => {
  it.each(["native", "atomic"] as const)("replaces an existing closed destination repeatedly via %s", async implementation => {
    const target = path.join(root, "metadata.json");
    const source = path.join(root, "replacement.json");
    const original = '{"generation":0}\n';
    await fs.writeFile(target, original);
    for (let generation = 1; generation <= 3; generation++) {
      const replacement = `${JSON.stringify({ generation })}\n`;
      if (implementation === "native") {
        await fs.writeFile(source, replacement);
        await fs.rename(source, target);
      } else {
        await atomicWrite(root, "metadata.json", replacement, undefined, true);
      }
      expect(await fs.readFile(target, "utf8")).toBe(replacement);
    }
    expect(await fs.readdir(root)).toEqual(["metadata.json"]);
  });

  it.skipIf(process.platform !== "win32").each([
    ["native", "r"], ["native", "r+"], ["atomic", "r"], ["atomic", "r+"],
  ] as const)("preserves the prior file when Windows blocks %s replacement with a held %s handle", async (implementation, mode) => {
    const target = path.join(root, "metadata.json");
    const source = path.join(root, "replacement.json");
    const original = '{"generation":0}\n';
    const replacement = '{"generation":1}\n';
    await fs.writeFile(target, original);
    let held: fs.FileHandle | undefined = await fs.open(target, mode);
    const publish = async () => {
      if (implementation === "native") {
        await fs.writeFile(source, replacement);
        await fs.rename(source, target);
      } else {
        await atomicWrite(root, "metadata.json", replacement, undefined, true);
      }
    };
    try {
      await expect(publish()).rejects.toMatchObject({
        code: implementation === "native" ? "EPERM" : "BACKUP_STORAGE_ERROR",
        message: expect.stringContaining("EPERM"),
      });
      expect(await fs.readFile(target, "utf8")).toBe(original);
      expect(await held.readFile("utf8")).toBe(original);
      expect((await fs.readdir(root)).filter(name => name.endsWith(".tmp"))).toEqual([]);
      await held.close();
      held = undefined;
      await publish();
      expect(await fs.readFile(target, "utf8")).toBe(replacement);
      expect(await fs.readdir(root)).toEqual(["metadata.json"]);
    } finally {
      await held?.close();
    }
  });

  it.skipIf(process.platform !== "win32").each(["r", "r+"] as const)(
    "retries after the first native failure releases the real %s reader",
    async mode => {
      const target = path.join(root, "metadata.json");
      await fs.writeFile(target, '{"generation":0}\n');
      let held: fs.FileHandle | undefined = await fs.open(target, mode);
      const rename = fs.rename;
      const failures: string[] = [];
      const spy = vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
        try {
          await rename(source, destination);
        } catch (error) {
          expect(error).toMatchObject({ code: "EPERM" });
          failures.push((error as NodeJS.ErrnoException).code!);
          await held?.close();
          held = undefined;
          throw error;
        }
      });
      const unlink = vi.spyOn(fs, "unlink");
      try {
        await atomicWrite(root, "metadata.json", '{"generation":1}\n', undefined, true);
        expect(failures).toEqual(["EPERM"]);
        expect(spy).toHaveBeenCalledTimes(2);
        expect(unlink).not.toHaveBeenCalled();
        expect(await fs.readFile(target, "utf8")).toBe('{"generation":1}\n');
        expect(await fs.readdir(root)).toEqual(["metadata.json"]);
      } finally {
        await held?.close();
      }
    },
  );

  it("saves multiple real manifest checkpoints when a concurrent reader releases the prior manifest", async () => {
    const run = await createBackupRun(root);
    let held: fs.FileHandle | undefined;
    let released: Promise<void> | undefined;
    try {
      const initial: BackupManifest = {
        schemaVersion: 1, id: run.id, provider: "youtube", startedAt: run.startedAt,
        completedAt: null, status: "running", coverage: "Synthetic replacement fixture",
        warnings: [], playlists: [], totals: { playlists: 0, completed: 0, failed: 0, entries: 0 }, error: null,
      };
      await checkpointManifest(run.directory, initial);
      held = await fs.open(path.join(run.directory, "manifest.json"), "r");
      expect(JSON.parse(await held.readFile("utf8"))).toEqual(initial);
      released = delay(60).then(() => held!.close());
      const second = { ...initial, warnings: ["Second synthetic checkpoint"] };
      await checkpointManifest(run.directory, second);
      expect(await readManifest(root, run.id)).toEqual(second);
      const completed: BackupManifest = {
        ...second, status: "complete", completedAt: new Date().toISOString(),
      };
      await checkpointManifest(run.directory, completed);
      expect(await readManifest(root, run.id)).toEqual(completed);
      expect((await fs.readdir(run.directory)).filter(name => name.endsWith(".tmp"))).toEqual([]);
    } finally {
      if (released) await released;
      else await held?.close();
      await run.release();
    }
  });
});
