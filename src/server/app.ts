import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import type { GoogleAuth } from "../auth/google.js";
import type { AppConfig } from "../config.js";
import { listBackups, readManifest, resolveBackupFile, runBackup } from "../core/backup.js";
import { backupExpiresAt } from "../core/retention.js";
import { AppError, errorMessage } from "../core/errors.js";
import type { PlaylistProvider } from "../core/models.js";
import type { BackupJob, StatusResponse } from "../shared/api.js";
import { RetentionController } from "../services/retention.js";

export interface ServerDependencies {
  config: AppConfig;
  auth: Pick<GoogleAuth, "status" | "begin" | "complete" | "disconnect">;
  provider: PlaylistProvider;
  backupRunner?: typeof runBackup;
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

export function createApp({ config, auth, provider, backupRunner = runBackup }: ServerDependencies) {
  const app = express();
  const sessions = new Map<string, BrowserSession>();
  const jobs = new Map<string, BackupJob>();
  let latestJob: BackupJob | null = null;
  let operation: "backup" | "auth" | "inventory" | null = null;
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
    const connection = config.demo ? { configured: true, connected: true } : await auth.status();
    const status: StatusResponse = {
      appName: "Music library",
      demo: config.demo,
      ...connection,
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
