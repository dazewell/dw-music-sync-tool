#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { setTimeout } from "node:timers/promises";
import { GoogleAuth } from "./auth/google.js";
import { SpotifyAuth } from "./auth/spotify.js";
import { loadConfig, type AppConfig } from "./config.js";
import { recoverInterruptedBackups, runBackup } from "./core/backup.js";
import { AppError, errorMessage } from "./core/errors.js";
import { DemoProvider } from "./providers/demo.js";
import { SpotifyProvider } from "./providers/spotify.js";
import { YouTubeProvider } from "./providers/youtube.js";
import { acquireRuntimeLocks } from "./runtime-lock.js";
import { SyncStateStore } from "./core/sync-state.js";
import { collectRemovalRecords, createApp, type SyncIntegration, type SyncPairRef } from "./server/app.js";
import { discoverPlaylists, executeSyncRun, type SyncExecutorProviders } from "./services/sync-executor.js";
import { RetentionController } from "./services/retention.js";
import { updateEnvRefreshToken } from "./spotify-auth-cli.js";

const help = `Music library - local playlist backups

Usage:
  npm start                         Open the local web app
  npm run demo                      Web app with synthetic data; no credentials
  npm run backup                    Back up all API-visible owned playlists
  npm run backup -- --output D:\\Music\\Backups
  node dist/cli.js backup --demo     Export synthetic demo playlists

Commands: serve (default), backup, sync
Options:
  --port <number>       Local web port (default 8787)
  --output <path>       Local backup directory (default backups)
  --demo                Use synthetic data, isolated under a demo subdirectory
  --removals            With sync: print the durable removal audit records only
  --pair-left <ref>     With sync: pair a playlist; ref is provider:accountId:playlistId
  --pair-right <ref>    With sync: the other playlist of the new pair (required with --pair-left)
  --unpair <pairId>     With sync: remove an explicit pair by ID
  --ignore <ref>        With sync: mark a playlist ignored; ref is provider:accountId:playlistId
  --reason <text>       With sync --ignore: an optional reason recorded with the ignore
  --unignore <ref>      With sync: restore an ignored playlist
  --run <pairId>        With sync: run one explicit pair now through the real providers
  --help                Show this help

The sync command manages explicit playlist pairs and ignored playlists, can
trigger a manual run, and reports recent runs and searchable removal audit
records (sync --removals, or filter with GET /api/sync/removals). Removals
are mirrored in both directions, so each one is recorded in a durable audit
record with its platform, playlist, track identity, direction, time and
outcome. Running sync --run evaluates an explicitly selected pair against the
real YouTube provider and, if SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET and
SPOTIFY_REFRESH_TOKEN are configured, the real Spotify provider; an
unconfigured or demo side fails the run closed instead of pretending to
succeed. Every pair is cross-provider, and cross-platform recording-identity
resolution is not implemented yet, so a real run currently always reports
review-required rather than writing anything (see README.md). Sync
management options require exclusive access to the data directory, the same
as backup.

Set up a Google Desktop OAuth client and connect in the web app first.
App-managed exports expire after 30 days and are removed while this app is running.
See README.md for coverage, credential storage and API retention limitations.
Close the web app before running the standalone backup command or a sync
management option.
`;

/**
 * Binds the HTTP/CLI sync surface to durable core state. Pairing, ignoring and
 * auditing are state decisions the store already owns. Executing a run needs
 * real authenticated mutation providers; the caller supplies whichever ones
 * are actually available in this process (never a fake/no-op writer), and an
 * unavailable side fails the run closed with an actionable message instead of
 * guessing.
 */
function createSyncIntegration(config: AppConfig, providers: SyncExecutorProviders): SyncIntegration {
  const store = new SyncStateStore(path.join(config.dataDirectory, "sync-state.json"));
  return {
    // A plain report never holds the runtime lock for the whole operation, so it
    // must not recover runs it can't actually observe as active; peek() is read-only.
    state: () => store.peek(),
    pair: (pairing) => store.pair(pairing),
    unpair: (id) => store.update((state) => {
      const index = state.pairs.findIndex((item) => item.id === id);
      if (index < 0) throw new AppError("SYNC_PAIR_NOT_FOUND", "That playlist pair does not exist.", 404);
      state.pairs.splice(index, 1);
      // Otherwise a stale baseline for this pair id survives the unpair and would be reused
      // as the "last known state" for an unrelated future pair that happens to get the same id.
      delete state.baselines[id];
    }),
    ignore: (ignore) => store.ignore(ignore),
    unignore: (ref) => store.unignore(ref),
    run: (pairId) => executeSyncRun(store, providers, pairId),
    discover: (id) => discoverPlaylists(providers, id),
  };
}

/** Parses a CLI playlist reference of the form provider:accountId:playlistId. */
function parseSyncRef(raw: string): SyncPairRef {
  const parts = raw.split(":");
  if (parts.length !== 3 || !["youtube", "spotify"].includes(parts[0]!) || !parts[1] || !parts[2]) {
    throw new AppError("INVALID_COMMAND", "Use provider:accountId:playlistId, where provider is youtube or spotify.", 400);
  }
  return { provider: parts[0] as SyncPairRef["provider"], accountId: parts[1], playlistId: parts[2] };
}

async function main(): Promise<void> {
  try {
    process.loadEnvFile();
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      port: { type: "string" },
      output: { type: "string" },
      demo: { type: "boolean" },
      removals: { type: "boolean" },
      "pair-left": { type: "string" },
      "pair-right": { type: "string" },
      unpair: { type: "string" },
      ignore: { type: "string" },
      reason: { type: "string" },
      unignore: { type: "string" },
      run: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) { console.log(help); return; }
  const command = positionals[0] ?? "serve";
  if (!["serve", "backup", "sync"].includes(command) || positionals.length > 1) {
    throw new AppError("INVALID_COMMAND", `Unknown command. Use --help for usage.`, 400);
  }
  if (values.removals && command !== "sync") {
    throw new AppError("INVALID_COMMAND", "--removals applies only to the sync command.", 400);
  }
  const managementFlags = [
    values["pair-left"] !== undefined || values["pair-right"] !== undefined,
    values.unpair !== undefined,
    values.ignore !== undefined,
    values.unignore !== undefined,
    values.run !== undefined,
  ];
  const managementOps = managementFlags.filter(Boolean).length;
  if (managementOps > 0 && command !== "sync") {
    throw new AppError("INVALID_COMMAND", "Sync management options apply only to the sync command.", 400);
  }
  if (managementOps > 1) {
    throw new AppError("INVALID_COMMAND", "Use only one sync management option per command.", 400);
  }
  if (managementOps > 0 && values.removals) {
    throw new AppError("INVALID_COMMAND", "--removals cannot be combined with a management option.", 400);
  }
  if ((values["pair-left"] === undefined) !== (values["pair-right"] === undefined)) {
    throw new AppError("INVALID_COMMAND", "--pair-left and --pair-right must be used together.", 400);
  }
  if (values.reason !== undefined && values.ignore === undefined) {
    throw new AppError("INVALID_COMMAND", "--reason applies only alongside --ignore.", 400);
  }
  const config = loadConfig(values);
  const auth = new GoogleAuth({
    credentialsFile: config.credentialsFile,
    tokenFile: config.tokenFile,
    redirectUri: config.redirectUri,
  });
  const provider = config.demo
    ? new DemoProvider()
    : new YouTubeProvider(() => auth.getAccessToken(), { writeAccessToken: () => auth.getWriteAccessToken() });
  const spotifyAuth = config.spotify
    ? new SpotifyAuth({
      ...config.spotify,
      // Keep a rotated refresh token usable across restarts by persisting it to the same
      // .env file process.loadEnvFile() reads at startup, mirroring `spotify-auth`'s writer.
      onRefreshTokenRotated: (refreshToken) => updateEnvRefreshToken(path.resolve(process.cwd(), ".env"), refreshToken),
    })
    : null;
  const syncProviders: SyncExecutorProviders = {
    youtube: config.demo ? null : (provider as YouTubeProvider),
    spotify: spotifyAuth ? new SpotifyProvider(() => spotifyAuth.getAccessToken()) : null,
  };

  if (command === "sync") {
    if (managementOps === 0) {
      // Reporting pairs/ignores/runs never mutates a remote playlist, so no providers are wired here.
      const state = await createSyncIntegration(config, { youtube: null, spotify: null }).state();
      if (values.removals) {
        console.log(JSON.stringify({ removals: collectRemovalRecords(state) }, null, 2));
        return;
      }
      console.log(JSON.stringify({
        pairs: state.pairs,
        ignores: state.ignores,
        runs: state.runs,
        removals: collectRemovalRecords(state, { limit: 20 }),
      }, null, 2));
      return;
    }
    // Every management option mutates durable sync state (and --run additionally mutates a
    // remote playlist), so it needs the same exclusive access as a backup.
    const release = await acquireRuntimeLocks([config.dataDirectory, config.backupDirectory]);
    try {
      const integration = createSyncIntegration(config, syncProviders);
      if (values["pair-left"] !== undefined && values["pair-right"] !== undefined) {
        const left = parseSyncRef(values["pair-left"]);
        const right = parseSyncRef(values["pair-right"]);
        if (left.provider === right.provider) {
          throw new AppError("INVALID_SYNC_PAIR", "A pair requires one Spotify and one YouTube Music playlist.", 400);
        }
        const now = new Date().toISOString();
        const state = await integration.pair({ id: randomUUID(), left, right, enabled: true, createdAt: now, updatedAt: now });
        console.log(JSON.stringify({ pairs: state.pairs }, null, 2));
        return;
      }
      if (values.unpair !== undefined) {
        const state = await integration.unpair(values.unpair);
        console.log(JSON.stringify({ pairs: state.pairs }, null, 2));
        return;
      }
      if (values.ignore !== undefined) {
        const ref = parseSyncRef(values.ignore);
        const state = await integration.ignore({ ...ref, reason: values.reason ?? "", createdAt: new Date().toISOString() });
        console.log(JSON.stringify({ ignores: state.ignores }, null, 2));
        return;
      }
      if (values.unignore !== undefined) {
        const ref = parseSyncRef(values.unignore);
        const state = await integration.unignore(ref);
        console.log(JSON.stringify({ ignores: state.ignores }, null, 2));
        return;
      }
      // values.run is the only remaining management option.
      const run = await integration.run(values.run!);
      console.log(JSON.stringify({ run }, null, 2));
      if (run.status === "failed" || run.status === "review-required") process.exitCode = 1;
    } finally {
      await release();
    }
    return;
  }

  if (command === "backup") {
    const release = await acquireRuntimeLocks([config.dataDirectory, config.backupDirectory]);
    const retention = new RetentionController(config.backupDirectory);
    try {
      await recoverInterruptedBackups(config.backupDirectory);
      await retention.check(true);
      if (retention.status().error) {
        throw new AppError("RETENTION_CLEANUP_FAILED", retention.status().error!, 503);
      }
      retention.start();
      if (!config.demo) {
        const status = await auth.status();
        if (!status.configured || !status.connected) {
          throw new AppError("CONNECT_REQUIRED", "Run npm start, finish Google setup and connect your account first.", 401);
        }
      }
      console.error(`Saving ${config.demo ? "synthetic demo" : "YouTube"} playlist metadata to ${config.backupDirectory}`);
      const manifest = await runBackup(provider, config.backupDirectory, (progress) => {
        console.error(`[${progress.current}/${progress.total}] ${progress.playlistTitle ?? "Discovering playlists"}`);
      });
      console.log(JSON.stringify(manifest, null, 2));
      if (manifest.status !== "complete") process.exitCode = 1;
    } finally {
      await retention.stop();
      await release();
    }
    return;
  }

  try {
    await Promise.all(["index.html", "app.js", "styles.css"].map((name) => access(path.join(config.webDirectory, name))));
  } catch {
    throw new AppError("BUILD_REQUIRED", "The web interface is not built. Run npm run build, then npm start.", 500);
  }
  const release = await acquireRuntimeLocks([config.dataDirectory, config.backupDirectory]);
  try {
    await recoverInterruptedBackups(config.backupDirectory);
  } catch (error) {
    await release();
    throw error;
  }
  const { app, isBusy, stopRetention } = createApp({ config, auth, provider, sync: createSyncIntegration(config, syncProviders) });
  const server = app.listen(config.port, "127.0.0.1");
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
  } catch (error) {
    await stopRetention();
    await release();
    throw error;
  }
  console.log(`Music library${config.demo ? " (synthetic demo)" : ""}: ${config.baseUrl}`);
  console.log(`Local backups: ${config.backupDirectory}`);
  console.log("Playlist metadata reads for backups are read-only; sync writes are mirrored only for an explicit pair you selected. Press Ctrl+C to stop.");
  console.log("Rolling retention: app-managed exports expire after 30 days. Cleanup runs while this app is running.");
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    // Drain HTTP requests before checking reservations: an accepted request may still start a detached backup.
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (isBusy()) console.log("Finishing the active operation before stopping...");
    while (isBusy()) await setTimeout(250);
    await stopRetention();
    await release();
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void stop().catch((error: unknown) => {
        console.error(`Shutdown failed: ${errorMessage(error)}`);
        process.exitCode = 1;
      });
    });
  }
}

void main().catch((error: unknown) => {
  console.error(errorMessage(error));
  process.exitCode = 1;
});