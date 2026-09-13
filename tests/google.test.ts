import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  constructor: vi.fn(),
  verifier: vi.fn(),
  authUrl: vi.fn(),
  getToken: vi.fn(),
  setCredentials: vi.fn(),
  refresh: vi.fn(),
  revoke: vi.fn(),
}));

vi.mock("google-auth-library", () => ({
  CodeChallengeMethod: { S256: "S256" },
  OAuth2Client: class {
    constructor(options: unknown) { mocks.constructor(options); }
    generateCodeVerifierAsync = mocks.verifier;
    generateAuthUrl = mocks.authUrl;
    getToken = mocks.getToken;
    setCredentials = mocks.setCredentials;
    refreshAccessToken = mocks.refresh;
    revokeToken = mocks.revoke;
  },
}));

import { GoogleAuth } from "../src/auth/google.js";

const scope = "https://www.googleapis.com/auth/youtube.readonly";
const verifier = "a".repeat(64);
const challenge = createHash("sha256").update(verifier).digest("base64url");
const config = { installed: { client_id: "client-id", client_secret: "secret-client" } };
const freshTokens = () => ({
  access_token: "secret-access-token",
  refresh_token: "secret-refresh-token",
  expiry_date: Date.now() + 3_600_000,
  token_type: "Bearer",
  scope,
});
let directory: string;
let credentialsFile: string;
let tokenFile: string;
let auth: GoogleAuth;

async function saveTokens(tokens: unknown): Promise<void> {
  await mkdir(join(directory, "private"), { recursive: true });
  await writeFile(tokenFile, JSON.stringify(tokens));
}

beforeEach(async () => {
  vi.resetAllMocks();
  directory = await mkdtemp(join(tmpdir(), "music-google-test-"));
  credentialsFile = join(directory, "client.json");
  tokenFile = join(directory, "private", "token.json");
  auth = new GoogleAuth({ credentialsFile, tokenFile, redirectUri: "http://127.0.0.1:4242/oauth/callback" });
  mocks.verifier.mockResolvedValue({ codeVerifier: verifier, codeChallenge: challenge });
  mocks.authUrl.mockImplementation((options: Record<string, unknown>) => {
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    for (const [key, value] of Object.entries(options)) {
      url.searchParams.set(key, Array.isArray(value) ? value.join(" ") : String(value));
    }
    return url.toString();
  });
  mocks.getToken.mockResolvedValue({ tokens: freshTokens() });
  mocks.refresh.mockResolvedValue({ credentials: freshTokens() });
  mocks.revoke.mockResolvedValue({});
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("GoogleAuth configuration and PKCE", () => {
  it("reports absent configuration without exposing local paths", async () => {
    expect(await auth.status()).toEqual({ configured: false, connected: false });
    await expect(auth.begin()).rejects.toMatchObject({ code: "GOOGLE_NOT_CONFIGURED" });
    expect(mocks.constructor).not.toHaveBeenCalled();
  });

  it("reports configured but disconnected without contacting Google", async () => {
    await writeFile(credentialsFile, JSON.stringify(config));
    expect(await auth.status()).toEqual({ configured: true, connected: false });
    expect(mocks.getToken).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it.each([
    "malformed stale token data",
    JSON.stringify({ refresh_token: 42 }),
    JSON.stringify(freshTokens()),
  ])("shows setup when client configuration is missing despite a leftover token file %#", async (source) => {
    await mkdir(join(directory, "private"), { recursive: true });
    await writeFile(tokenFile, source);
    expect(await auth.status()).toEqual({ configured: false, connected: false });
    expect(await readFile(tokenFile, "utf8")).toBe(source);
    expect(mocks.constructor).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it.each([
    "not JSON secret-client",
    JSON.stringify({ web: { client_id: "web-id", client_secret: "secret-web-client" } }),
    JSON.stringify({ installed: { client_id: "client-id" } }),
    JSON.stringify({ installed: { client_id: "", client_secret: "secret-client" } }),
  ])("makes malformed existing configuration visible and redacts it %#", async (source) => {
    await writeFile(credentialsFile, source);
    const error = await auth.status().catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "GOOGLE_CONFIG_INVALID", message: expect.stringContaining("Desktop app") });
    expect(String(error)).not.toContain("secret-client");
    expect(String(error)).not.toContain("secret-web-client");
    expect(String(error)).not.toContain(directory);
  });

  it("requests exactly read-only scope, offline consent and S256 PKCE with independent random state", async () => {
    await writeFile(credentialsFile, JSON.stringify(config));
    const first = await auth.begin();
    const second = await auth.begin();
    expect(first.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second.state).not.toBe(first.state);
    expect(first.codeVerifier).toBe(verifier);
    expect(mocks.verifier).toHaveBeenCalledTimes(2);
    expect(mocks.authUrl).toHaveBeenCalledWith({
      access_type: "offline",
      prompt: "consent",
      scope: [scope],
      state: first.state,
      code_challenge_method: "S256",
      code_challenge: challenge,
      include_granted_scopes: false,
    });
    expect(mocks.constructor).toHaveBeenCalledWith({
      clientId: "client-id",
      clientSecret: "secret-client",
      redirectUri: "http://127.0.0.1:4242/oauth/callback",
      transporterOptions: { timeout: 20_000, maxRedirects: 0 },
    });
    expect(first.url).not.toContain("secret-client");
    expect(first.url).not.toContain(verifier);
    expect(new URL(first.url).searchParams.get("scope")).toBe(scope);
    await expect(readFile(tokenFile)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("GoogleAuth offline credentials and refresh", () => {
  beforeEach(async () => {
    await writeFile(credentialsFile, JSON.stringify(config));
  });

  it("persists only successful credentials atomically and restricts file permissions", async () => {
    await auth.complete("authorization-code", verifier);
    expect(mocks.getToken).toHaveBeenCalledWith({
      code: "authorization-code",
      codeVerifier: verifier,
      redirect_uri: "http://127.0.0.1:4242/oauth/callback",
    });
    expect(JSON.parse(await readFile(tokenFile, "utf8"))).toMatchObject({
      refresh_token: "secret-refresh-token", access_token: "secret-access-token", scope,
    });
    expect(await readdir(join(directory, "private"))).toEqual(["token.json"]);
    if (process.platform !== "win32") {
      expect((await stat(tokenFile)).mode & 0o777).toBe(0o600);
      expect((await stat(join(directory, "private"))).mode & 0o777).toBe(0o700);
    }
    expect(await auth.status()).toEqual({ configured: true, connected: true });
    expect(await auth.getAccessToken()).toBe("secret-access-token");
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("never writes credentials when code exchange fails and does not expose Google error details", async () => {
    mocks.getToken.mockRejectedValue(new Error("secret-client secret-refresh-token fetch body"));
    const error = await auth.complete("code", verifier).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "GOOGLE_AUTH_EXCHANGE_FAILED" });
    expect(String(error)).not.toContain("secret");
    await expect(readFile(tokenFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves existing credentials when reconnect returns no refresh token", async () => {
    const original = freshTokens();
    await saveTokens(original);
    mocks.getToken.mockResolvedValue({ tokens: { access_token: "new-access", expiry_date: Date.now() + 3600_000, scope } });
    await expect(auth.complete("code", verifier)).rejects.toMatchObject({ code: "GOOGLE_AUTH_TOKEN_INVALID" });
    expect(JSON.parse(await readFile(tokenFile, "utf8"))).toEqual(original);
  });

  it("rejects missing PKCE before exchange", async () => {
    await expect(auth.complete("code", "")).rejects.toMatchObject({ code: "GOOGLE_AUTH_INVALID" });
    expect(mocks.getToken).not.toHaveBeenCalled();
  });

  it("serializes concurrent refreshes and persists refreshed credentials before returning access", async () => {
    await saveTokens({ ...freshTokens(), expiry_date: Date.now() - 1 });
    mocks.refresh.mockResolvedValue({ credentials: {
      access_token: "new-access",
      expiry_date: Date.now() + 3600_000,
      token_type: "Bearer",
    } });
    expect(await Promise.all([auth.getAccessToken(), auth.getAccessToken(), auth.getAccessToken()]))
      .toEqual(["new-access", "new-access", "new-access"]);
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(mocks.setCredentials).toHaveBeenCalledWith(expect.objectContaining({ refresh_token: "secret-refresh-token" }));
    expect(JSON.parse(await readFile(tokenFile, "utf8"))).toMatchObject({
      access_token: "new-access",
      refresh_token: "secret-refresh-token",
      scope,
    });
    const restarted = new GoogleAuth({ credentialsFile, tokenFile, redirectUri: "http://127.0.0.1:4242/oauth/callback" });
    expect(await restarted.getAccessToken()).toBe("new-access");
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it("persists refresh-token rotation", async () => {
    await saveTokens({ ...freshTokens(), expiry_date: 0 });
    mocks.refresh.mockResolvedValue({ credentials: { ...freshTokens(), refresh_token: "rotated-refresh" } });
    await auth.getAccessToken();
    expect(JSON.parse(await readFile(tokenFile, "utf8")).refresh_token).toBe("rotated-refresh");
  });

  it("refreshes a token when expiry metadata is absent rather than assuming validity", async () => {
    await saveTokens({ refresh_token: "refresh", access_token: "possibly-expired", scope });
    expect(await auth.getAccessToken()).toBe("secret-access-token");
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it("surfaces invalid_grant safely and allows later calls after failure", async () => {
    const original = { ...freshTokens(), expiry_date: 0 };
    await saveTokens(original);
    mocks.refresh.mockRejectedValueOnce(new Error("invalid_grant secret-refresh-token"));
    const error = await auth.getAccessToken().catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "GOOGLE_REFRESH_FAILED" });
    expect(String(error)).not.toContain("secret");
    expect(JSON.parse(await readFile(tokenFile, "utf8"))).toEqual(original);
    expect(await auth.getAccessToken()).toBe("secret-access-token");
  });

  it("does not persist a malformed successful refresh", async () => {
    const original = { ...freshTokens(), expiry_date: 0 };
    await saveTokens(original);
    mocks.refresh.mockResolvedValue({ credentials: { access_token: "new-access", expiry_date: 0 } });
    await expect(auth.getAccessToken()).rejects.toMatchObject({ code: "GOOGLE_REFRESH_INVALID" });
    expect(JSON.parse(await readFile(tokenFile, "utf8"))).toEqual(original);
  });

  it.each([
    "not JSON secret-refresh-token",
    JSON.stringify({}),
    JSON.stringify({ refresh_token: 123 }),
    JSON.stringify({ refresh_token: "" }),
    JSON.stringify({ refresh_token: "secret-refresh-token", expiry_date: "tomorrow" }),
    JSON.stringify({ refresh_token: "secret-refresh-token", scope: "https://www.googleapis.com/auth/youtube" }),
    JSON.stringify({ refresh_token: "secret-refresh-token", scope: `${scope} another-scope` }),
  ])("makes malformed on-disk token failures visible in status and access %#", async (source) => {
    await mkdir(join(directory, "private"));
    await writeFile(tokenFile, source);
    const error = await auth.status().catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "GOOGLE_TOKEN_INVALID" });
    expect(String(error)).not.toContain("secret");
    await expect(auth.getAccessToken()).rejects.toMatchObject({ code: "GOOGLE_TOKEN_INVALID" });
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("reports a persistence failure without exposing credentials", async () => {
    await mkdir(tokenFile, { recursive: true });
    const error = await auth.complete("code", verifier).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "GOOGLE_TOKEN_WRITE_FAILED" });
    expect(String(error)).not.toContain("secret");
    expect(await readdir(join(directory, "private"))).toEqual(["token.json"]);
  });
});

describe("GoogleAuth disconnect", () => {
  beforeEach(async () => {
    await writeFile(credentialsFile, JSON.stringify(config));
    await saveTokens(freshTokens());
  });

  it("revokes the refresh token and removes local credentials", async () => {
    await auth.disconnect();
    expect(mocks.revoke).toHaveBeenCalledWith("secret-refresh-token");
    await expect(readFile(tokenFile)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await auth.status()).toEqual({ configured: true, connected: false });
    await auth.disconnect();
    expect(mocks.revoke).toHaveBeenCalledTimes(1);
  });

  it("surfaces revocation failure and explains that local credentials were removed", async () => {
    mocks.revoke.mockRejectedValue(new Error("network secret-client secret-refresh-token"));
    const error = await auth.disconnect().catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "GOOGLE_REVOKE_FAILED" });
    expect(String(error)).toContain("Local credentials were removed");
    expect(String(error)).toContain("Google Account permissions");
    expect(String(error)).not.toContain("secret");
    await expect(readFile(tokenFile)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await auth.status()).toEqual({ configured: true, connected: false });
  });

  it("serializes disconnect after a concurrent refresh so credentials cannot reappear", async () => {
    await saveTokens({ ...freshTokens(), expiry_date: 0 });
    const token = auth.getAccessToken();
    const disconnected = auth.disconnect();
    await expect(token).resolves.toBe("secret-access-token");
    await disconnected;
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    await expect(readFile(tokenFile)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(auth.getAccessToken()).rejects.toMatchObject({ code: "GOOGLE_NOT_CONNECTED" });
  });
});
