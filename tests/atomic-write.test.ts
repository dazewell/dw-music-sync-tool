import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  atomicWrite, BACKUP_OWNER_FILENAME, createBackupRun, recoverInterruptedBackups,
} from "../src/core/storage.js";
import { replaceFile } from "../src/core/replace-file.js";

vi.mock("node:fs/promises", async importOriginal => ({
  ...await importOriginal<typeof import("node:fs/promises")>(),
}));

let root: string;

beforeEach(async () => {
  root = path.resolve(`.test-atomic-write-${randomUUID()}`);
  await fs.mkdir(root);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

describe("atomic no-replace publication", () => {
  it("flushes a stage, atomically links it, then removes only the staging name", async () => {
    const open = fs.open;
    let flushed = false;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      const sync = handle.sync.bind(handle);
      vi.spyOn(handle, "sync").mockImplementation(async () => {
        await sync();
        flushed = true;
      });
      return handle;
    });
    const link = fs.link;
    const unlink = fs.unlink;
    const destination = path.join(root, "export.json");
    vi.spyOn(fs, "link").mockImplementation(async (source, target) => {
      expect(flushed).toBe(true);
      expect(await fs.readFile(source, "utf8")).toBe('{"original":true}');
      await link(source, target);
      const stage = await fs.stat(source);
      const published = await fs.stat(target);
      expect(stage.ino).toBe(published.ino);
      expect(stage.dev).toBe(published.dev);
      expect(stage.nlink).toBe(2);
    });
    vi.spyOn(fs, "unlink").mockImplementation(async filename => {
      expect(filename).not.toBe(destination);
      expect((await fs.stat(filename)).nlink).toBe(2);
      await unlink(filename);
    });
    const rename = vi.spyOn(fs, "rename");
    await atomicWrite(root, "export.json", '{"original":true}');
    expect(rename).not.toHaveBeenCalled();
    expect(await fs.readdir(root)).toEqual(["export.json"]);
    expect((await fs.stat(destination)).nlink).toBe(1);
  });

  it.each([false, true])("never clobbers a destination appearing at the publication syscall (journaled: %s)", async journaled => {
    const destination = path.join(root, "output.csv");
    const stage = journaled ? `.write-${randomUUID()}.tmp` : undefined;
    const link = fs.link;
    vi.spyOn(fs, "link").mockImplementation(async (source, target) => {
      await fs.writeFile(target, "User data");
      await link(source, target);
    });
    const rename = vi.spyOn(fs, "rename");
    const unlink = vi.spyOn(fs, "unlink");
    await expect(atomicWrite(root, "output.csv", "App data", stage)).rejects.toMatchObject({ code: "BACKUP_STORAGE_ERROR" });
    expect(await fs.readFile(destination, "utf8")).toBe("User data");
    expect(rename).not.toHaveBeenCalled();
    expect(unlink).not.toHaveBeenCalledWith(destination);
    if (stage) {
      expect(await fs.readFile(path.join(root, stage), "utf8")).toBe("App data");
      expect((await fs.stat(path.join(root, stage), { bigint: true })).ino)
        .not.toBe((await fs.stat(destination, { bigint: true })).ino);
    } else {
      expect(await fs.readdir(root)).toEqual(["output.csv"]);
    }
  });

  it("preserves an already existing destination without requiring a supplied stage name", async () => {
    await fs.writeFile(path.join(root, "output.csv"), "User data");
    await expect(atomicWrite(root, "output.csv", "App data")).rejects.toMatchObject({ code: "BACKUP_STORAGE_ERROR" });
    expect(await fs.readFile(path.join(root, "output.csv"), "utf8")).toBe("User data");
    expect(await fs.readdir(root)).toEqual(["output.csv"]);
  });

  it("uses rename only for explicitly authorized replacement", async () => {
    await fs.writeFile(path.join(root, "manifest.json"), "Old checkpoint");
    const link = vi.spyOn(fs, "link");
    const rename = vi.spyOn(fs, "rename");
    await atomicWrite(root, "manifest.json", "New checkpoint", undefined, true);
    expect(link).not.toHaveBeenCalled();
    expect(rename).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(path.join(root, "manifest.json"), "utf8")).toBe("New checkpoint");
    expect(await fs.readdir(root)).toEqual(["manifest.json"]);
  });

  it.skipIf(process.platform !== "win32").each(
    ["EPERM", "EACCES", "EBUSY"].flatMap(code => [false, true].map(persistent => ({ code, persistent }))),
  )(
    "bounds $code retries without unlinking the destination (persistent: $persistent)",
    async ({ code, persistent }) => {
      const target = path.join(root, "manifest.json");
      await fs.writeFile(target, "Old checkpoint");
      const rename = fs.rename;
      let attempts = 0;
      const spy = vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
        attempts++;
        if (persistent || attempts < 3) {
          throw Object.assign(new Error("Synthetic sharing conflict"), { code });
        }
        await rename(source, destination);
      });
      const unlink = vi.spyOn(fs, "unlink");
      const write = atomicWrite(root, "manifest.json", "New checkpoint", undefined, true);
      if (persistent) {
        await expect(write).rejects.toMatchObject({ code: "BACKUP_STORAGE_ERROR" });
        expect(attempts).toBe(4);
        expect(await fs.readFile(target, "utf8")).toBe("Old checkpoint");
      } else {
        await write;
        expect(attempts).toBe(3);
        expect(await fs.readFile(target, "utf8")).toBe("New checkpoint");
      }
      expect(new Set(spy.mock.calls.map(([source]) => String(source))).size).toBe(1);
      expect(unlink).not.toHaveBeenCalledWith(target);
      expect(await fs.readdir(root)).toEqual(["manifest.json"]);
    },
  );

  it.skipIf(process.platform !== "win32")("propagates a permanent permissions error and leaves both helper paths intact", async () => {
    const source = path.join(root, "pending.json");
    const target = path.join(root, "manifest.json");
    await fs.writeFile(source, "New checkpoint");
    await fs.writeFile(target, "Old checkpoint");
    const failure = Object.assign(new Error("Permission denied"), { code: "EACCES" });
    const rename = vi.spyOn(fs, "rename").mockRejectedValue(failure);
    const beforeAttempt = vi.fn(async () => {});
    const unlink = vi.spyOn(fs, "unlink");
    await expect(replaceFile(source, target, beforeAttempt)).rejects.toBe(failure);
    expect(beforeAttempt).toHaveBeenCalledTimes(4);
    expect(rename).toHaveBeenCalledTimes(4);
    expect(unlink).not.toHaveBeenCalled();
    expect(await fs.readFile(source, "utf8")).toBe("New checkpoint");
    expect(await fs.readFile(target, "utf8")).toBe("Old checkpoint");
  });

  it.skipIf(process.platform !== "win32")("revalidates caller-owned state before each sharing-conflict retry", async () => {
    const source = path.join(root, "pending.json");
    const target = path.join(root, "manifest.json");
    await fs.writeFile(source, "New checkpoint");
    await fs.writeFile(target, "Old checkpoint");
    const rename = vi.spyOn(fs, "rename")
      .mockRejectedValue(Object.assign(new Error("Sharing conflict"), { code: "EPERM" }));
    const beforeAttempt = vi.fn(async () => {
      if (beforeAttempt.mock.calls.length === 2) throw new Error("Ownership changed");
    });
    const unlink = vi.spyOn(fs, "unlink");
    await expect(replaceFile(source, target, beforeAttempt)).rejects.toThrow("Ownership changed");
    expect(beforeAttempt).toHaveBeenCalledTimes(2);
    expect(rename).toHaveBeenCalledTimes(1);
    expect(unlink).not.toHaveBeenCalled();
    expect(await fs.readFile(source, "utf8")).toBe("New checkpoint");
    expect(await fs.readFile(target, "utf8")).toBe("Old checkpoint");
  });

  it.skipIf(process.platform !== "win32").each(["destination", "stage"] as const)(
    "stops retrying when the %s is replaced, preserving the user's replacement",
    async changed => {
      const target = path.join(root, "manifest.json");
      await fs.writeFile(target, "Old checkpoint");
      const rename = fs.rename;
      let stage: string | undefined;
      let replacement: Buffer | undefined;
      const spy = vi.spyOn(fs, "rename").mockImplementationOnce(async source => {
        stage = String(source);
        const changedPath = changed === "destination" ? target : stage;
        const size = (await fs.stat(changedPath)).size;
        replacement = Buffer.alloc(size, "u");
        await rename(changedPath, path.join(root, "original-kept"));
        await fs.writeFile(changedPath, replacement);
        throw Object.assign(new Error("Sharing conflict"), { code: "EPERM" });
      });
      const unlink = vi.spyOn(fs, "unlink");
      await expect(atomicWrite(root, "manifest.json", "New checkpoint", undefined, true))
        .rejects.toThrow(`replacement ${changed === "stage" ? "staging file" : "destination"} changed`);
      expect(spy).toHaveBeenCalledTimes(1);
      const changedPath = changed === "destination" ? target : stage!;
      expect(unlink).not.toHaveBeenCalledWith(changedPath);
      expect(await fs.readFile(changedPath)).toEqual(replacement);
      if (changed === "stage") expect(await fs.readFile(target, "utf8")).toBe("Old checkpoint");
    },
  );

  it("does not retry unrelated replacement filesystem errors or unlink the destination", async () => {
    const target = path.join(root, "manifest.json");
    await fs.writeFile(target, "Old checkpoint");
    const rename = vi.spyOn(fs, "rename")
      .mockRejectedValue(Object.assign(new Error("Read-only filesystem"), { code: "EROFS" }));
    const unlink = vi.spyOn(fs, "unlink");
    await expect(atomicWrite(root, "manifest.json", "New checkpoint", undefined, true))
      .rejects.toMatchObject({ code: "BACKUP_STORAGE_ERROR" });
    expect(rename).toHaveBeenCalledTimes(1);
    expect(unlink).not.toHaveBeenCalledWith(target);
    expect(await fs.readFile(target, "utf8")).toBe("Old checkpoint");
    expect(await fs.readdir(root)).toEqual(["manifest.json"]);
  });

  it.each(["ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV"])("fails closed on %s instead of falling back to rename", async code => {
    vi.spyOn(fs, "link").mockRejectedValueOnce(Object.assign(new Error("Unsupported link"), { code }));
    const rename = vi.spyOn(fs, "rename");
    await expect(atomicWrite(root, "output.csv", "App data")).rejects.toMatchObject({
      code: "BACKUP_STORAGE_ERROR", message: expect.stringContaining("hard-link support"),
    });
    expect(rename).not.toHaveBeenCalled();
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("reports staging unlink failure after publication rather than returning silent success", async () => {
    const stage = `.write-${randomUUID()}.tmp`;
    const unlink = vi.spyOn(fs, "unlink").mockRejectedValueOnce(new Error("Staging locked"));
    await expect(atomicWrite(root, "output.csv", "App data", stage)).rejects.toMatchObject({
      code: "BACKUP_STORAGE_ERROR", message: expect.stringContaining("Staging locked"),
    });
    expect(unlink).toHaveBeenCalledTimes(1);
    const before = await fs.stat(path.join(root, stage));
    const after = await fs.stat(path.join(root, "output.csv"));
    expect(before.ino).toBe(after.ino);
    expect(before.nlink).toBe(2);
    expect(after.nlink).toBe(2);
    expect(await fs.readFile(path.join(root, "output.csv"), "utf8")).toBe("App data");
  });

  it("reports both publication and cleanup failures without hiding the original cause", async () => {
    vi.spyOn(fs, "link").mockRejectedValueOnce(new Error("Publication denied"));
    vi.spyOn(fs, "unlink").mockRejectedValueOnce(new Error("Stage cleanup denied"));
    await expect(atomicWrite(root, "output.csv", "App data")).rejects.toMatchObject({
      code: "BACKUP_STORAGE_ERROR",
      message: expect.stringMatching(/Publication denied.*Stage cleanup denied/),
    });
    expect(await fs.readdir(root)).toHaveLength(1);
    await expect(fs.stat(path.join(root, "output.csv"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never removes a preexisting stage that this write did not create", async () => {
    const stage = `.write-${randomUUID()}.tmp`;
    await fs.writeFile(path.join(root, stage), "User stage");
    const unlink = vi.spyOn(fs, "unlink");
    const link = vi.spyOn(fs, "link");
    await expect(atomicWrite(root, "output.csv", "App data", stage)).rejects.toMatchObject({ code: "BACKUP_STORAGE_ERROR" });
    expect(unlink).not.toHaveBeenCalled();
    expect(link).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(root, stage), "utf8")).toBe("User stage");
  });
});

describe("failed run ownership initialization", () => {
  it("removes only the empty new directory after ownership publication fails", async () => {
    vi.spyOn(fs, "link").mockRejectedValueOnce(new Error("Ownership denied"));
    const rmdir = vi.spyOn(fs, "rmdir");
    const recursive = vi.spyOn(fs, "rm");
    await expect(createBackupRun(root)).rejects.toMatchObject({
      code: "BACKUP_STORAGE_ERROR", message: expect.stringContaining("Ownership denied"),
    });
    expect(rmdir).toHaveBeenCalledTimes(1);
    expect(recursive).not.toHaveBeenCalled();
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("preserves a user addition, reports both failures, and releases the active-run guard", async () => {
    vi.spyOn(fs, "link").mockImplementationOnce(async (_source, destination) => {
      await fs.writeFile(path.join(path.dirname(String(destination)), "notes.txt"), "User notes");
      throw new Error("Ownership denied");
    });
    await expect(createBackupRun(root)).rejects.toMatchObject({
      code: "BACKUP_STORAGE_ERROR",
      message: expect.stringMatching(/Ownership denied.*Empty-directory cleanup also failed/),
    });
    const [id] = await fs.readdir(root);
    expect(await fs.readdir(path.join(root, id!))).toEqual(["notes.txt"]);
    expect(await fs.readFile(path.join(root, id!, "notes.txt"), "utf8")).toBe("User notes");
    await expect(recoverInterruptedBackups(root)).rejects.toMatchObject({ code: "BACKUP_RECOVERY_ERROR" });
  });

  it("retains an empty directory when rmdir fails and does not retain its in-memory guard", async () => {
    vi.spyOn(fs, "link").mockRejectedValueOnce(new Error("Ownership denied"));
    vi.spyOn(fs, "rmdir").mockRejectedValueOnce(new Error("Directory locked"));
    await expect(createBackupRun(root)).rejects.toMatchObject({
      message: expect.stringMatching(/Ownership denied.*Directory locked/),
    });
    const [id] = await fs.readdir(root);
    expect(await fs.readdir(path.join(root, id!))).toEqual([]);
    expect(await recoverInterruptedBackups(root)).toEqual([]);
  });

  it("preserves an ownership marker and unknown linked stage when staging cleanup fails", async () => {
    vi.spyOn(fs, "unlink").mockRejectedValueOnce(new Error("Staging locked"));
    await expect(createBackupRun(root)).rejects.toMatchObject({
      message: expect.stringMatching(/Staging locked.*Empty-directory cleanup also failed/),
    });
    const [id] = await fs.readdir(root);
    const directory = path.join(root, id!);
    expect(await fs.readdir(directory)).toHaveLength(2);
    expect((await fs.stat(path.join(directory, BACKUP_OWNER_FILENAME))).nlink).toBe(2);
    await expect(recoverInterruptedBackups(root)).rejects.toMatchObject({ code: "BACKUP_RECOVERY_ERROR" });
  });
});
