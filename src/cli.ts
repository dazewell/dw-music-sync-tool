#!/usr/bin/env node
import { access } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { setTimeout } from "node:timers/promises";
import { GoogleAuth } from "./auth/google.js";
import { loadConfig } from "./config.js";
import { recoverInterruptedBackups, runBackup } from "./core/backup.js";
import { AppError, errorMessage } from "./core/errors.js";
import { DemoProvider } from "./providers/demo.js";
import { YouTubeProvider } from "./providers/youtube.js";
import { acquireRuntimeLocks } from "./runtime-lock.js";
import { createApp } from "./server/app.js";
import { RetentionController } from "./services/retention.js";

const help = `Music library - local playlist backups

Usage:
  npm start                         Open the local web app
  npm run demo                      Web app with synthetic data; no credentials
  npm run backup                    Back up all API-visible owned playlists
  npm run backup -- --output D:\\Music\\Backups
  node dist/cli.js backup --demo     Export synthetic demo playlists

Commands: serve (default), backup
Options:
  --port <number>    Local web port (default 8787)
  --output <path>    Local backup directory (default backups)
  --demo            Use synthetic data, isolated under a demo subdirectory
  --help            Show this help

Set up a Google Desktop OAuth client and connect in the web app first.
App-managed exports expire after 30 days and are removed while this app is running.
See README.md for coverage, credential storage and API retention limitations.
Close the web app before running the standalone backup command.
`;

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
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) { console.log(help); return; }
  const command = positionals[0] ?? "serve";
  if (!["serve", "backup"].includes(command) || positionals.length > 1) {
    throw new AppError("INVALID_COMMAND", `Unknown command. Use --help for usage.`, 400);
  }
  const config = loadConfig(values);
  const auth = new GoogleAuth({
    credentialsFile: config.credentialsFile,
    tokenFile: config.tokenFile,
    redirectUri: config.redirectUri,
  });
  const provider = config.demo ? new DemoProvider() : new YouTubeProvider(() => auth.getAccessToken());

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
  const { app, isBusy, stopRetention } = createApp({ config, auth, provider });
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
  console.log("Read-only playlist metadata. Press Ctrl+C to stop.");
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
