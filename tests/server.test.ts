import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { createApp, type SyncIntegration, type SyncRemovalRecord } from "../src/server/app.js";
import { SyncStateStore } from "../src/core/sync-state.js";
import type { SyncPair, SyncRemovalAudit } from "../src/core/sync.js";
import { DemoProvider } from "../src/providers/demo.js";
import { acquireRuntimeLock } from "../src/runtime-lock.js";
import type { BackupManifest } from "../src/core/models.js";
import { runBackup } from "../src/core/backup.js";
import { RetentionController } from "../src/services/retention.js";
import { AppError } from "../src/core/errors.js";

const directories: string[] = [];
const stopControllers: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(stopControllers.splice(0).map((stop) => stop()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function completedManifest(): BackupManifest {
  return {
    schemaVersion: 1, id: "test", provider: "youtube", startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(), status: "complete", coverage: "test", warnings: [],
    playlists: [], totals: { playlists: 0, completed: 0, failed: 0, entries: 0 }, error: null,
  };
}

async function setup(demo = true, backupRunner?: Parameters<typeof createApp>[0]["backupRunner"], sync?: SyncIntegration) {
  const directory = await mkdtemp(path.join(process.cwd(), "music-server-test-"));
  directories.push(directory);
  const config = loadConfig({ demo }, {
    MUSIC_DATA_DIR: path.join(directory, "data"),
    MUSIC_BACKUP_DIR: path.join(directory, "backups"),
  });
  const auth = {
    status: vi.fn(async () => ({ configured: true, connected: true })),
    begin: vi.fn(async () => ({ url: "https://accounts.google.com/example", state: "test-state", codeVerifier: "test-verifier" })),
    beginWrite: vi.fn(async () => ({ url: "https://accounts.google.com/write-example", state: "test-write-state", codeVerifier: "test-write-verifier" })),
    complete: vi.fn(async () => {}),
    completeWrite: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
  };
  const provider = new DemoProvider();
  const { app, stopRetention, isBusy } = createApp({ config, auth, provider, ...(backupRunner ? { backupRunner } : {}), ...(sync ? { sync } : {}) });
  stopControllers.push(stopRetention);
  const browser = request.agent(app);
  const host = new URL(config.baseUrl).host;
  const status = await browser.get("/api/status").set("Host", host).expect(200);
  const csrf = status.body.csrfToken as string;
  return { app, browser, config, auth, host, csrf, directory, provider, isBusy };
}

/** Backs the API with the durable core sync state store instead of a parallel model. */
async function syncFixture() {
  const directory = await mkdtemp(path.join(process.cwd(), "music-sync-test-"));
  directories.push(directory);
  const store = new SyncStateStore(path.join(directory, "sync-state.json"));
  const now = new Date().toISOString();
  const pair: SyncPair = {
    id: "pair-1",
    left: { provider: "youtube", accountId: "account-1", playlistId: "yt-1" },
    right: { provider: "spotify", accountId: "account-1", playlistId: "sp-1" },
    enabled: true, createdAt: now, updatedAt: now,
  };
  await store.pair(pair);
  const run = await store.startRun("pair-1");
  const audits: SyncRemovalAudit[] = [
    {
      pairId: "pair-1", platform: "spotify", playlistId: "sp-1", itemIdentity: "media:spotify-track-abc",
      direction: "left-to-right", timestamp: "2026-09-12T18:00:00.000Z", outcome: "success", error: null,
    },
    {
      pairId: "pair-2", platform: "youtube", playlistId: "yt-2", itemIdentity: "isrc:USTEST0000001",
      direction: "right-to-left", timestamp: "2026-09-12T18:30:00.000Z", outcome: "failed",
      error: "YouTube Music rejected the removal.",
    },
  ];
  await store.recordRemovalAudits(run.id, audits);
  await store.finishRun(run.id, "partial", "One mirrored removal failed.");
  const integration: SyncIntegration = {
    state: () => store.read(),
    pair: (pairing) => store.pair(pairing),
    unpair: (id) => store.update((state) => {
      const index = state.pairs.findIndex((item) => item.id === id);
      if (index < 0) throw new AppError("SYNC_PAIR_NOT_FOUND", "That playlist pair does not exist.", 404);
      state.pairs.splice(index, 1);
    }),
    ignore: (ignore) => store.ignore(ignore),
    unignore: (ref) => store.update((state) => {
      const index = state.ignores.findIndex((item) => item.provider === ref.provider
        && item.accountId === ref.accountId && item.playlistId === ref.playlistId);
      if (index < 0) throw new AppError("SYNC_IGNORE_NOT_FOUND", "That playlist is not ignored.", 404);
      state.ignores.splice(index, 1);
    }),
    run: async (pairId) => {
      const started = await store.startRun(pairId);
      await store.finishRun(started.id, "complete", "Mirrored verified changes.");
      return { ...started, status: "complete", completedAt: new Date().toISOString(), message: "Mirrored verified changes." };
    },
  };
  return { integration, store, runId: run.id };
}

describe("loopback server", () => {
  it("exposes CSRF-protected pair, ignore, run and manual sync controls through the durable sync state", async () => {
    const fixture = await syncFixture();
    const { browser, host, csrf } = await setup(true, undefined, fixture.integration);
    const initial = await browser.get("/api/sync").set("Host", host).expect(200);
    expect(initial.body.pairs).toHaveLength(1);
    expect(initial.body).not.toHaveProperty("baselines");
    const created = await browser.post("/api/sync/pairs").set("Host", host).set("X-CSRF-Token", csrf).send({
      left: { provider: "youtube", accountId: "account-1", playlistId: "yt-9" },
      right: { provider: "spotify", accountId: "account-1", playlistId: "sp-9" },
    }).expect(201);
    expect(created.body.pairs).toHaveLength(2);
    const addedId = created.body.pairs[1].id as string;
    await browser.post("/api/sync/ignored").set("Host", host).set("X-CSRF-Token", csrf).send({
      provider: "youtube", accountId: "account-1", playlistId: "yt-ignored", reason: "Review later",
    }).expect(201);
    const run = await browser.post("/api/sync/run").set("Host", host).set("X-CSRF-Token", csrf)
      .send({ pairId: "pair-1" }).expect(200);
    expect(run.body.run.status).toBe("complete");
    const removed = await browser.delete(`/api/sync/pairs/${addedId}`).set("Host", host).set("X-CSRF-Token", csrf).expect(200);
    expect(removed.body.pairs).toHaveLength(1);
    const restored = await browser.delete("/api/sync/ignored/youtube/account-1/yt-ignored")
      .set("Host", host).set("X-CSRF-Token", csrf).expect(200);
    expect(restored.body.ignores).toHaveLength(0);
    expect((await fixture.store.read()).runs).toHaveLength(2);
    await browser.post("/api/sync/run").set("Host", host).send({ pairId: "pair-1" }).expect(403);
  });

  it("refuses to mirror without an explicit pair and rejects same-platform pairs", async () => {
    const fixture = await syncFixture();
    const started = vi.spyOn(fixture.integration, "run");
    const { browser, host, csrf } = await setup(true, undefined, fixture.integration);
    for (const body of [{}, { pairId: "" }, { pairId: 7 }]) {
      const rejected = await browser.post("/api/sync/run").set("Host", host).set("X-CSRF-Token", csrf).send(body).expect(400);
      expect(rejected.body.error.code).toBe("INVALID_SYNC_RUN");
    }
    expect(started).not.toHaveBeenCalled();
    const invalid = await browser.post("/api/sync/pairs").set("Host", host).set("X-CSRF-Token", csrf).send({
      left: { provider: "spotify", accountId: "account-1", playlistId: "sp-1" },
      right: { provider: "spotify", accountId: "account-1", playlistId: "sp-2" },
    }).expect(400);
    expect(invalid.body.error.code).toBe("INVALID_SYNC_PAIR");
    expect((await fixture.store.read()).pairs).toHaveLength(1);
  });

  it("fails closed with an explicit unavailable response when no sync service is configured", async () => {
    const { browser, host, csrf } = await setup();
    await browser.get("/api/sync").set("Host", host).expect(501);
    await browser.post("/api/sync/run").set("Host", host).set("X-CSRF-Token", csrf).send({ pairId: "pair-1" }).expect(501);
    const audit = await browser.get("/api/sync/removals").set("Host", host).expect(501);
    expect(audit.body.error.code).toBe("SYNC_UNAVAILABLE");
  });

  it("exposes durable removal audit records with platform, identity, direction and outcome", async () => {
    const fixture = await syncFixture();
    const { browser, host } = await setup(true, undefined, fixture.integration);
    const all = await browser.get("/api/sync/removals").set("Host", host).expect(200);
    expect(all.body.removals).toHaveLength(2);
    expect(all.body.removals[0]).toMatchObject({
      runId: fixture.runId, runStatus: "partial", pairId: "pair-2", platform: "youtube", playlistId: "yt-2",
      itemIdentity: "isrc:USTEST0000001", direction: "right-to-left", sourcePlatform: null,
      timestamp: "2026-09-12T18:30:00.000Z", outcome: "failed", error: "YouTube Music rejected the removal.",
    });
    expect(all.body.removals[1]).toMatchObject({
      pairId: "pair-1", platform: "spotify", itemIdentity: "media:spotify-track-abc",
      direction: "left-to-right", sourcePlatform: "youtube", outcome: "success", error: null,
    });
    const state = await browser.get("/api/sync").set("Host", host).expect(200);
    expect(state.body.removals).toHaveLength(2);
    expect(state.body.runs[0].message).toBe("One mirrored removal failed.");
    const scoped = await browser.get("/api/sync/removals?pairId=pair-2").set("Host", host).expect(200);
    expect(scoped.body.removals.map((record: SyncRemovalRecord) => record.itemIdentity)).toEqual(["isrc:USTEST0000001"]);
    const limited = await browser.get("/api/sync/removals?limit=1").set("Host", host).expect(200);
    expect(limited.body.removals).toHaveLength(1);
    expect(limited.body.removals[0].pairId).toBe("pair-2");
    const byPlatform = await browser.get("/api/sync/removals?platform=youtube").set("Host", host).expect(200);
    expect(byPlatform.body.removals.map((record: SyncRemovalRecord) => record.pairId)).toEqual(["pair-2"]);
    const byPlaylist = await browser.get("/api/sync/removals?playlistId=sp-1").set("Host", host).expect(200);
    expect(byPlaylist.body.removals.map((record: SyncRemovalRecord) => record.pairId)).toEqual(["pair-1"]);
    const byIdentity = await browser.get("/api/sync/removals?itemIdentity=ISRC%3AUSTEST").set("Host", host).expect(200);
    expect(byIdentity.body.removals.map((record: SyncRemovalRecord) => record.pairId)).toEqual(["pair-2"]);
    const byDirection = await browser.get("/api/sync/removals?direction=left-to-right").set("Host", host).expect(200);
    expect(byDirection.body.removals.map((record: SyncRemovalRecord) => record.pairId)).toEqual(["pair-1"]);
    const byOutcome = await browser.get("/api/sync/removals?outcome=failed").set("Host", host).expect(200);
    expect(byOutcome.body.removals.map((record: SyncRemovalRecord) => record.pairId)).toEqual(["pair-2"]);
    const combined = await browser.get("/api/sync/removals?platform=spotify&outcome=success").set("Host", host).expect(200);
    expect(combined.body.removals).toHaveLength(1);
    const none = await browser.get("/api/sync/removals?platform=spotify&outcome=failed").set("Host", host).expect(200);
    expect(none.body.removals).toHaveLength(0);
  });

  it.each(["limit=0", "limit=-1", "limit=abc", "limit=1001", "pairId=", "pairId=a&pairId=b",
    "platform=bogus", "playlistId=", "itemIdentity=", "itemIdentity=%20", "direction=bogus", "outcome=bogus"])(
    "rejects the malformed removal audit query %s without reading records",
    async (query) => {
      const fixture = await syncFixture();
      const read = vi.spyOn(fixture.integration, "state");
      const { browser, host } = await setup(true, undefined, fixture.integration);
      const rejected = await browser.get(`/api/sync/removals?${query}`).set("Host", host).expect(400);
      expect(rejected.body.error.code).toBe("INVALID_SYNC_QUERY");
      expect(read).not.toHaveBeenCalled();
    },
  );

  it("normalizes whitespace-padded pair references before persisting them", async () => {
    const fixture = await syncFixture();
    const { browser, host, csrf } = await setup(true, undefined, fixture.integration);
    const created = await browser.post("/api/sync/pairs").set("Host", host).set("X-CSRF-Token", csrf).send({
      left: { provider: "youtube", accountId: "  account-1  ", playlistId: "  yt-9  " },
      right: { provider: "spotify", accountId: "account-1", playlistId: "sp-9" },
    }).expect(201);
    const stored = created.body.pairs[1];
    expect(stored.left.accountId).toBe("account-1");
    expect(stored.left.playlistId).toBe("yt-9");
    const persisted = (await fixture.store.read()).pairs[1];
    expect(persisted.left.accountId).toBe("account-1");
    expect(persisted.left.playlistId).toBe("yt-9");
  });

  it.each([
    ["GOOGLE_TOKEN_INVALID", true, 401, "The local Google token file is malformed. Reconnect Google."],
    ["GOOGLE_CONFIG_INVALID", false, 400, "Replace the invalid OAuth client file with a Desktop app JSON."],
  ] as const)("returns usable disconnected status for %s and recovers without replacing the session", async (code, configured, httpStatus, detail) => {
    const runner = vi.fn(async () => completedManifest());
    const { app, host, auth, provider, isBusy } = await setup(false, runner);
    auth.status.mockRejectedValue(new AppError(code, detail, httpStatus));
    const inventory = vi.spyOn(provider, "listPlaylists");
    const browser = request.agent(app);
    const unavailable = await browser.get("/api/status").set("Host", host).expect(200);
    expect(unavailable.body).toMatchObject({
      configured, connected: false, connectionError: { code, message: detail },
      csrfToken: expect.any(String), retention: { automatic: true }, coverage: provider.coverage,
    });
    expect(unavailable.headers["set-cookie"][0]).toContain("HttpOnly");
    const csrf = unavailable.body.csrfToken as string;
    expect(csrf).not.toBe("");
    await browser.get("/api/playlists").set("Host", host).expect(httpStatus);
    await browser.post("/api/backups").set("Host", host).set("X-CSRF-Token", csrf).expect(httpStatus);
    expect(inventory).not.toHaveBeenCalled();
    expect(runner).not.toHaveBeenCalled();
    expect(isBusy()).toBe(false);
    if (configured) {
      await browser.post("/api/auth/connect").set("Host", host).set("X-CSRF-Token", csrf).expect(200);
      expect(auth.begin).toHaveBeenCalledTimes(1);
    } else {
      auth.status.mockResolvedValue({ configured: true, connected: false });
      const repaired = await browser.get("/api/status").set("Host", host).expect(200);
      expect(repaired.body).toMatchObject({ configured: true, connected: false, connectionError: null, csrfToken: csrf });
      expect(inventory).not.toHaveBeenCalled();
      await browser.post("/api/auth/connect").set("Host", host).set("X-CSRF-Token", csrf).expect(200);
    }
    auth.complete.mockImplementationOnce(async () => {
      auth.status.mockResolvedValue({ configured: true, connected: true });
    });
    await browser.get("/auth/google/callback?state=test-state&code=code").set("Host", host)
      .expect(302).expect("Location", "/?connected=1");
    const recovered = await browser.get("/api/status").set("Host", host).expect(200);
    expect(recovered.body).toMatchObject({ configured: true, connected: true, connectionError: null, csrfToken: csrf });
    await browser.get("/api/playlists").set("Host", host).expect(200);
    expect(auth.complete).toHaveBeenCalledExactlyOnceWith("code", "test-verifier");
  });

  it("reports missing setup without an error and rechecks a repaired configuration", async () => {
    const { browser, host, csrf, auth } = await setup(false);
    auth.status.mockResolvedValue({ configured: false, connected: false });
    const missing = await browser.get("/api/status").set("Host", host).expect(200);
    expect(missing.body).toMatchObject({ configured: false, connected: false, connectionError: null, csrfToken: csrf });
    auth.status.mockResolvedValue({ configured: true, connected: false });
    const repaired = await browser.get("/api/status").set("Host", host).expect(200);
    expect(repaired.body).toMatchObject({ configured: true, connected: false, connectionError: null, csrfToken: csrf });
    await browser.post("/api/auth/connect").set("Host", host).set("X-CSRF-Token", csrf).expect(200);
  });

  it.each([
    ["GOOGLE_TOKEN_READ_FAILED", new AppError("GOOGLE_TOKEN_READ_FAILED", "Check local token file permissions.", 500)],
    ["GOOGLE_PENDING_CLEANUP_FAILED", new AppError("GOOGLE_PENDING_CLEANUP_FAILED", "Inspect unsafe pending credential files before retrying.", 500)],
    ["INTERNAL_ERROR", new Error("Synthetic unexpected status failure")],
  ] as const)("does not turn %s into a successful status response", async (code, failure) => {
    const { browser, host, auth } = await setup(false);
    auth.status.mockRejectedValueOnce(failure);
    const failed = await browser.get("/api/status").set("Host", host).expect(500);
    expect(failed.body.error.code).toBe(code);
    expect(failed.body).not.toHaveProperty("connected");
    expect(failed.body).not.toHaveProperty("csrfToken");
    const recovered = await browser.get("/api/status").set("Host", host).expect(200);
    expect(recovered.body).toMatchObject({ connected: true, connectionError: null });
  });

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
    const foreign = await stranger.get("/auth/google/callback?state=test-state&code=code").set("Host", host).expect(302);
    expect(foreign.headers.location).toContain("authError=");
    expect(auth.complete).not.toHaveBeenCalled();
    await browser.get("/auth/google/callback?state=test-state&code=code").set("Host", host).expect(302).expect("Location", "/?connected=1");
    expect(auth.complete).toHaveBeenCalledExactlyOnceWith("code", "test-verifier");
    await browser.get("/auth/google/callback?state=test-state&code=code").set("Host", host).expect(302);
    expect(auth.complete).toHaveBeenCalledTimes(1);
  });

  it("exposes a separate YouTube write authorization callback without replacing read credentials", async () => {
    const { browser, host, csrf, auth } = await setup(false);
    const started = await browser.post("/api/auth/connect-write").set("Host", host).set("X-CSRF-Token", csrf).expect(200);
    expect(started.body.url).toBe("https://accounts.google.com/write-example");
    expect(auth.beginWrite).toHaveBeenCalledTimes(1);
    const mismatch = await browser.get("/auth/google/callback?state=wrong-state&code=code").set("Host", host).expect(302);
    expect(mismatch.headers.location).toContain("authError=");
    expect(auth.completeWrite).not.toHaveBeenCalled();
    await browser.get("/auth/google/callback?state=test-write-state&code=code").set("Host", host)
      .expect(302).expect("Location", "/?writeConnected=1");
    expect(auth.completeWrite).toHaveBeenCalledExactlyOnceWith("code", "test-write-verifier");
    expect(auth.complete).not.toHaveBeenCalled();
  });

  it("rejects YouTube write authorization in demo mode", async () => {
    const { browser, host, csrf, auth } = await setup(true);
    const rejected = await browser.post("/api/auth/connect-write").set("Host", host).set("X-CSRF-Token", csrf).expect(400);
    expect(rejected.body.error.code).toBe("DEMO_MODE");
    expect(auth.beginWrite).not.toHaveBeenCalled();
  });

  it.each([
    "state=wrong-state&code=code",
    "code=code",
    "state=test-state&state=wrong-state&code=code",
    "state=test-state",
    "state=test-state&code=",
    "state=test-state&code=one&code=two",
    "state=test-state&code=code&error=access_denied",
    "state=test-state&error=one&error=two",
  ])("preserves pending OAuth state after a malformed or mismatched callback: %s", async (query) => {
    const { browser, host, csrf, auth } = await setup(false);
    await browser.post("/api/auth/connect").set("Host", host).set("X-CSRF-Token", csrf).expect(200);
    const invalid = await browser.get(`/auth/google/callback?${query}`).set("Host", host).expect(302);
    expect(invalid.headers.location).toContain("authError=");
    expect(auth.complete).not.toHaveBeenCalled();
    await browser.get("/auth/google/callback?state=test-state&code=code").set("Host", host)
      .expect(302).expect("Location", "/?connected=1");
    expect(auth.complete).toHaveBeenCalledExactlyOnceWith("code", "test-verifier");
    const replay = await browser.get("/auth/google/callback?state=test-state&code=code").set("Host", host).expect(302);
    expect(replay.headers.location).toContain("authError=");
    expect(auth.complete).toHaveBeenCalledTimes(1);
  });

  it("consumes a matching denied OAuth response without exchanging credentials", async () => {
    const { browser, host, csrf, auth, isBusy } = await setup(false);
    await browser.post("/api/auth/connect").set("Host", host).set("X-CSRF-Token", csrf).expect(200);
    const denied = await browser.get("/auth/google/callback?state=test-state&error=access_denied").set("Host", host).expect(302);
    expect(decodeURIComponent(denied.headers.location)).toContain("authorization was not granted");
    const replay = await browser.get("/auth/google/callback?state=test-state&code=code").set("Host", host).expect(302);
    expect(replay.headers.location).toContain("authError=");
    expect(auth.complete).not.toHaveBeenCalled();
    expect(isBusy()).toBe(false);
  });

  it("expires and consumes matching OAuth state at the ten-minute deadline", async () => {
    const { browser, host, csrf, auth } = await setup(false);
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = Date.now();
    await browser.post("/api/auth/connect").set("Host", host).set("X-CSRF-Token", csrf).expect(200);
    vi.setSystemTime(now + 600_000);
    const expired = await browser.get("/auth/google/callback?state=test-state&code=code").set("Host", host).expect(302);
    expect(expired.headers.location).toContain("authError=");
    vi.setSystemTime(now);
    const replay = await browser.get("/auth/google/callback?state=test-state&code=code").set("Host", host).expect(302);
    expect(replay.headers.location).toContain("authError=");
    expect(auth.complete).not.toHaveBeenCalled();
  });

  it("reserves backup preflight across retention and authorization awaits without changing credentials", async () => {
    const cleanupEntered = deferred();
    const cleanup = deferred();
    const statusEntered = deferred();
    const connection = deferred<{ configured: boolean; connected: boolean }>();
    const finish = deferred<BackupManifest>();
    const runner = vi.fn(() => finish.promise);
    const { browser, host, csrf, auth, provider, isBusy } = await setup(false, runner);
    await browser.post("/api/auth/connect").set("Host", host).set("X-CSRF-Token", csrf).expect(200);
    const inventory = vi.spyOn(provider, "listPlaylists");
    vi.spyOn(RetentionController.prototype, "check").mockImplementationOnce(() => {
      cleanupEntered.resolve();
      return cleanup.promise;
    });
    auth.status.mockImplementationOnce(() => {
      statusEntered.resolve();
      return connection.promise;
    });
    const starting = browser.post("/api/backups").set("Host", host).set("X-CSRF-Token", csrf).then((response) => response);
    try {
      await cleanupEntered.promise;
      expect(isBusy()).toBe(true);
      for (const url of ["/api/auth/disconnect", "/api/auth/connect", "/api/backups"]) {
        const conflict = await browser.post(url).set("Host", host).set("X-CSRF-Token", csrf).expect(409);
        expect(conflict.body.error.code).toBe("BACKUP_RUNNING");
      }
      await browser.get("/api/playlists").set("Host", host).expect(409);
      const callback = await browser.get("/auth/google/callback?state=test-state&code=code").set("Host", host).expect(302);
      expect(decodeURIComponent(callback.headers.location)).toContain("authError=A backup is already running. Wait");
      expect(auth.status).toHaveBeenCalledTimes(1);
      expect(runner).not.toHaveBeenCalled();
      cleanup.resolve();
      await statusEntered.promise;
      await browser.post("/api/auth/disconnect").set("Host", host).set("X-CSRF-Token", csrf).expect(409);
      expect(auth.disconnect).not.toHaveBeenCalled();
      expect(auth.complete).not.toHaveBeenCalled();
      expect(auth.begin).toHaveBeenCalledTimes(1);
      expect(inventory).not.toHaveBeenCalled();
      expect(runner).not.toHaveBeenCalled();
    } finally {
      cleanup.resolve();
      connection.resolve({ configured: true, connected: true });
      expect((await starting).status).toBe(202);
      finish.resolve(completedManifest());
    }
    await browser.get("/auth/google/callback?state=test-state&code=code").set("Host", host)
      .expect(302).expect("Location", "/?connected=1");
    expect(auth.complete).toHaveBeenCalledExactlyOnceWith("code", "test-verifier");
    expect(runner).toHaveBeenCalledTimes(1);
    expect(isBusy()).toBe(false);
  });

  it.each(["begin", "disconnect", "complete"] as const)("rejects backup and inventory while auth.%s is pending", async (operation) => {
    const entered = deferred();
    const pending = deferred();
    const runner = vi.fn(async () => completedManifest());
    const { browser, host, csrf, auth, provider, isBusy } = await setup(false, runner);
    if (operation === "complete") {
      await browser.post("/api/auth/connect").set("Host", host).set("X-CSRF-Token", csrf).expect(200);
    }
    const inventory = vi.spyOn(provider, "listPlaylists");
    let credentials = "original";
    const wait = async () => {
      entered.resolve();
      await pending.promise;
      credentials = "changed";
    };
    if (operation === "begin") {
      auth.begin.mockImplementationOnce(async () => {
        await wait();
        return { url: "https://accounts.google.com/example", state: "test-state", codeVerifier: "test-verifier" };
      });
    } else {
      auth[operation].mockImplementationOnce(wait);
    }
    const changing = (operation === "complete"
      ? browser.get("/auth/google/callback?state=test-state&code=code").set("Host", host)
      : browser.post(`/api/auth/${operation === "begin" ? "connect" : "disconnect"}`).set("Host", host).set("X-CSRF-Token", csrf))
      .then((response) => response);
    try {
      await entered.promise;
      expect(isBusy()).toBe(true);
      for (const url of ["/api/backups", "/api/auth/disconnect", "/api/auth/connect"]) {
        const conflict = await browser.post(url).set("Host", host).set("X-CSRF-Token", csrf).expect(409);
        expect(conflict.body.error.code).toBe("AUTH_BUSY");
        expect(conflict.body.error.message).toContain("Wait");
      }
      await browser.get("/api/playlists").set("Host", host).expect(409);
      expect(auth.status).toHaveBeenCalledTimes(1);
      expect(inventory).not.toHaveBeenCalled();
      expect(runner).not.toHaveBeenCalled();
      expect(credentials).toBe("original");
      if (operation === "complete") {
        const replay = await browser.get("/auth/google/callback?state=test-state&code=code").set("Host", host).expect(302);
        expect(replay.headers.location).toContain("authError=");
        expect(auth.complete).toHaveBeenCalledTimes(1);
      }
    } finally {
      pending.resolve();
      expect((await changing).status).toBe(operation === "complete" ? 302 : 200);
    }
    expect(credentials).toBe("changed");
    expect(isBusy()).toBe(false);
    await browser.get("/api/playlists").set("Host", host).expect(200);
    await browser.post("/api/backups").set("Host", host).set("X-CSRF-Token", csrf).expect(202);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("keeps credentials reserved through inventory preflight and the provider read", async () => {
    const statusEntered = deferred();
    const connection = deferred<{ configured: boolean; connected: boolean }>();
    const readEntered = deferred();
    const playlists = deferred<Awaited<ReturnType<DemoProvider["listPlaylists"]>>>();
    const { browser, host, csrf, auth, provider, isBusy } = await setup(false);
    auth.status.mockImplementationOnce(() => {
      statusEntered.resolve();
      return connection.promise;
    });
    vi.spyOn(provider, "listPlaylists").mockImplementationOnce(() => {
      readEntered.resolve();
      return playlists.promise;
    });
    const reading = browser.get("/api/playlists").set("Host", host).then((response) => response);
    try {
      await statusEntered.promise;
      expect(isBusy()).toBe(true);
      await browser.post("/api/auth/disconnect").set("Host", host).set("X-CSRF-Token", csrf).expect(409);
      connection.resolve({ configured: true, connected: true });
      await readEntered.promise;
      for (const url of ["/api/auth/disconnect", "/api/auth/connect", "/api/backups"]) {
        const conflict = await browser.post(url).set("Host", host).set("X-CSRF-Token", csrf).expect(409);
        expect(conflict.body.error.code).toBe("INVENTORY_BUSY");
      }
      await browser.get("/api/playlists").set("Host", host).expect(409);
      expect(auth.disconnect).not.toHaveBeenCalled();
      expect(auth.begin).not.toHaveBeenCalled();
    } finally {
      connection.resolve({ configured: true, connected: true });
      playlists.resolve([]);
      expect((await reading).status).toBe(200);
    }
    expect(isBusy()).toBe(false);
    await browser.post("/api/auth/disconnect").set("Host", host).set("X-CSRF-Token", csrf).expect(200);
    expect(auth.disconnect).toHaveBeenCalledTimes(1);
  });

  it.each(["begin", "disconnect", "complete"] as const)("releases the credential reservation when auth.%s fails", async (operation) => {
    const { browser, host, csrf, auth, isBusy } = await setup(false);
    if (operation === "complete") {
      await browser.post("/api/auth/connect").set("Host", host).set("X-CSRF-Token", csrf).expect(200);
    }
    auth[operation].mockRejectedValueOnce(new Error("Synthetic authorization failure"));
    if (operation === "complete") {
      const failed = await browser.get("/auth/google/callback?state=test-state&code=code").set("Host", host).expect(302);
      expect(failed.headers.location).toContain("authError=");
      await browser.get("/auth/google/callback?state=test-state&code=code").set("Host", host).expect(302);
      expect(auth.complete).toHaveBeenCalledTimes(1);
    } else {
      await browser.post(`/api/auth/${operation === "begin" ? "connect" : "disconnect"}`)
        .set("Host", host).set("X-CSRF-Token", csrf).expect(500);
    }
    expect(isBusy()).toBe(false);
    await browser.get("/api/playlists").set("Host", host).expect(200);
    await browser.post("/api/auth/connect").set("Host", host).set("X-CSRF-Token", csrf).expect(200);
  });

  it.each(["retention", "backup-status", "inventory-status", "inventory"] as const)("releases the reservation after a failed %s preflight or read", async (failure) => {
    const entered = deferred();
    const pending = deferred<never>();
    const wait = () => {
      entered.resolve();
      return pending.promise;
    };
    const runner = vi.fn(async () => completedManifest());
    const { browser, host, csrf, auth, provider, isBusy } = await setup(false, runner);
    if (failure === "retention") {
      vi.spyOn(RetentionController.prototype, "check").mockImplementationOnce(wait);
    } else if (failure === "inventory") {
      vi.spyOn(provider, "listPlaylists").mockImplementationOnce(wait);
    } else {
      auth.status.mockImplementationOnce(wait);
    }
    const failing = (failure === "retention" || failure === "backup-status"
      ? browser.post("/api/backups").set("Host", host).set("X-CSRF-Token", csrf)
      : browser.get("/api/playlists").set("Host", host)).then((response) => response);
    try {
      await entered.promise;
      expect(isBusy()).toBe(true);
      await browser.post("/api/auth/disconnect").set("Host", host).set("X-CSRF-Token", csrf).expect(409);
      expect(auth.disconnect).not.toHaveBeenCalled();
    } finally {
      pending.reject(new Error("Synthetic preflight or read failure"));
      expect((await failing).status).toBe(500);
    }
    expect(isBusy()).toBe(false);
    await browser.post("/api/auth/disconnect").set("Host", host).set("X-CSRF-Token", csrf).expect(200);
    await browser.post("/api/backups").set("Host", host).set("X-CSRF-Token", csrf).expect(202);
    expect(runner).toHaveBeenCalledTimes(1);
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

  it.each([false, true])("releases the reservation and reports job errors (async: %s)", async (asyncFailure) => {
    const fail = () => { throw new Error("Disk is full"); };
    const { browser, host, csrf, isBusy } = await setup(false, asyncFailure ? async () => fail() : fail);
    const start = await browser.post("/api/backups").set("Host", host).set("X-CSRF-Token", csrf).expect(202);
    await vi.waitFor(async () => {
      const result = await browser.get(`/api/jobs/${start.body.job.id}`).set("Host", host);
      expect(result.body.job.state).toBe("failed");
      expect(result.body.job.error).toBe("Disk is full");
    });
    expect(isBusy()).toBe(false);
    await browser.post("/api/auth/disconnect").set("Host", host).set("X-CSRF-Token", csrf).expect(200);
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
    const { browser, host, csrf, config, isBusy } = await setup();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() - 31 * 86_400_000);
    const old = await runBackup(new DemoProvider(), config.backupDirectory);
    vi.useRealTimers();
    const note = path.join(config.backupDirectory, old.id, "my-notes.txt");
    await writeFile(note, "User content must never be deleted by retention.");
    await browser.post("/api/backups").set("Host", host).set("X-CSRF-Token", csrf).expect(503);
    expect(isBusy()).toBe(false);
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
