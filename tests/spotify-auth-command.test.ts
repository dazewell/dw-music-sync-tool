import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runSpotifyAuth, updateEnvRefreshToken } from "../src/spotify-auth-cli.js";

const execute = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const directory = await mkdtemp(path.join(process.cwd(), `.test-spotify-auth-${randomUUID()}-`));
  directories.push(directory);
  return directory;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** Simulates the browser: extracts the authorize URL's redirect_uri/state and hits the loopback callback. */
function driveCallback(authorizeUrl: string, overrides: Partial<{ code: string; state: string; error: string }> = {}): void {
  const parsed = new URL(authorizeUrl);
  const redirectUri = new URL(parsed.searchParams.get("redirect_uri")!);
  const state = overrides.state ?? parsed.searchParams.get("state")!;
  const callbackUrl = new URL(redirectUri.toString());
  if (overrides.error) {
    callbackUrl.searchParams.set("error", overrides.error);
  } else {
    callbackUrl.searchParams.set("code", overrides.code ?? "auth-code-123");
    callbackUrl.searchParams.set("state", state);
  }
  http.get(callbackUrl, (res) => res.resume());
}

describe("runSpotifyAuth", () => {
  it("completes a PKCE loopback exchange and writes only SPOTIFY_REFRESH_TOKEN to .env", async () => {
    const directory = await tempDir();
    const envPath = path.join(directory, ".env");
    await writeFile(envPath, "MUSIC_PORT=8787\nSPOTIFY_CLIENT_ID=abc\nSPOTIFY_CLIENT_SECRET=def\n", "utf8");
    const fetchMock = vi.fn(async () => jsonResponse(200, { access_token: "short-lived", expires_in: 3600, refresh_token: "brand-new-refresh-token" }));
    const logs: string[] = [];
    const openBrowser = vi.fn((url: string) => driveCallback(url));

    await runSpotifyAuth({
      envPath, port: 0, clientId: "abc", clientSecret: "def",
      fetch: fetchMock as unknown as typeof fetch, openBrowser, log: (message) => logs.push(message),
    });

    expect(openBrowser).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://accounts.spotify.com/api/token");
    expect((init as RequestInit).headers).toMatchObject({ Authorization: expect.stringMatching(/^Basic /) });
    expect(String((init as RequestInit).body)).toContain("grant_type=authorization_code");
    expect(String((init as RequestInit).body)).toContain("code_verifier=");

    const updatedEnv = await readFile(envPath, "utf8");
    expect(updatedEnv).toContain("SPOTIFY_REFRESH_TOKEN=brand-new-refresh-token");
    expect(updatedEnv).toContain("SPOTIFY_CLIENT_ID=abc");
    expect(updatedEnv).toContain("SPOTIFY_CLIENT_SECRET=def");
    expect(logs.join("\n")).not.toContain("brand-new-refresh-token");
    expect(logs.join("\n")).not.toContain("def");
  });

  it("rejects with a state-mismatch error and writes nothing when the callback state does not match", async () => {
    const directory = await tempDir();
    const envPath = path.join(directory, ".env");
    await writeFile(envPath, "SPOTIFY_CLIENT_ID=abc\nSPOTIFY_CLIENT_SECRET=def\n", "utf8");
    const fetchMock = vi.fn();
    const openBrowser = vi.fn((url: string) => driveCallback(url, { state: "wrong-state" }));

    await expect(runSpotifyAuth({
      envPath, port: 0, clientId: "abc", clientSecret: "def",
      fetch: fetchMock as unknown as typeof fetch, openBrowser, log: () => {},
    })).rejects.toMatchObject({ code: "SPOTIFY_AUTH_STATE_MISMATCH" });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(await readFile(envPath, "utf8")).not.toContain("SPOTIFY_REFRESH_TOKEN");
  });

  it("rejects with an actionable error when the user denies access", async () => {
    const directory = await tempDir();
    const envPath = path.join(directory, ".env");
    await writeFile(envPath, "SPOTIFY_CLIENT_ID=abc\nSPOTIFY_CLIENT_SECRET=def\n", "utf8");
    const openBrowser = vi.fn((url: string) => driveCallback(url, { error: "access_denied" }));

    await expect(runSpotifyAuth({
      envPath, port: 0, clientId: "abc", clientSecret: "def",
      fetch: vi.fn() as unknown as typeof fetch, openBrowser, log: () => {},
    })).rejects.toMatchObject({ code: "SPOTIFY_AUTH_DENIED" });
  });

  it("fails closed with an actionable error when Spotify rejects the code exchange", async () => {
    const directory = await tempDir();
    const envPath = path.join(directory, ".env");
    await writeFile(envPath, "SPOTIFY_CLIENT_ID=abc\nSPOTIFY_CLIENT_SECRET=def\n", "utf8");
    const fetchMock = vi.fn(async () => jsonResponse(400, { error: "invalid_grant" }));
    const openBrowser = vi.fn((url: string) => driveCallback(url));

    await expect(runSpotifyAuth({
      envPath, port: 0, clientId: "abc", clientSecret: "def",
      fetch: fetchMock as unknown as typeof fetch, openBrowser, log: () => {},
    })).rejects.toMatchObject({ code: "SPOTIFY_AUTH_EXCHANGE_FAILED" });

    expect(await readFile(envPath, "utf8")).not.toContain("SPOTIFY_REFRESH_TOKEN");
  });

  it("rejects when Spotify's response omits a refresh token", async () => {
    const directory = await tempDir();
    const envPath = path.join(directory, ".env");
    await writeFile(envPath, "SPOTIFY_CLIENT_ID=abc\nSPOTIFY_CLIENT_SECRET=def\n", "utf8");
    const fetchMock = vi.fn(async () => jsonResponse(200, { access_token: "short-lived", expires_in: 3600 }));
    const openBrowser = vi.fn((url: string) => driveCallback(url));

    await expect(runSpotifyAuth({
      envPath, port: 0, clientId: "abc", clientSecret: "def",
      fetch: fetchMock as unknown as typeof fetch, openBrowser, log: () => {},
    })).rejects.toMatchObject({ code: "SPOTIFY_AUTH_TOKEN_INVALID" });
  });
});

describe("updateEnvRefreshToken", () => {
  it("uncomments and replaces an existing SPOTIFY_REFRESH_TOKEN line in place", async () => {
    const directory = await tempDir();
    const envPath = path.join(directory, ".env");
    await writeFile(envPath, "MUSIC_PORT=8787\n#SPOTIFY_REFRESH_TOKEN=\nGOOGLE_CLIENT_SECRET_FILE=.local/client-secret.json\n", "utf8");
    await updateEnvRefreshToken(envPath, "new-token-value");
    const text = await readFile(envPath, "utf8");
    expect(text).toBe("MUSIC_PORT=8787\nSPOTIFY_REFRESH_TOKEN=new-token-value\nGOOGLE_CLIENT_SECRET_FILE=.local/client-secret.json\n");
  });

  it("appends the line when SPOTIFY_REFRESH_TOKEN is absent, creating .env if missing", async () => {
    const directory = await tempDir();
    const envPath = path.join(directory, ".env");
    await updateEnvRefreshToken(envPath, "fresh-token");
    expect(await readFile(envPath, "utf8")).toBe("SPOTIFY_REFRESH_TOKEN=fresh-token\n");
  });

  it("replaces only the token value, leaving unrelated variables and comments untouched", async () => {
    const directory = await tempDir();
    const envPath = path.join(directory, ".env");
    await writeFile(envPath, "SPOTIFY_CLIENT_ID=abc\nSPOTIFY_REFRESH_TOKEN=old-value\nSPOTIFY_CLIENT_SECRET=def\n", "utf8");
    await updateEnvRefreshToken(envPath, "rotated-value");
    expect(await readFile(envPath, "utf8")).toBe("SPOTIFY_CLIENT_ID=abc\nSPOTIFY_REFRESH_TOKEN=rotated-value\nSPOTIFY_CLIENT_SECRET=def\n");
  });
});

describe("spotify-auth CLI entry point", () => {
  it("prints help without requiring configuration or network access", async () => {
    const { stdout } = await execute(process.execPath, [
      "--import=tsx", path.resolve("src", "spotify-auth-cli.ts"), "--help",
    ], { timeout: 15_000 });
    expect(stdout).toContain("npm run spotify-auth");
    expect(stdout).toContain("SPOTIFY_CLIENT_ID");
  });

  it("fails closed with an actionable error when SPOTIFY_CLIENT_ID/SECRET are not configured", async () => {
    const directory = await tempDir();
    await mkdir(directory, { recursive: true });
    const env = { ...process.env };
    delete env.SPOTIFY_CLIENT_ID;
    delete env.SPOTIFY_CLIENT_SECRET;
    await expect(execute(process.execPath, [
      "--import=tsx", path.resolve("src", "spotify-auth-cli.ts"),
    ], { cwd: directory, env, timeout: 15_000 })).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("SPOTIFY_CLIENT_ID"),
    });
  });
});