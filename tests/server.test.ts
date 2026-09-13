import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/server/app.js";
import { DemoProvider } from "../src/providers/demo.js";
import { acquireRuntimeLock } from "../src/runtime-lock.js";
import type { BackupManifest } from "../src/core/models.js";
import { runBackup } from "../src/core/backup.js";

const directories: string[] = [];
const stopControllers: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(stopControllers.splice(0).map((stop) => stop()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function setup(demo = true, backupRunner?: Parameters<typeof createApp>[0]["backupRunner"]) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "music-server-test-"));
  directories.push(directory);
  const config = loadConfig({ demo }, {
    MUSIC_DATA_DIR: path.join(directory, "data"),
    MUSIC_BACKUP_DIR: path.join(directory, "backups"),
  });
  const auth = {
    status: vi.fn(async () => ({ configured: true, connected: true })),
    begin: vi.fn(async () => ({ url: "https://accounts.google.com/example", state: "test-state", codeVerifier: "test-verifier" })),
    complete: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
  };
  const { app, stopRetention } = createApp({ config, auth, provider: new DemoProvider(), ...(backupRunner ? { backupRunner } : {}) });
  stopControllers.push(stopRetention);
  const browser = request.agent(app);
  const host = new URL(config.baseUrl).host;
  const status = await browser.get("/api/status").set("Host", host).expect(200);
  const csrf = status.body.csrfToken as string;
  return { app, browser, config, auth, host, csrf, directory };
}

describe("loopback server", () => {
  it("rejects rebinding hosts, foreign origins, missing session and missing CSRF", async () => {
    const { app, browser, host } = await setup();
    await request(app).get("/api/status").set("Host", "evil.example:8787").expect(403);
    await browser.get("/api/status").set("Host", host).set("Origin", "https://evil.example").expect(403);
    await request(app).get("/api/playlists").set("Host", host).expect(401);
    await browser.post("/api/backups").set("Host", host).expect(403);
  });

  it("binds OAuth callbacks to the originating browser and consumes state once", async () => {
    const { app, browser, host, csrf, auth } = await setup(false);
    await browser.post("/api/auth/connect").set("Host", host).set("X-CSRF-Token", csrf).expect(200);
    const stranger = request.agent(app);
    await stranger.get("/api/status").set("Host", host);
    await stranger.get("/auth/google/callback?state=test-state&code=code").set("Host", host).expect(302);
    expect(auth.complete).not.toHaveBeenCalled();
    await browser.get("/auth/google/callback?state=test-state&code=code").set("Host", host).expect(302);
    expect(auth.complete).toHaveBeenCalledExactlyOnceWith("code", "test-verifier");
    await browser.get("/auth/google/callback?state=test-state&code=code").set("Host", host).expect(302);
    expect(auth.complete).toHaveBeenCalledTimes(1);
  });

  it("rejects duplicate backup jobs and conflicting disconnects", async () => {
    let finish!: (manifest: BackupManifest) => void;
    const runner = vi.fn(() => new Promise<BackupManifest>((resolve) => { finish = resolve; }));
    const { browser, host, csrf, auth } = await setup(false, runner);
    const responses = await Promise.all([
      browser.post("/api/backups").set("Host", host).set("X-CSRF-Token", csrf),
      browser.post("/api/backups").set("Host", host).set("X-CSRF-Token", csrf),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([202, 409]);
    expect(runner).toHaveBeenCalledTimes(1);
    await browser.post("/api/auth/disconnect").set("Host", host).set("X-CSRF-Token", csrf).expect(409);
    expect(auth.disconnect).not.toHaveBeenCalled();
    finish({
      schemaVersion: 1, id: "test", provider: "youtube", startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(), status: "complete", coverage: "test", warnings: [],
      playlists: [], totals: { playlists: 0, completed: 0, failed: 0, entries: 0 }, error: null,
    });
    await vi.waitFor(async () => {
      const result = await browser.get("/api/jobs/current").set("Host", host);
      expect(result.body.job.state).toBe("finished");
    });
  });

  it("exports and downloads synthetic metadata end-to-end without Google", async () => {
    const { browser, host, csrf, auth, config } = await setup();
    const inventory = await browser.get("/api/playlists").set("Host", host).expect(200);
    expect(inventory.body.playlists).toHaveLength(4);
    const start = await browser.post("/api/backups").set("Host", host).set("X-CSRF-Token", csrf).expect(202);
    let manifest!: BackupManifest;
    await vi.waitFor(async () => {
      const result = await browser.get(`/api/jobs/${start.body.job.id}`).set("Host", host).expect(200);
      expect(result.body.job.state).toBe("finished");
      manifest = result.body.job.manifest as BackupManifest;
    }, { timeout: 5000 });
    expect(manifest.status).toBe("complete");
    expect(manifest.totals).toEqual({ playlists: 4, completed: 4, failed: 0, entries: 18 });
    const first = manifest.playlists[0]!;
    expect(first.files).not.toBeNull();
    const filename = first.files!.json;
    const download = await browser.get(`/api/backups/${manifest.id}/files/${encodeURIComponent(filename)}`).set("Host", host).expect(200);
    const archive = JSON.parse(await readFile(path.join(config.backupDirectory, manifest.id, filename), "utf8"));
    expect(archive.entries).toHaveLength(6);
    expect(download.headers["content-disposition"]).toContain("attachment");
    const history = await browser.get("/api/backups").set("Host", host).expect(200);
    expect(history.body.backups[0].id).toBe(manifest.id);
    await browser.get(`/api/backups/${manifest.id}/files/google-tokens.json`).set("Host", host).expect(404);
    expect(auth.status).not.toHaveBeenCalled();
    expect(auth.begin).not.toHaveBeenCalled();
  });

  it("makes total job errors observable instead of leaving progress running", async () => {
    const { browser, host, csrf } = await setup(true, async () => { throw new Error("Disk is full"); });
    const start = await browser.post("/api/backups").set("Host", host).set("X-CSRF-Token", csrf).expect(202);
    await vi.waitFor(async () => {
      const result = await browser.get(`/api/jobs/${start.body.job.id}`).set("Host", host);
      expect(result.body.job.state).toBe("failed");
      expect(result.body.job.error).toBe("Disk is full");
    });
  });

  it("sets restrictive browser headers and a HttpOnly same-site cookie", async () => {
    const { app, host } = await setup();
    const response = await request(app).get("/api/status").set("Host", host).expect(200);
    expect(response.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["set-cookie"][0]).toMatch(/HttpOnly/);
    expect(response.headers["set-cookie"][0]).toMatch(/SameSite=Lax/);
  });

  it("removes expired managed exports before starting a fresh backup", async () => {
    const { browser, host, csrf, config } = await setup();
    const now = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now - 31 * 86_400_000);
    const old = await runBackup(new DemoProvider(), config.backupDirectory);
    vi.useRealTimers();
    const start = await browser.post("/api/backups").set("Host", host).set("X-CSRF-Token", csrf).expect(202);
    await vi.waitFor(async () => {
      const result = await browser.get(`/api/jobs/${start.body.job.id}`).set("Host", host);
      expect(result.body.job.state).toBe("finished");
    });
    await expect(access(path.join(config.backupDirectory, old.id))).rejects.toMatchObject({ code: "ENOENT" });
    const status = await browser.get("/api/status").set("Host", host).expect(200);
    expect(status.body.retention).toMatchObject({ days: 30, automatic: true, error: null });
    const history = await browser.get("/api/backups").set("Host", host).expect(200);
    expect(history.body.backups).toHaveLength(1);
    expect(history.body.backups[0].id).not.toBe(old.id);
  });

  it("protects unexpected user files, reports failed cleanup and refuses expired downloads", async () => {
    const { browser, host, csrf, config } = await setup();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() - 31 * 86_400_000);
    const old = await runBackup(new DemoProvider(), config.backupDirectory);
    vi.useRealTimers();
    const note = path.join(config.backupDirectory, old.id, "my-notes.txt");
    await writeFile(note, "User content must never be deleted by retention.");
    await browser.post("/api/backups").set("Host", host).set("X-CSRF-Token", csrf).expect(503);
    expect(await readFile(note, "utf8")).toContain("never be deleted");
    const status = await browser.get("/api/status").set("Host", host).expect(200);
    expect(status.body.retention.error).toBeTruthy();
    const filename = old.playlists[0]!.files!.json;
    await browser.get(`/api/backups/${old.id}/files/${encodeURIComponent(filename)}`).set("Host", host).expect(410);
    const history = await browser.get("/api/backups").set("Host", host).expect(200);
    expect(history.body.backups).toEqual([]);
    await rm(note);
    await browser.post("/api/retention/check").set("Host", host).set("X-CSRF-Token", csrf).expect(200);
    const recovered = await browser.get("/api/status").set("Host", host).expect(200);
    expect(recovered.body.retention.error).toBeNull();
    await expect(access(path.join(config.backupDirectory, old.id))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("configuration and process lock", () => {
  it("validates ports and isolates demo storage", () => {
    expect(() => loadConfig({ port: "nope" }, {})).toThrow("between 1024 and 65535");
    expect(() => loadConfig({ port: "8787.0" }, {})).toThrow("between 1024 and 65535");
    expect(loadConfig({ demo: true }, {}).backupDirectory).toMatch(/[\\/]demo$/);
    expect(loadConfig({}, {}).baseUrl).toBe("http://127.0.0.1:8787");
  });

  it("prevents simultaneous app instances and releases only its own lock", async () => {
    const { directory } = await setup();
    const release = await acquireRuntimeLock(directory);
    await expect(acquireRuntimeLock(directory)).rejects.toThrow("Another process holds");
    await release();
    const releaseAgain = await acquireRuntimeLock(directory);
    await releaseAgain();
  });
});
