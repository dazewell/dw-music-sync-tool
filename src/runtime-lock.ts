import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rename, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import { AppError } from "./core/errors.js";

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export async function acquireRuntimeLock(directory: string): Promise<() => Promise<void>> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  directory = await realpath(directory);
  const filename = path.join(directory, "runtime.lock");
  const nonce = randomUUID();
  const markerName = `${nonce}.json`;
  const staging = path.join(directory, `.runtime-lock-${nonce}`);
  const content = JSON.stringify({ pid: process.pid, nonce });
  let created = false;
  let markerCreated = false;
  try {
    await mkdir(staging, { mode: 0o700 });
    created = true;
    const handle = await open(path.join(staging, markerName), "wx", 0o600);
    markerCreated = true;
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    // Publish a nonempty directory atomically; rename cannot replace another held lease.
    // Windows can replace a legacy regular file with a directory, so reject it explicitly.
    try {
      await lstat(filename);
      throw Object.assign(new Error("An application lock already exists."), { code: "EEXIST" });
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
    }
    await rename(staging, filename);
  } catch (error) {
    if (markerCreated) await unlink(path.join(staging, markerName));
    if (created) await rmdir(staging);
    if (["EEXIST", "ENOTEMPTY", "ENOTDIR", "EISDIR", "EPERM"].some(code => hasCode(error, code))) {
      try {
        await lstat(filename);
      } catch (inspectionError) {
        if (hasCode(inspectionError, "ENOENT")) throw error;
        throw inspectionError;
      }
      throw new AppError(
        "APP_ALREADY_RUNNING",
        `Another process holds ${filename}. Close the running app before starting another server or CLI backup. If it crashed, verify the PID in its marker is no longer running before removing that marker and the empty lock directory. Legacy lock files also require this PID check.`,
        409,
      );
    }
    throw error;
  }
  let releasing: Promise<void> | undefined;
  const release = async () => {
    const marker = path.join(filename, markerName);
    let identity: Stats;
    try {
      identity = await lstat(filename);
      if (!identity.isDirectory() || identity.isSymbolicLink() || await readFile(marker, "utf8") !== content) {
        throw new AppError("LOCK_CHANGED", "The runtime lock changed ownership; it was not removed.");
      }
      // A stale releaser can only unlink its unique marker, never a successor's.
      await unlink(marker);
    } catch (error) {
      if (hasCode(error, "ENOENT") || hasCode(error, "ENOTDIR")) {
        throw new AppError("LOCK_CHANGED", "The runtime lock changed ownership; it was not removed.");
      }
      throw error;
    }
    try {
      await rmdir(filename);
    } catch (error) {
      if (hasCode(error, "ENOENT")) return;
      if (hasCode(error, "ENOTEMPTY") || hasCode(error, "EEXIST")) {
        const current = await lstat(filename);
        if (current.dev !== identity.dev || current.ino !== identity.ino) return;
        throw new AppError("LOCK_CHANGED", "Unexpected files remain in the runtime lock directory; they were preserved.");
      }
      throw error;
    }
  };
  return () => releasing ??= release();
}

export async function acquireRuntimeLocks(directories: string[]): Promise<() => Promise<void>> {
  const resolved: string[] = [];
  for (const directory of directories) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    resolved.push(await realpath(directory));
  }
  const releases: (() => Promise<void>)[] = [];
  const releaseAll = async () => {
    const failures: string[] = [];
    for (const release of releases.splice(0).reverse()) {
      try { await release(); }
      catch (error) { failures.push(error instanceof Error ? error.message : "Could not release an application lock."); }
    }
    if (failures.length > 0) throw new AppError("LOCK_RELEASE_FAILED", failures.join("\n"));
  };
  try {
    for (const directory of [...new Set(resolved)].sort()) {
      releases.push(await acquireRuntimeLock(directory));
    }
    return releaseAll;
  } catch (error) {
    try { await releaseAll(); }
    catch (releaseError) {
      throw new AppError("LOCK_RELEASE_FAILED", `${error instanceof Error ? error.message : "Could not acquire application locks."}\n${releaseError instanceof Error ? releaseError.message : "Could not release application locks."}`);
    }
    throw error;
  }
}
