import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import type { GoogleAuth } from "../auth/google.js";
import type { AppConfig } from "../config.js";
import { listBackups, readManifest, resolveBackupFile, runBackup } from "../core/backup.js";
import { backupExpiresAt } from "../core/retention.js";
import { AppError, errorMessage } from "../core/errors.js";
import type { PlaylistProvider, ProviderId } from "../core/models.js";
import type { SyncIgnore, SyncPair, SyncPairRef, SyncRemovalAudit } from "../core/sync.js";
import type { SyncRun, SyncState } from "../core/sync-state.js";
import type { BackupJob, StatusResponse } from "../shared/api.js";
import { RetentionController } from "../services/retention.js";

export type { SyncIgnore, SyncPair, SyncPairRef, SyncRemovalAudit, SyncRun, SyncState };

/**
 * A durable removal audit record as presented by the API: the core audit plus
 * the run it belongs to and the platform the removal mirrored from. Mirroring
 * deletes remote entries, so every attempt stays inspectable afterwards.
 */
export interface SyncRemovalRecord extends SyncRemovalAudit {
  runId: string;
  runStatus: SyncRun["status"];
  /** The paired platform the removal mirrored from; null when the pair is gone. */
  sourcePlatform: ProviderId | null;
}

/** The sync surface presented to clients; persisted baselines stay internal. */
export interface SyncStateView {
  pairs: SyncPair[];
  ignores: SyncIgnore[];
  runs: SyncRun[];
  removals: SyncRemovalRecord[];
}

/**
 * The sync application service owns provider discovery, matching, persistence,
 * direct API writes, verification and removal policy. The interface keeps the
 * HTTP/CLI layers from reimplementing any of those decisions.
 */
export interface SyncIntegration {
  state(): Promise<SyncState>;
  pair(pairing: SyncPair): Promise<SyncState>;
  unpair(id: string): Promise<SyncState>;
  ignore(ignore: SyncIgnore): Promise<SyncState>;
  unignore(ref: SyncPairRef): Promise<SyncState>;
  run(pairId: string): Promise<SyncRun>;
}

const RECENT_RUNS = 20;
const RECENT_REMOVALS = 100;

/** Optional filters for the durable removal audit history: safe equality checks
 * plus a case-insensitive substring search on the provider-native track identity. */
export interface RemovalRecordQuery {
  pairId?: string;
  platform?: ProviderId;
  playlistId?: string;
  itemIdentity?: string;
  direction?: SyncRemovalAudit["direction"];
  outcome?: SyncRemovalAudit["outcome"];
  limit?: number;
}

/** Flattens durable run audits into newest-first removal records, applying any filters. */
export function collectRemovalRecords(
  state: SyncState,
  query: RemovalRecordQuery = {},
): SyncRemovalRecord[] {
  const pairs = new Map(state.pairs.map((item) => [item.id, item]));
  const identitySearch = query.itemIdentity?.toLowerCase();
  const records: SyncRemovalRecord[] = [];
  for (const run of state.runs) {
    for (const audit of run.removals) {
      if (query.pairId !== undefined && audit.pairId !== query.pairId) continue;
      if (query.platform !== undefined && audit.platform !== query.platform) continue;
      if (query.playlistId !== undefined && audit.playlistId !== query.playlistId) continue;
      if (identitySearch !== undefined && !audit.itemIdentity.toLowerCase().includes(identitySearch)) continue;
      if (query.direction !== undefined && audit.direction !== query.direction) continue;
      if (query.outcome !== undefined && audit.outcome !== query.outcome) continue;
      const pair = pairs.get(audit.pairId);
      records.push({
        ...audit,
        runId: run.id,
        runStatus: run.status,
        sourcePlatform: pair
          ? (pair.left.provider === audit.platform ? pair.right.provider : pair.left.provider)
          : null,
      });
    }
  }
  records.sort((left, right) => right.timestamp.localeCompare(left.timestamp));
  return query.limit === undefined ? records : records.slice(0, query.limit);
}

function toSyncView(state: SyncState): SyncStateView {
  return {
    pairs: state.pairs,
    ignores: state.ignores,
    runs: [...state.runs].sort((left, right) => right.startedAt.localeCompare(left.startedAt)).slice(0, RECENT_RUNS),
    removals: collectRemovalRecords(state, { limit: RECENT_REMOVALS }),
  };
}

function readRef(value: unknown): SyncPairRef {
  const ref = value as Partial<SyncPairRef> | null;
  if (!ref || !["youtube", "spotify"].includes(ref.provider ?? "")
    || typeof ref.accountId !== "string" || !ref.accountId.trim() || ref.accountId.length > 200
    || typeof ref.playlistId !== "string" || !ref.playlistId.trim() || ref.playlistId.length > 200) {
    throw new AppError("INVALID_SYNC_PAIR", "Each playlist reference requires a provider, account ID and playlist ID.", 400);
  }
  // Persist the normalized value: an accepted whitespace-padded ID must still match
  // the provider's actual ID, which discovery never returns with padding.
  return { provider: ref.provider as ProviderId, accountId: ref.accountId.trim(), playlistId: ref.playlistId.trim() };
}

export interface ServerDependencies {
  config: AppConfig;
  auth: Pick<GoogleAuth, "status" | "begin" | "complete" | "disconnect">;
  provider: PlaylistProvider;
  backupRunner?: typeof runBackup;
  sync?: SyncIntegration;
}

interface BrowserSession {
  expiresAt: number;
  csrfToken: string;
  oauth: { state: string; codeVerifier: string; expiresAt: number } | null;
}

function sameSecret(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function createApp({ config, auth, provider, backupRunner = runBackup, sync }: ServerDependencies) {
  const app = express();
  const sessions = new Map<string, BrowserSession>();
  const jobs = new Map<string, BackupJob>();
  let latestJob: BackupJob | null = null;
  let operation: "backup" | "auth" | "inventory" | "sync" | null = null;
  const expireJobs = () => {
    for (const [id, job] of jobs) {
      if (job.state !== "running" && Date.parse(backupExpiresAt(job.startedAt)) <= Date.now()) {
        jobs.delete(id);
        if (latestJob?.id === id) latestJob = null;
      }
    }
  };
  const retention = new RetentionController(config.backupDirectory, expireJobs);
  retention.start();

  function session(req: Request, res: Response, create = false): BrowserSession {
    const cookie = req.headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith("music_session="));
    let id = cookie?.slice("music_session=".length);
    const now = Date.now();
    for (const [key, value] of sessions) {
      if (value.expiresAt <= now) sessions.delete(key);
    }
    let current = id ? sessions.get(id) : undefined;
    if (!current && create) {
      if (sessions.size >= 32) {
        const oldest = sessions.keys().next().value;
        if (oldest) sessions.delete(oldest);
      }
      id = randomBytes(32).toString("hex");
      current = { expiresAt: now + 86_400_000, csrfToken: randomBytes(32).toString("hex"), oauth: null };
      sessions.set(id, current);
      res.cookie("music_session", id, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 86_400_000 });
    }
    if (!current) throw new AppError("SESSION_REQUIRED", "Reload the local app to establish a browser session.", 401);
    return current;
  }

  function reserve(next: NonNullable<typeof operation>): () => void {
    if (operation === "backup") {
      throw new AppError("BACKUP_RUNNING", "A backup is already running. Wait for it to finish.", 409);
    }
    if (operation === "auth") {
      throw new AppError("AUTH_BUSY", "Google authorization is changing. Wait for it to finish, then try again.", 409);
    }
    if (operation === "inventory") {
      throw new AppError("INVENTORY_BUSY", "Playlists are being read. Wait for discovery to finish, then try again.", 409);
    }
    if (operation === "sync") {
      throw new AppError("SYNC_BUSY", "A synchronization operation is already running. Wait for it to finish, then try again.", 409);
    }
    // Reserve before any await so credential changes cannot interleave with provider reads or backup preflight.
    operation = next;
    return () => { operation = null; };
  }

  async function requireConnected(): Promise<void> {
    if (config.demo) return;
    const status = await auth.status();
    if (!status.configured) throw new AppError("SETUP_REQUIRED", "Configure your Google Desktop OAuth client first. See README.", 400);
    if (!status.connected) throw new AppError("CONNECT_REQUIRED", "Connect your Google account before reading playlists.", 401);
  }

  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.set({
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    });
    if (req.headers.host !== new URL(config.baseUrl).host) {
      next(new AppError("INVALID_HOST", `Open this app at ${config.baseUrl}. Other hostnames are not accepted.`, 403));
      return;
    }
    if (req.headers.origin && req.headers.origin !== config.baseUrl) {
      next(new AppError("INVALID_ORIGIN", "Requests from other websites are not allowed.", 403));
      return;
    }
    next();
  });
  app.use(express.json({ limit: "4kb" }));

  app.get("/api/status", async (req, res) => {
    const current = session(req, res, true);
    await retention.check();
    let connection = { configured: true, connected: true };
    let connectionError: StatusResponse["connectionError"] = null;
    if (!config.demo) {
      try {
        connection = await auth.status();
      } catch (error) {
        if (!(error instanceof AppError) || (error.code !== "GOOGLE_TOKEN_INVALID" && error.code !== "GOOGLE_CONFIG_INVALID")) {
          throw error;
        }
        connection = { configured: error.code === "GOOGLE_TOKEN_INVALID", connected: false };
        connectionError = { code: error.code, message: error.message };
      }
    }
    const status: StatusResponse = {
      appName: "Music library",
      demo: config.demo,
      ...connection,
      connectionError,
      csrfToken: current.csrfToken,
      backupDirectory: config.backupDirectory,
      redirectUri: config.redirectUri,
      coverage: provider.coverage,
      retention: retention.status(),
    };
    res.json(status);
  });

  app.use("/api", (req, res, next) => {
    expireJobs();
    const current = session(req, res);
    if (!["GET", "HEAD"].includes(req.method)) {
      if (req.headers["sec-fetch-site"] === "cross-site" || !sameSecret(req.get("X-CSRF-Token"), current.csrfToken)) {
        throw new AppError("INVALID_CSRF", "This request was not authorized by the local app. Reload and try again.", 403);
      }
    }
    next();
  });

  app.post("/api/auth/connect", async (req, res) => {
    const release = reserve("auth");
    try {
      if (config.demo) throw new AppError("DEMO_MODE", "Demo mode does not connect to Google.", 400);
      const current = session(req, res);
      const pending = await auth.begin();
      current.oauth = { state: pending.state, codeVerifier: pending.codeVerifier, expiresAt: Date.now() + 600_000 };
      res.json({ url: pending.url });
    } finally {
      release();
    }
  });

  app.get("/auth/google/callback", async (req, res) => {
    try {
      const current = session(req, res);
      const pending = current.oauth;
      if (!pending || typeof req.query["state"] !== "string" || !sameSecret(req.query["state"], pending.state)) {
        throw new AppError("INVALID_OAUTH_STATE", "The sign-in link expired or belongs to another browser. Start Connect Google again.", 400);
      }
      if (pending.expiresAt <= Date.now()) {
        current.oauth = null;
        throw new AppError("INVALID_OAUTH_STATE", "The sign-in link expired or belongs to another browser. Start Connect Google again.", 400);
      }
      const code = req.query["code"];
      const denied = req.query["error"];
      if (denied !== undefined && (typeof denied !== "string" || !denied || code !== undefined)) {
        throw new AppError("INVALID_AUTH_RESPONSE", "Google did not return a valid authorization response.", 400);
      }
      const release = reserve("auth");
      try {
        if (denied !== undefined) {
          current.oauth = null;
          throw new AppError("AUTH_DENIED", "Google authorization was not granted. Try connecting again.", 400);
        }
        if (typeof code !== "string" || !code || code.length > 8192) {
          throw new AppError("INVALID_AUTH_CODE", "Google did not return a valid authorization code.", 400);
        }
        current.oauth = null;
        await auth.complete(code, pending.codeVerifier);
        res.redirect("/?connected=1");
      } finally {
        release();
      }
    } catch (error) {
      const message = error instanceof AppError ? error.message : "Google sign-in failed. Check your OAuth setup and try again.";
      console.error(`Google connection: ${message}`);
      res.redirect(`/?authError=${encodeURIComponent(message)}`);
    }
  });

  app.post("/api/auth/disconnect", async (_req, res) => {
    const release = reserve("auth");
    try {
      if (config.demo) throw new AppError("DEMO_MODE", "Demo mode has no Google connection to disconnect.", 400);
      for (const current of sessions.values()) current.oauth = null;
      await auth.disconnect();
      res.json({ ok: true });
    } finally {
      release();
    }
  });

  app.post("/api/retention/check", async (_req, res) => {
    await retention.check(true);
    res.json({ retention: retention.status() });
  });

  app.get("/api/playlists", async (_req, res) => {
    const release = reserve("inventory");
    try {
      await requireConnected();
      res.json({ playlists: await provider.listPlaylists(), coverage: provider.coverage });
    } finally {
      release();
    }
  });

  app.get("/api/backups", async (_req, res) => {
    await retention.check();
    const backups = await listBackups(config.backupDirectory);
    res.json({ backups: backups.filter((backup) => Date.parse(backupExpiresAt(backup.startedAt)) > Date.now()) });
  });

  function syncService(): SyncIntegration {
    if (!sync) {
      throw new AppError("SYNC_UNAVAILABLE", "Synchronization is not configured. A direct Spotify and YouTube Music sync service is required; no remote changes were made.", 501);
    }
    return sync;
  }

  app.get("/api/sync", async (_req, res) => {
    res.json(toSyncView(await syncService().state()));
  });

  app.get("/api/sync/removals", async (req, res) => {
    const service = syncService();
    const pairId = req.query["pairId"];
    const platform = req.query["platform"];
    const playlistId = req.query["playlistId"];
    const itemIdentity = req.query["itemIdentity"];
    const direction = req.query["direction"];
    const outcome = req.query["outcome"];
    const limit = req.query["limit"];
    if (pairId !== undefined && (typeof pairId !== "string" || !pairId || pairId.length > 200)) {
      throw new AppError("INVALID_SYNC_QUERY", "The optional pair ID must be a single non-empty value.", 400);
    }
    if (platform !== undefined && (typeof platform !== "string" || !["youtube", "spotify"].includes(platform))) {
      throw new AppError("INVALID_SYNC_QUERY", "The optional platform must be youtube or spotify.", 400);
    }
    if (playlistId !== undefined && (typeof playlistId !== "string" || !playlistId || playlistId.length > 200)) {
      throw new AppError("INVALID_SYNC_QUERY", "The optional playlist ID must be a single non-empty value.", 400);
    }
    if (itemIdentity !== undefined && (typeof itemIdentity !== "string" || !itemIdentity.trim() || itemIdentity.length > 200)) {
      throw new AppError("INVALID_SYNC_QUERY", "The optional track identity search must be non-empty text of at most 200 characters.", 400);
    }
    if (direction !== undefined && direction !== "left-to-right" && direction !== "right-to-left") {
      throw new AppError("INVALID_SYNC_QUERY", "The optional direction must be left-to-right or right-to-left.", 400);
    }
    if (outcome !== undefined && outcome !== "success" && outcome !== "failed" && outcome !== "unknown") {
      throw new AppError("INVALID_SYNC_QUERY", "The optional outcome must be success, failed, or unknown.", 400);
    }
    let parsedLimit: number | undefined;
    if (limit !== undefined) {
      if (typeof limit !== "string" || !/^[1-9][0-9]{0,3}$/.test(limit) || Number(limit) > 1000) {
        throw new AppError("INVALID_SYNC_QUERY", "The optional limit must be a whole number between 1 and 1000.", 400);
      }
      parsedLimit = Number(limit);
    }
    res.json({
      removals: collectRemovalRecords(await service.state(), {
        ...(pairId === undefined ? {} : { pairId: pairId as string }),
        ...(platform === undefined ? {} : { platform: platform as ProviderId }),
        ...(playlistId === undefined ? {} : { playlistId: playlistId as string }),
        ...(itemIdentity === undefined ? {} : { itemIdentity: (itemIdentity as string).trim() }),
        ...(direction === undefined ? {} : { direction: direction as "left-to-right" | "right-to-left" }),
        ...(outcome === undefined ? {} : { outcome: outcome as "success" | "failed" | "unknown" }),
        ...(parsedLimit === undefined ? {} : { limit: parsedLimit }),
      }),
    });
  });

  app.post("/api/sync/pairs", async (req, res) => {
    const release = reserve("sync");
    try {
      const service = syncService();
      const body = req.body as { left?: unknown; right?: unknown } | null;
      const left = readRef(body?.left);
      const right = readRef(body?.right);
      if (left.provider === right.provider) {
        throw new AppError("INVALID_SYNC_PAIR", "A pair requires one Spotify and one YouTube Music playlist.", 400);
      }
      const now = new Date().toISOString();
      res.status(201).json(toSyncView(await service.pair({
        id: randomUUID(), left, right, enabled: true, createdAt: now, updatedAt: now,
      })));
    } finally {
      release();
    }
  });

  app.delete("/api/sync/pairs/:id", async (req, res) => {
    const release = reserve("sync");
    try {
      const service = syncService();
      const id = req.params["id"];
      if (!id || id.length > 200) throw new AppError("INVALID_SYNC_PAIR", "A valid pair ID is required.", 400);
      res.json(toSyncView(await service.unpair(id)));
    } finally {
      release();
    }
  });

  app.post("/api/sync/ignored", async (req, res) => {
    const release = reserve("sync");
    try {
      const service = syncService();
      const body = req.body as { reason?: unknown } | null;
      const ref = readRef(body);
      if (body?.reason !== undefined && (typeof body.reason !== "string" || body.reason.length > 500)) {
        throw new AppError("INVALID_SYNC_IGNORE", "An ignore reason must be text of at most 500 characters.", 400);
      }
      res.status(201).json(toSyncView(await service.ignore({
        ...ref, reason: (body?.reason as string | undefined) ?? "", createdAt: new Date().toISOString(),
      })));
    } finally {
      release();
    }
  });

  app.delete("/api/sync/ignored/:provider/:accountId/:playlistId", async (req, res) => {
    const release = reserve("sync");
    try {
      const service = syncService();
      const ref = readRef({
        provider: req.params["provider"], accountId: req.params["accountId"], playlistId: req.params["playlistId"],
      });
      res.json(toSyncView(await service.unignore(ref)));
    } finally {
      release();
    }
  });

  app.post("/api/sync/run", async (req, res) => {
    const release = reserve("sync");
    try {
      const service = syncService();
      const body = req.body as { pairId?: unknown } | null;
      if (typeof body?.pairId !== "string" || !body.pairId || body.pairId.length > 200) {
        throw new AppError("INVALID_SYNC_RUN", "An explicit pair ID is required; unpaired playlists are never mirrored.", 400);
      }
      const run = await service.run(body.pairId);
      res.status(run.status === "running" ? 202 : 200).json({ run });
    } finally {
      release();
    }
  });

  app.post("/api/backups", async (_req, res) => {
    const release = reserve("backup");
    let started = false;
    try {
      await retention.check(true);
      if (retention.status().error) {
        throw new AppError("RETENTION_CLEANUP_FAILED", "Expired backup cleanup needs attention. Check the retention notice and resolve it before starting another backup.", 503);
      }
      await requireConnected();
      const job: BackupJob = {
        id: randomUUID(),
        state: "running",
        startedAt: new Date().toISOString(),
        progress: { total: 0, current: 0, playlistTitle: null },
        manifest: null,
        error: null,
      };
      latestJob = job;
      jobs.set(job.id, job);
      if (jobs.size > 50) {
        const oldest = jobs.keys().next().value;
        if (oldest) jobs.delete(oldest);
      }
      void Promise.resolve().then(() => backupRunner(provider, config.backupDirectory, (progress) => {
        job.progress = progress;
      })).then((manifest) => {
        job.manifest = manifest;
        job.state = manifest.status === "failed" ? "failed" : "finished";
        job.error = manifest.error;
      }).catch((error: unknown) => {
        job.state = "failed";
        job.error = errorMessage(error);
        console.error(`Backup failed: ${job.error}`);
      }).finally(release);
      started = true;
      res.status(202).json({ job });
    } finally {
      if (!started) release();
    }
  });

  app.get("/api/jobs/current", (_req, res) => res.json({ job: latestJob }));
  app.get("/api/jobs/:id", (req, res) => {
    const job = jobs.get(req.params["id"] ?? "");
    if (!job) throw new AppError("JOB_NOT_FOUND", "This job is not in memory. Check backup history for completed exports.", 404);
    res.json({ job });
  });
  app.get("/api/backups/:id/files/:filename", async (req, res, next) => {
    const manifest = await readManifest(config.backupDirectory, req.params["id"] ?? "");
    if (Date.parse(backupExpiresAt(manifest.startedAt)) <= Date.now()) {
      throw new AppError("BACKUP_EXPIRED", "This backup has expired under the 30-day retention policy. Create a current backup instead.", 410);
    }
    const file = await resolveBackupFile(config.backupDirectory, req.params["id"] ?? "", req.params["filename"] ?? "");
    res.download(file, (error) => { if (error) next(error); });
  });
  app.use("/api", (_req, _res, next) => next(new AppError("NOT_FOUND", "This API route does not exist.", 404)));

  app.get("/", (req, res) => {
    session(req, res, true);
    res.sendFile("index.html", { root: config.webDirectory });
  });
  app.use(express.static(config.webDirectory, { index: false, dotfiles: "deny", fallthrough: true }));
  app.use((_req, _res, next) => next(new AppError("NOT_FOUND", "This page does not exist.", 404)));
  app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) { next(error); return; }
    const known = error instanceof AppError;
    if (!known) console.error(`Application error: ${errorMessage(error)}`);
    const malformed = error instanceof SyntaxError && "status" in error && error.status === 400;
    res.status(known ? error.status : malformed ? 400 : 500).json({
      error: {
        code: known ? error.code : malformed ? "INVALID_JSON" : "INTERNAL_ERROR",
        message: known ? error.message : malformed ? "The request body is not valid JSON." : "The operation failed. Check the terminal for details.",
      },
    });
  });

  return { app, isBusy: () => operation !== null, stopRetention: () => retention.stop() };
}
