import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { AppError } from "./core/errors.js";

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export async function acquireRuntimeLock(directory: string): Promise<() => Promise<void>> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const filename = path.join(directory, "runtime.lock");
  const nonce = randomUUID();
  const content = JSON.stringify({ pid: process.pid, nonce });
  let created = false;
  try {
    const handle = await open(filename, "wx", 0o600);
    created = true;
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (created) await unlink(filename);
    if (!hasCode(error, "EEXIST")) throw error;
    throw new AppError(
      "APP_ALREADY_RUNNING",
      `Another process holds ${filename}. Close the running app before starting another server or CLI backup. If it crashed, verify the recorded PID is no longer running before removing this lock file.`,
      409,
    );
  }
  return async () => {
    const actual = await readFile(filename, "utf8");
    if (actual !== content) throw new AppError("LOCK_CHANGED", "The runtime lock changed ownership; it was not removed.");
    await unlink(filename);
  };
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
