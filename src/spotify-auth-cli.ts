#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { open, readFile, unlink } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { AppError, errorMessage } from "./core/errors.js";
import { replaceFile } from "./core/replace-file.js";

const AUTHORIZE_URL = "https://accounts.spotify.com/authorize";
const TOKEN_URL = "https://accounts.spotify.com/api/token";
// Matches the scopes documented in README.md for this tool's Spotify provider.
const SCOPES = "playlist-read-private playlist-read-collaborative playlist-modify-public playlist-modify-private";
const DEFAULT_PORT = 8888;
const CALLBACK_TIMEOUT_MS = 5 * 60_000;
const TOKEN_EXCHANGE_TIMEOUT_MS = 20_000;

const HELP = `Spotify authorization - one-time local PKCE Authorization Code flow

Usage:
  npm run spotify-auth
  npm run spotify-auth -- --port 8888

Reads SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET from .env (a refresh token is
not required to run this command; it is what this command produces). Opens
your system browser to Spotify's consent screen, receives the redirect on a
127.0.0.1-only loopback listener, exchanges the authorization code and writes
only SPOTIFY_REFRESH_TOKEN back into your local, Git-ignored .env file.

Options:
  --port <number>   Loopback callback port (default 8888; must match the
                     Redirect URI registered in your Spotify app dashboard)
  --help            Show this help

Credential values are never printed to the terminal or logs.
`;

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export function defaultOpenBrowser(url: string): void {
  const platform = process.platform;
  // On Windows, `cmd /c start "" <url>` passes the URL through cmd.exe's own command-line
  // parser, which treats an unquoted `&` as a command separator - silently truncating this
  // tool's authorize URL (which always has several `&`-separated query parameters) after the
  // first one. rundll32's URL protocol handler opens the default browser without going
  // through cmd.exe at all, so the URL reaches it as a single, untouched argument.
  const command = platform === "win32" ? "rundll32" : platform === "darwin" ? "open" : "xdg-open";
  const args = platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true, windowsHide: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // Best-effort only; the authorization URL is always printed for manual use.
  }
}

function page(title: string, message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>`
    + `<body><h1>${title}</h1><p>${message}</p><p>You can close this tab and return to the terminal.</p></body></html>`;
}

/** Loopback-only (127.0.0.1) one-shot callback listener with CSRF state verification. */
function waitForCallback(server: Server, expectedState: string, timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      finish(() => reject(new AppError(
        "SPOTIFY_AUTH_TIMEOUT",
        "Timed out waiting for the Spotify authorization redirect. Run the command again and approve access promptly.",
        504,
      )));
    }, timeoutMs);
    function finish(action: () => void): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      action();
    }
    server.on("request", (req, res) => {
      let url: URL;
      try {
        url = new URL(req.url ?? "/", "http://127.0.0.1");
      } catch {
        res.writeHead(400, { "Content-Type": "text/plain" }).end("Bad request");
        return;
      }
      if (url.pathname !== "/callback") {
        res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
        return;
      }
      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      // Verify the CSRF state before honoring anything else in the callback, including a
      // denial. Otherwise any local process that can reach this loopback listener could
      // terminate the flow (and inject arbitrary text into the error message) without
      // ever presenting the expected state token.
      if (!state || state !== expectedState) {
        res.writeHead(400, { "Content-Type": "text/html" }).end(page("Spotify authorization failed", "The redirect was missing or unexpected. Run the command again."));
        finish(() => reject(new AppError(
          "SPOTIFY_AUTH_STATE_MISMATCH",
          "The Spotify redirect was missing or did not match the expected authorization request. Run the command again.",
          400,
        )));
        return;
      }
      if (error) {
        res.writeHead(200, { "Content-Type": "text/html" }).end(page("Spotify authorization declined", "Access was not granted."));
        finish(() => reject(new AppError("SPOTIFY_AUTH_DENIED", "Spotify authorization was not granted.", 401)));
        return;
      }
      if (!code) {
        res.writeHead(400, { "Content-Type": "text/html" }).end(page("Spotify authorization failed", "The redirect was missing or unexpected. Run the command again."));
        finish(() => reject(new AppError(
          "SPOTIFY_AUTH_STATE_MISMATCH",
          "The Spotify redirect was missing or did not match the expected authorization request. Run the command again.",
          400,
        )));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" }).end(page("Spotify authorization complete", "Return to the terminal to finish."));
      finish(() => resolve(code));
    });
  });
}

interface ExchangeOptions {
  fetch: typeof fetch;
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
  timeoutMs?: number;
}

async function exchangeCode(options: ExchangeOptions): Promise<string> {
  let response: Response;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? TOKEN_EXCHANGE_TIMEOUT_MS);
  let payload: { refresh_token?: unknown } | null;
  try {
    try {
      response = await options.fetch(TOKEN_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${Buffer.from(`${options.clientId}:${options.clientSecret}`).toString("base64")}`,
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: options.code,
          redirect_uri: options.redirectUri,
          code_verifier: options.codeVerifier,
        }).toString(),
        redirect: "error",
        signal: controller.signal,
      });
    } catch {
      throw new AppError("SPOTIFY_AUTH_NETWORK", "Unable to reach Spotify to exchange the authorization code.", 502);
    }
    if (!response.ok) {
      throw new AppError(
        "SPOTIFY_AUTH_EXCHANGE_FAILED",
        "Spotify rejected the authorization code exchange. Run the command again and approve access again.",
        401,
      );
    }
    // Keep the abort timer active until the body has actually been consumed: fetch() resolving
    // only means headers arrived, and a response that stalls while streaming the body would
    // otherwise run unbounded despite the configured timeout.
    try {
      payload = (await response.json()) as typeof payload;
    } catch {
      if (controller.signal.aborted) {
        throw new AppError("SPOTIFY_AUTH_NETWORK", "Unable to reach Spotify to exchange the authorization code.", 502);
      }
      payload = null;
    }
  } finally {
    clearTimeout(timer);
  }
  if (!payload || typeof payload.refresh_token !== "string" || !payload.refresh_token) {
    throw new AppError(
      "SPOTIFY_AUTH_TOKEN_INVALID",
      "Spotify did not return a refresh token for this authorization.",
      502,
    );
  }
  return payload.refresh_token;
}

/** Atomically replaces only the SPOTIFY_REFRESH_TOKEN line in the local .env file. */
export async function updateEnvRefreshToken(envPath: string, refreshToken: string): Promise<void> {
  // A CR/LF in the token would let it inject additional lines into .env, which
  // process.loadEnvFile() would then parse as extra configuration. Fail closed instead.
  if (/[\r\n]/.test(refreshToken)) {
    throw new AppError(
      "SPOTIFY_AUTH_TOKEN_INVALID",
      "Spotify returned a refresh token containing a line break; refusing to write it to .env.",
      502,
    );
  }
  let text = "";
  try {
    text = await readFile(envPath, "utf8");
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const line = `SPOTIFY_REFRESH_TOKEN=${refreshToken}`;
  const pattern = /^#?[ \t]*SPOTIFY_REFRESH_TOKEN[ \t]*=.*$/m;
  // Use a replacer function, not the raw string form: String.prototype.replace treats
  // "$"-sequences (e.g. "$&", "$'", "$1") in a string replacement specially, which would
  // silently corrupt a refresh token containing one of those sequences.
  const updated = pattern.test(text)
    ? text.replace(pattern, () => line)
    : `${text.length > 0 && !text.endsWith("\n") ? `${text}\n` : text}${line}\n`;
  const directory = path.dirname(envPath);
  const temp = path.join(directory, `.env.${randomBytes(8).toString("hex")}.tmp`);
  let created = false;
  try {
    const handle = await open(temp, "wx", 0o600);
    created = true;
    try {
      await handle.writeFile(updated, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await replaceFile(temp, envPath);
  } catch (error) {
    // Clean up the temp file for any failure in the write-and-replace sequence, not just a
    // failed replaceFile, so a failed authorization never leaves a credential-bearing artifact
    // (e.g. a failed writeFile/sync that still left a partially-written temp file) behind. Only
    // unlink a file this call actually created; an "wx" open failure means nothing was written.
    if (created) await unlink(temp).catch(() => {});
    throw new AppError("SPOTIFY_AUTH_ENV_WRITE_FAILED", "The refresh token could not be saved to .env. Check file permissions and retry.", 500);
  }
}

export interface SpotifyAuthCliOptions {
  envPath: string;
  port: number;
  clientId: string;
  clientSecret: string;
  fetch?: typeof fetch;
  openBrowser?: (url: string) => void;
  log?: (message: string) => void;
  /** Overrides the token-exchange fetch timeout; intended for tests, defaults to TOKEN_EXCHANGE_TIMEOUT_MS. */
  tokenExchangeTimeoutMs?: number;
}

/** Runs a local Authorization Code with PKCE flow and saves only the refresh token to .env. */
export async function runSpotifyAuth(options: SpotifyAuthCliOptions): Promise<{ envPath: string }> {
  const log = options.log ?? ((message: string) => console.log(message));
  const fetcher = options.fetch ?? globalThis.fetch;
  const openBrowser = options.openBrowser ?? defaultOpenBrowser;

  const codeVerifier = randomBytes(64).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  const state = randomBytes(24).toString("base64url");

  const server = createServer();
  server.listen(options.port, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", (error) => reject(new AppError("SPOTIFY_AUTH_LISTEN_FAILED", `Could not start the local callback listener: ${errorMessage(error)}`, 500)));
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new AppError("SPOTIFY_AUTH_LISTEN_FAILED", "Could not determine the local callback listener's port.", 500);
  }
  const redirectUri = `http://127.0.0.1:${address.port}/callback`;

  const authorizeUrl = new URL(AUTHORIZE_URL);
  authorizeUrl.search = new URLSearchParams({
    client_id: options.clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    state,
    scope: SCOPES,
    code_challenge_method: "S256",
    code_challenge: codeChallenge,
  }).toString();

  log(`Redirect URI (must match your Spotify app dashboard): ${redirectUri}`);
  log("Open this URL to authorize Spotify access if your browser did not open automatically:");
  log(authorizeUrl.toString());
  openBrowser(authorizeUrl.toString());

  let code: string;
  try {
    code = await waitForCallback(server, state, CALLBACK_TIMEOUT_MS);
  } finally {
    server.close();
  }

  const refreshToken = await exchangeCode({
    fetch: fetcher, clientId: options.clientId, clientSecret: options.clientSecret, code, redirectUri, codeVerifier,
    ...(options.tokenExchangeTimeoutMs !== undefined ? { timeoutMs: options.tokenExchangeTimeoutMs } : {}),
  });

  await updateEnvRefreshToken(options.envPath, refreshToken);

  log("Spotify authorization succeeded.");
  log(`SPOTIFY_REFRESH_TOKEN was saved to ${options.envPath}.`);
  log("Restart any running app instance (for example npm start) to use it. Credential values are never printed.");
  return { envPath: options.envPath };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      port: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(HELP);
    return;
  }
  try {
    process.loadEnvFile();
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const clientId = process.env["SPOTIFY_CLIENT_ID"]?.trim() ?? "";
  const clientSecret = process.env["SPOTIFY_CLIENT_SECRET"]?.trim() ?? "";
  if (!clientId || !clientSecret) {
    throw new AppError(
      "SPOTIFY_AUTH_NOT_CONFIGURED",
      "Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in .env before running this command (see README.md, Connect Spotify). A refresh token is not required yet; this command produces it.",
      400,
    );
  }
  const portText = values.port ?? process.env["SPOTIFY_AUTH_PORT"] ?? String(DEFAULT_PORT);
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || !Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new AppError("SPOTIFY_AUTH_INVALID_PORT", "--port or SPOTIFY_AUTH_PORT must be between 1024 and 65535.", 400);
  }
  await runSpotifyAuth({ envPath: path.resolve(process.cwd(), ".env"), port, clientId, clientSecret });
}

const invokedDirectly = process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  void main().catch((error: unknown) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
}