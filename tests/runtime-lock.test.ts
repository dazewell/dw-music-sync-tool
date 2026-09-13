import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireRuntimeLock } from "../src/runtime-lock.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, unlink: vi.fn(actual.unlink), rmdir: vi.fn(actual.rmdir), rename: vi.fn(actual.rename) };
});
const nativeFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

let directory: string;
let lock: string;

beforeEach(async () => {
  vi.resetAllMocks();
  directory = await fs.mkdtemp(path.join(tmpdir(), "music-runtime-lock-"));
  lock = path.join(directory, "runtime.lock");
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(directory, { recursive: true, force: true });
});

describe("runtime lock ownership", () => {
  it("publishes a complete lease, excludes contenders and releases once", async () => {
    const release = await acquireRuntimeLock(directory);
    const markers = await fs.readdir(lock);
    expect(markers).toHaveLength(1);
    const owner = JSON.parse(await fs.readFile(path.join(lock, markers[0]!), "utf8"));
    expect(owner.pid).toBe(process.pid);
    expect(markers[0]).toBe(`${owner.nonce}.json`);
    await expect(acquireRuntimeLock(directory)).rejects.toMatchObject({ code: "APP_ALREADY_RUNNING" });
    expect(await fs.readdir(directory)).toEqual(["runtime.lock"]);
    await Promise.all([release(), release(), release()]);
    const next = await acquireRuntimeLock(directory);
    await release();
    await expect(acquireRuntimeLock(directory)).rejects.toMatchObject({ code: "APP_ALREADY_RUNNING" });
    await next();
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it("preserves a successor that replaces the lock after the old marker was read", async () => {
    const release = await acquireRuntimeLock(directory);
    const originalUnlink = nativeFs.unlink;
    let next: (() => Promise<void>) | undefined;
    vi.mocked(fs.unlink).mockImplementationOnce(async (filename) => {
      await fs.rename(lock, path.join(directory, "old-lease"));
      next = await acquireRuntimeLock(directory);
      return originalUnlink(filename);
    });
    await expect(release()).rejects.toMatchObject({ code: "LOCK_CHANGED" });
    await expect(acquireRuntimeLock(directory)).rejects.toMatchObject({ code: "APP_ALREADY_RUNNING" });
    expect(await fs.readdir(lock)).toHaveLength(1);
    await next!();
  });

  it("never removes a successor published before a stale empty-directory removal", async () => {
    const release = await acquireRuntimeLock(directory);
    const originalRmdir = nativeFs.rmdir;
    let next: (() => Promise<void>) | undefined;
    vi.mocked(fs.rmdir).mockImplementationOnce(async (filename) => {
      await originalRmdir(filename);
      next = await acquireRuntimeLock(directory);
      await originalRmdir(filename);
    });
    await release();
    await expect(acquireRuntimeLock(directory)).rejects.toMatchObject({ code: "APP_ALREADY_RUNNING" });
    await next!();
  });

  it("chooses one winner when a prepared lease is delayed before publication", async () => {
    const originalRename = nativeFs.rename;
    let unblock!: () => void;
    const gate = new Promise<void>(resolve => { unblock = resolve; });
    let prepared!: () => void;
    const ready = new Promise<void>(resolve => { prepared = resolve; });
    vi.mocked(fs.rename).mockImplementationOnce(async (source, destination) => {
      expect(await fs.readdir(source)).toHaveLength(1);
      prepared();
      await gate;
      await originalRename(source, destination);
    });
    const delayed = acquireRuntimeLock(directory);
    await ready;
    const winner = await acquireRuntimeLock(directory);
    const rejected = expect(delayed).rejects.toMatchObject({ code: "APP_ALREADY_RUNNING" });
    unblock();
    await rejected;
    expect(await fs.readdir(directory)).toEqual(["runtime.lock"]);
    await winner();
  });

  it("preserves unexpected files instead of recursively deleting a lock", async () => {
    const release = await acquireRuntimeLock(directory);
    await fs.writeFile(path.join(lock, "notes.txt"), "user notes");
    await expect(release()).rejects.toMatchObject({ code: "LOCK_CHANGED" });
    expect(await fs.readFile(path.join(lock, "notes.txt"), "utf8")).toBe("user notes");
  });

  it("does not overwrite or remove a legacy lock file", async () => {
    const legacy = JSON.stringify({ pid: process.pid, nonce: "legacy" });
    await fs.writeFile(lock, legacy);
    await expect(acquireRuntimeLock(directory)).rejects.toMatchObject({ code: "APP_ALREADY_RUNNING" });
    expect(await fs.readFile(lock, "utf8")).toBe(legacy);
    expect(await fs.readdir(directory)).toEqual(["runtime.lock"]);
  });
});
