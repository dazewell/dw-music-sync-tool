import { execFile } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { runBackup } from "../src/core/backup.js";
import { checkpointManifest } from "../src/core/storage.js";
import { DemoProvider } from "../src/providers/demo.js";
import { acquireRuntimeLocks } from "../src/runtime-lock.js";

const execute = promisify(execFile);
const directories: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

it("CLI recovers an interrupted expired run, prunes it and keeps stdout valid JSON", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "music-cli-test-"));
  directories.push(directory);
  const env = {
    ...process.env,
    MUSIC_DATA_DIR: path.join(directory, "state"),
    MUSIC_BACKUP_DIR: path.join(directory, "backups"),
    GOOGLE_CLIENT_SECRET_FILE: path.join(directory, "never-read-google.json"),
  };
  const config = loadConfig({ demo: true }, env);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() - 31 * 86_400_000);
  const old = await runBackup(new DemoProvider(), config.backupDirectory);
  await checkpointManifest(path.join(config.backupDirectory, old.id), {
    ...old,
    status: "running",
    completedAt: null,
  });
  vi.useRealTimers();
  const { stdout, stderr } = await execute(process.execPath, [
    "--import=tsx", path.resolve("src", "cli.ts"), "backup", "--demo",
  ], { env, timeout: 15_000 });
  const manifest = JSON.parse(stdout);
  expect(manifest.status).toBe("complete");
  expect(manifest.totals).toEqual({ playlists: 4, completed: 4, failed: 0, entries: 18 });
  expect(stderr).toContain("Removed 1 expired app-managed backup");
  await expect(access(path.join(config.backupDirectory, old.id))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(access(path.join(config.backupDirectory, "runtime.lock"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(access(path.join(config.dataDirectory, "runtime.lock"))).rejects.toMatchObject({ code: "ENOENT" });
}, 20_000);

it("locks shared output across distinct data directories and releases partial acquisitions", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "music-lock-test-"));
  directories.push(directory);
  const firstData = path.join(directory, "a-data");
  const secondData = path.join(directory, "b-data");
  const output = path.join(directory, "z-output");
  const release = await acquireRuntimeLocks([firstData, output, firstData]);
  try {
    await expect(acquireRuntimeLocks([secondData, output])).rejects.toThrow("Another process holds");
    await expect(access(path.join(secondData, "runtime.lock"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await release();
  }
  const releaseNext = await acquireRuntimeLocks([secondData, output]);
  await releaseNext();
});
