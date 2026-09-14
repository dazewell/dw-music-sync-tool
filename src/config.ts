import path from "node:path";
import { fileURLToPath } from "node:url";
import { AppError } from "./core/errors.js";

export interface AppConfig {
  port: number;
  baseUrl: string;
  redirectUri: string;
  dataDirectory: string;
  backupDirectory: string;
  credentialsFile: string;
  tokenFile: string;
  webDirectory: string;
  demo: boolean;
}

export function loadConfig(
  options: { port?: string; output?: string; demo?: boolean } = {},
  env: NodeJS.ProcessEnv = process.env,
): AppConfig {
  const portText = options.port ?? env["MUSIC_PORT"] ?? "8787";
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || !Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new AppError("INVALID_PORT", "MUSIC_PORT or --port must be between 1024 and 65535.", 400);
  }
  const demo = options.demo ?? false;
  const root = path.resolve(env["MUSIC_DATA_DIR"] ?? ".local");
  const dataDirectory = demo ? path.join(root, "demo") : root;
  const output = path.resolve(options.output ?? env["MUSIC_BACKUP_DIR"] ?? "backups");
  const backupDirectory = demo ? path.join(output, "demo") : output;
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    port,
    baseUrl,
    redirectUri: `${baseUrl}/auth/google/callback`,
    dataDirectory,
    backupDirectory,
    credentialsFile: path.resolve(env["GOOGLE_CLIENT_SECRET_FILE"] ?? path.join(root, "client-secret.json")),
    tokenFile: path.join(dataDirectory, "google-tokens.json"),
    webDirectory: fileURLToPath(new URL("../dist/web", import.meta.url)),
    demo,
  };
}
