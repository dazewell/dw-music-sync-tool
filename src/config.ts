import path from "node:path";
import { fileURLToPath } from "node:url";
import { AppError } from "./core/errors.js";

export interface SpotifyConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

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
  /**
   * Direct Spotify sync execution needs a pre-authorized refresh token; there
   * is no in-app Spotify connect flow yet. `null` means direct Spotify writes
   * are not configured, not that Spotify support is disabled by policy.
   */
  spotify: SpotifyConfig | null;
}

function loadSpotifyConfig(env: NodeJS.ProcessEnv): SpotifyConfig | null {
  const clientId = env["SPOTIFY_CLIENT_ID"]?.trim() ?? "";
  const clientSecret = env["SPOTIFY_CLIENT_SECRET"]?.trim() ?? "";
  const refreshToken = env["SPOTIFY_REFRESH_TOKEN"]?.trim() ?? "";
  const present = [clientId, clientSecret, refreshToken].filter(Boolean).length;
  if (present === 0) return null;
  if (present < 3) {
    throw new AppError(
      "SPOTIFY_CONFIG_INCOMPLETE",
      "SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET and SPOTIFY_REFRESH_TOKEN must all be set together to enable direct Spotify synchronization, or all left unset.",
      400,
    );
  }
  return { clientId, clientSecret, refreshToken };
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
    spotify: demo ? null : loadSpotifyConfig(env),
  };
}
