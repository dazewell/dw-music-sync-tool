import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  constructor: vi.fn(),
  verifier: vi.fn(),
  authUrl: vi.fn(),
  getToken: vi.fn(),
  tokenInfo: vi.fn(),
  setCredentials: vi.fn(),
  refresh: vi.fn(),
  revoke: vi.fn(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, unlink: vi.fn(actual.unlink), open: vi.fn(actual.open), rename: vi.fn(actual.rename) };
});

vi.mock("google-auth-library", () => ({
  CodeChallengeMethod: { S256: "S256" },
  OAuth2Client: class {
    constructor(options: unknown) { mocks.constructor(options); }
    generateCodeVerifierAsync = mocks.verifier;
    generateAuthUrl = mocks.authUrl;
    getToken = mocks.getToken;
    getTokenInfo = mocks.tokenInfo;
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

async function savePending(filename: string, tokens = freshTokens()) {
  const info = await fs.lstat(tokenFile, { bigint: true }).catch(error => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  const value = {
    ...tokens,
    _saveIntent: {
      version: 1,
      tokenFile: "token.json",
      destination: info === null ? null : {
        dev: String(info.dev), ino: String(info.ino), size: String(info.size),
        mtimeNs: String(info.mtimeNs), ctimeNs: String(info.ctimeNs),
      },
    },
  };
  await writeFile(filename, JSON.stringify(value));
  return value;
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
  mocks.tokenInfo.mockResolvedValue({ scopes: [scope] });
  mocks.refresh.mockResolvedValue({ credentials: freshTokens() });
  mocks.revoke.mockResolvedValue({});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

describe("interrupted Google credential saves", () => {
  const pendingPath = (digit = "a") => `${tokenFile}.${digit.repeat(24)}.pending`;

  beforeEach(async () => {
    await writeFile(credentialsFile, JSON.stringify(config));
    await mkdir(join(directory, "private"));
  });

  it("recovers a fully flushed pending token before reporting connection status", async () => {
    const tokens = await savePending(pendingPath());
    expect(await auth.status()).toEqual({ configured: true, connected: true });
    expect(JSON.parse(await readFile(tokenFile, "utf8"))).toEqual(tokens);
    expect(await readdir(join(directory, "private"))).toEqual(["token.json"]);
    expect(mocks.getToken).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("finishes a pending refresh-token rotation before using the previous token", async () => {
    await saveTokens(freshTokens());
    await savePending(pendingPath(), { ...freshTokens(), access_token: "new-access", refresh_token: "rotated" });
    expect(await auth.getAccessToken()).toBe("new-access");
    expect(JSON.parse(await readFile(tokenFile, "utf8")).refresh_token).toBe("rotated");
  });

  it("revokes and removes an orphan even when the main token was never published", async () => {
    await writeFile(pendingPath(), JSON.stringify(freshTokens()));
    await auth.disconnect();
    expect(mocks.revoke).toHaveBeenCalledWith("secret-refresh-token");
    expect(await readdir(join(directory, "private"))).toEqual([]);
  });

  it("rejects ambiguous recovery but disconnect can revoke every validated intent", async () => {
    await saveTokens(freshTokens());
    await writeFile(pendingPath(), JSON.stringify({ ...freshTokens(), refresh_token: "first" }));
    await writeFile(pendingPath("b"), JSON.stringify({ ...freshTokens(), refresh_token: "second" }));
    await expect(auth.status()).rejects.toMatchObject({ code: "GOOGLE_PENDING_CLEANUP_FAILED" });
    await auth.disconnect();
    expect(mocks.revoke.mock.calls.map(call => call[0]).sort()).toEqual(["first", "second", "secret-refresh-token"]);
    expect(await readdir(join(directory, "private"))).toEqual([]);
  });

  it("keeps remote revocation failures explicit while removing all local credentials", async () => {
    await writeFile(pendingPath(), JSON.stringify(freshTokens()));
    mocks.revoke.mockRejectedValue(new Error("secret-refresh-token remote details"));
    const error = await auth.disconnect().catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "GOOGLE_REVOKE_FAILED" });
    expect(String(error)).not.toContain("secret-refresh-token");
    expect(await readdir(join(directory, "private"))).toEqual([]);
  });

  it.each([
    "partial secret-refresh-token",
    JSON.stringify({ ...freshTokens(), unrelated: "user data" }),
    JSON.stringify({ ...freshTokens(), scope: "https://www.googleapis.com/auth/youtube" }),
  ])("preserves unprovable pending data and never reports a successful disconnect %#", async (source) => {
    await writeFile(pendingPath(), source);
    await expect(auth.status()).rejects.toMatchObject({ code: "GOOGLE_PENDING_CLEANUP_FAILED" });
    const error = await auth.disconnect().catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "GOOGLE_PENDING_CLEANUP_FAILED" });
    expect(String(error)).not.toContain("secret-refresh-token");
    expect(await readFile(pendingPath(), "utf8")).toBe(source);
    expect(mocks.revoke).not.toHaveBeenCalled();
  });

  it("preserves hard-linked pending credentials", async () => {
    const external = join(directory, "external.json");
    const source = JSON.stringify(freshTokens());
    await writeFile(external, source);
    await fs.link(external, pendingPath());
    await expect(auth.disconnect()).rejects.toMatchObject({ code: "GOOGLE_PENDING_CLEANUP_FAILED" });
    expect(await readFile(external, "utf8")).toBe(source);
    expect(await readFile(pendingPath(), "utf8")).toBe(source);
  });

  it("does not follow a pending directory junction or overwrite a linked target", async () => {
    const external = join(directory, "external");
    await mkdir(external);
    await fs.symlink(external, pendingPath(), "junction");
    await expect(auth.status()).rejects.toMatchObject({ code: "GOOGLE_PENDING_CLEANUP_FAILED" });
    expect((await fs.lstat(pendingPath())).isSymbolicLink()).toBe(true);
  });

  it("keeps unrelated pending-like filenames untouched", async () => {
    await writeFile(`${tokenFile}.notes.pending`, "user notes");
    await writeFile(join(directory, "private", `other.json.${"a".repeat(24)}.pending`), "other app data");
    await auth.disconnect();
    expect(await readdir(join(directory, "private"))).toHaveLength(2);
    expect(mocks.revoke).not.toHaveBeenCalled();
  });

  it("reports changed pending files rather than unlinking them or hiding remaining credentials", async () => {
    await saveTokens(freshTokens());
    await writeFile(pendingPath(), JSON.stringify(freshTokens()));
    mocks.revoke.mockImplementation(async () => { await writeFile(pendingPath(), "replacement user content"); });
    await expect(auth.disconnect()).rejects.toMatchObject({ code: "GOOGLE_DISCONNECT_LOCAL_FAILED" });
    expect(await readFile(pendingPath(), "utf8")).toBe("replacement user content");
    await expect(readFile(tokenFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not report success if local pending cleanup fails", async () => {
    await writeFile(pendingPath(), JSON.stringify(freshTokens()));
    vi.mocked(fs.unlink).mockRejectedValueOnce(new Error("synthetic permissions failure"));
    await expect(auth.disconnect()).rejects.toMatchObject({ code: "GOOGLE_DISCONNECT_LOCAL_FAILED" });
    expect(await readFile(pendingPath(), "utf8")).toContain("secret-refresh-token");
  });

  it("does not skip the main token after a pending file disappears during revocation", async () => {
    await saveTokens(freshTokens());
    await writeFile(pendingPath(), JSON.stringify(freshTokens()));
    mocks.revoke.mockImplementation(async () => { await fs.unlink(pendingPath()); });
    await expect(auth.disconnect()).rejects.toMatchObject({ code: "GOOGLE_DISCONNECT_LOCAL_FAILED" });
    await expect(readFile(tokenFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["replaced", "modified", "removed"] as const)("preserves pending and destination when the original target was %s", async change => {
    await saveTokens(freshTokens());
    const pending = await savePending(pendingPath());
    if (change === "replaced") {
      await fs.rename(tokenFile, join(directory, "old.json"));
      await saveTokens({ ...freshTokens(), refresh_token: "newer-account" });
    } else if (change === "modified") {
      await fs.appendFile(tokenFile, " ");
    } else {
      await fs.unlink(tokenFile);
    }
    const target = change === "removed" ? null : await readFile(tokenFile, "utf8");
    await expect(auth.status()).rejects.toMatchObject({ code: "GOOGLE_PENDING_CLEANUP_FAILED" });
    expect(JSON.parse(await readFile(pendingPath(), "utf8"))).toEqual(pending);
    if (target === null) await expect(readFile(tokenFile)).rejects.toMatchObject({ code: "ENOENT" });
    else expect(await readFile(tokenFile, "utf8")).toBe(target);
    expect(mocks.revoke).not.toHaveBeenCalled();
  });

  it("does not overwrite a destination created after an originally missing target", async () => {
    const pending = await savePending(pendingPath());
    await saveTokens({ ...freshTokens(), refresh_token: "newer-account" });
    const target = await readFile(tokenFile, "utf8");
    await expect(auth.getAccessToken()).rejects.toMatchObject({ code: "GOOGLE_PENDING_CLEANUP_FAILED" });
    expect(await readFile(tokenFile, "utf8")).toBe(target);
    expect(JSON.parse(await readFile(pendingPath(), "utf8"))).toEqual(pending);
  });

  it("requires inspection for legacy unbound intents but can disconnect them", async () => {
    const source = JSON.stringify(freshTokens());
    await writeFile(pendingPath(), source);
    await expect(auth.status()).rejects.toMatchObject({ code: "GOOGLE_PENDING_CLEANUP_FAILED" });
    expect(await readFile(pendingPath(), "utf8")).toBe(source);
    await expect(readFile(tokenFile)).rejects.toMatchObject({ code: "ENOENT" });
    await auth.disconnect();
    expect(mocks.revoke).toHaveBeenCalledWith("secret-refresh-token");
    await expect(readFile(pendingPath())).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["malformed", "hard-linked", "directory", "unreadable"] as const)(
    "cleans validated pending tokens while preserving/reporting a %s main file",
    async kind => {
      await writeFile(pendingPath(), JSON.stringify(freshTokens()));
      if (kind === "directory") await mkdir(tokenFile);
      else {
        await writeFile(tokenFile, kind === "malformed" ? "user content" : JSON.stringify(freshTokens()));
        if (kind === "hard-linked") await fs.link(tokenFile, join(directory, "external.json"));
        if (kind === "unreadable") vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
          const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
          const handle = await actual.open(...args);
          vi.mocked(fs.open).mockRejectedValueOnce(new Error("synthetic main permission error"));
          return handle;
        });
      }
      const original = kind === "directory" ? null : await readFile(tokenFile, "utf8");
      await expect(auth.disconnect()).rejects.toMatchObject({ code: "GOOGLE_DISCONNECT_LOCAL_FAILED" });
      expect(mocks.revoke).toHaveBeenCalledExactlyOnceWith("secret-refresh-token");
      await expect(readFile(pendingPath())).rejects.toMatchObject({ code: "ENOENT" });
      if (kind === "directory") expect((await fs.lstat(tokenFile)).isDirectory()).toBe(true);
      else expect(await readFile(tokenFile, "utf8")).toBe(original);
    },
  );

  it("reports both an unreadable main token and remote failure after cleaning validated pending data", async () => {
    await writeFile(tokenFile, "malformed main secret");
    await writeFile(pendingPath(), JSON.stringify(freshTokens()));
    mocks.revoke.mockRejectedValue(new Error("remote secret-refresh-token"));
    const error = await auth.disconnect().catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "GOOGLE_DISCONNECT_LOCAL_FAILED" });
    expect(String(error)).toContain("revocation failed");
    expect(String(error)).toContain("could not be inspected");
    expect(String(error)).not.toContain("secret");
    await expect(readFile(pendingPath())).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(tokenFile, "utf8")).toBe("malformed main secret");
  });

  it("reports both invalid credential sources when nothing can be safely revoked", async () => {
    await writeFile(tokenFile, "malformed main");
    await writeFile(pendingPath(), "malformed pending");
    await expect(auth.disconnect()).rejects.toMatchObject({
      code: "GOOGLE_DISCONNECT_LOCAL_FAILED", message: expect.stringContaining("main and pending"),
    });
    expect(mocks.revoke).not.toHaveBeenCalled();
    expect(await readFile(tokenFile, "utf8")).toBe("malformed main");
    expect(await readFile(pendingPath(), "utf8")).toBe("malformed pending");
  });

  it("continues independent cleanup after an invalid or undeletable pending file", async () => {
    await saveTokens(freshTokens());
    await writeFile(pendingPath(), "unprovable user data");
    await writeFile(pendingPath("b"), JSON.stringify({ ...freshTokens(), refresh_token: "second" }));
    await writeFile(pendingPath("c"), JSON.stringify({ ...freshTokens(), refresh_token: "third" }));
    vi.mocked(fs.unlink).mockRejectedValueOnce(new Error("synthetic cleanup failure"));
    await expect(auth.disconnect()).rejects.toMatchObject({ code: "GOOGLE_DISCONNECT_LOCAL_FAILED" });
    expect(mocks.revoke.mock.calls.map(call => call[0]).sort()).toEqual(["second", "secret-refresh-token", "third"]);
    expect(await readFile(pendingPath(), "utf8")).toBe("unprovable user data");
    expect(await readdir(join(directory, "private"))).toHaveLength(2);
    await expect(readFile(tokenFile)).rejects.toMatchObject({ code: "ENOENT" });
  });
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
    expect(mocks.tokenInfo).not.toHaveBeenCalled();
  });

  it("never writes credentials when code exchange fails and does not expose Google error details", async () => {
    mocks.getToken.mockRejectedValue(new Error("secret-client secret-refresh-token fetch body"));
    const error = await auth.complete("code", verifier).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "GOOGLE_AUTH_EXCHANGE_FAILED" });
    expect(String(error)).not.toContain("secret");
    await expect(readFile(tokenFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("verifies omitted exchange scopes with Google before persisting them", async () => {
    const { scope: _scope, ...credentials } = freshTokens();
    mocks.getToken.mockResolvedValue({ tokens: credentials });
    await auth.complete("authorization-code", verifier);
    expect(mocks.tokenInfo).toHaveBeenCalledWith("secret-access-token");
    expect(JSON.parse(await readFile(tokenFile, "utf8")).scope).toBe(scope);
    expect(await auth.status()).toEqual({ configured: true, connected: true });
  });

  it.each([
    { scopes: [] },
    { scopes: ["https://www.googleapis.com/auth/youtube"] },
    { scopes: [scope, "another-scope"] },
  ])(
    "does not infer read-only access when Google reports $scopes",
    async ({ scopes }) => {
      const { scope: _scope, ...credentials } = freshTokens();
      const original = freshTokens();
      await saveTokens(original);
      mocks.getToken.mockResolvedValue({ tokens: credentials });
      mocks.tokenInfo.mockResolvedValue({ scopes });
      await expect(auth.complete("authorization-code", verifier)).rejects.toMatchObject({ code: "GOOGLE_AUTH_TOKEN_INVALID" });
      expect(JSON.parse(await readFile(tokenFile, "utf8"))).toEqual(original);
    },
  );

  it("redacts token-info failures without replacing existing authorization", async () => {
    const { scope: _scope, ...credentials } = freshTokens();
    const original = freshTokens();
    await saveTokens(original);
    mocks.getToken.mockResolvedValue({ tokens: credentials });
    mocks.tokenInfo.mockRejectedValue(new Error("secret-access-token network details"));
    const error = await auth.complete("authorization-code", verifier).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "GOOGLE_AUTH_SCOPE_UNVERIFIED" });
    expect(String(error)).not.toContain("secret-access-token");
    expect(JSON.parse(await readFile(tokenFile, "utf8"))).toEqual(original);
  });

  it("rejects a persisted token with absent scope without asking Google or revoking it", async () => {
    const { scope: _scope, ...credentials } = freshTokens();
    await saveTokens(credentials);
    for (const operation of [() => auth.status(), () => auth.getAccessToken(), () => auth.disconnect()]) {
      await expect(operation()).rejects.toMatchObject({ code: "GOOGLE_TOKEN_INVALID" });
    }
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.tokenInfo).not.toHaveBeenCalled();
    expect(mocks.revoke).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(tokenFile, "utf8"))).toEqual(credentials);
  });

  it("preserves a pending token with absent scope instead of trusting it", async () => {
    const { scope: _scope, ...credentials } = freshTokens();
    const pending = `${tokenFile}.${"a".repeat(24)}.pending`;
    await mkdir(join(directory, "private"));
    await writeFile(pending, JSON.stringify(credentials));
    await expect(auth.status()).rejects.toMatchObject({ code: "GOOGLE_PENDING_CLEANUP_FAILED" });
    await expect(auth.disconnect()).rejects.toMatchObject({ code: "GOOGLE_PENDING_CLEANUP_FAILED" });
    expect(JSON.parse(await readFile(pending, "utf8"))).toEqual(credentials);
    expect(mocks.revoke).not.toHaveBeenCalled();
    expect(mocks.tokenInfo).not.toHaveBeenCalled();
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

  it.each([null, "", `${scope} another-scope`])("rejects an explicitly invalid refresh scope %j", async refreshScope => {
    const original = { ...freshTokens(), expiry_date: 0 };
    await saveTokens(original);
    mocks.refresh.mockResolvedValue({ credentials: { ...freshTokens(), scope: refreshScope } });
    await expect(auth.getAccessToken()).rejects.toMatchObject({ code: "GOOGLE_REFRESH_INVALID" });
    expect(JSON.parse(await readFile(tokenFile, "utf8"))).toEqual(original);
    expect(mocks.tokenInfo).not.toHaveBeenCalled();
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

describe("main credential file ownership", () => {
  beforeEach(async () => {
    await writeFile(credentialsFile, JSON.stringify(config));
    await mkdir(join(directory, "private"));
  });

  it("does not accept or revoke a hard-linked main token", async () => {
    const external = join(directory, "external.json");
    const source = JSON.stringify(freshTokens());
    await writeFile(external, source);
    await fs.link(external, tokenFile);
    for (const operation of [() => auth.status(), () => auth.getAccessToken(), () => auth.disconnect()]) {
      await expect(operation()).rejects.toMatchObject({ code: "GOOGLE_TOKEN_READ_FAILED" });
    }
    expect(await readFile(external, "utf8")).toBe(source);
    expect(await readFile(tokenFile, "utf8")).toBe(source);
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.revoke).not.toHaveBeenCalled();
  });

  it("rejects a symbolic main token path without touching its target", async context => {
    const external = join(directory, "external.json");
    const source = JSON.stringify(freshTokens());
    await writeFile(external, source);
    try {
      await fs.symlink(external, tokenFile, "file");
    } catch (error) {
      if (process.platform === "win32" && error instanceof Error && "code" in error && error.code === "EPERM") {
        context.skip();
        return;
      }
      throw error;
    }
    await expect(auth.disconnect()).rejects.toMatchObject({ code: "GOOGLE_TOKEN_READ_FAILED" });
    expect(await readFile(external, "utf8")).toBe(source);
    expect((await fs.lstat(tokenFile)).isSymbolicLink()).toBe(true);
    expect(mocks.revoke).not.toHaveBeenCalled();
  });

  it.each(["directory", "oversized"] as const)("rejects a %s token before parsing it", async kind => {
    if (kind === "directory") await mkdir(tokenFile);
    else await writeFile(tokenFile, "x".repeat(1_048_577));
    await expect(auth.status()).rejects.toMatchObject({ code: "GOOGLE_TOKEN_READ_FAILED" });
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.revoke).not.toHaveBeenCalled();
  });

  it("rejects an in-place mutation during a main-token read", async () => {
    await writeFile(tokenFile, JSON.stringify(freshTokens()));
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
      const handle = await actual.open(...args);
      const read = handle.readFile.bind(handle);
      vi.spyOn(handle, "readFile").mockImplementationOnce(async (...options) => {
        const result = await read(...options);
        await fs.appendFile(tokenFile, " ");
        return result;
      });
      return handle;
    });
    await expect(auth.disconnect()).rejects.toMatchObject({ code: "GOOGLE_TOKEN_READ_FAILED" });
    expect(mocks.revoke).not.toHaveBeenCalled();
  });

  it("checks the opened identity before reading a path replaced during open", async () => {
    await writeFile(tokenFile, JSON.stringify(freshTokens()));
    const external = join(directory, "external.json");
    await writeFile(external, JSON.stringify({ ...freshTokens(), refresh_token: "unrelated-token" }));
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const read = vi.fn();
    vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
      await fs.rename(tokenFile, join(directory, "original.json"));
      await fs.link(external, tokenFile);
      const handle = await actual.open(...args);
      const originalRead = handle.readFile.bind(handle);
      vi.spyOn(handle, "readFile").mockImplementationOnce(async (...options) => {
        read();
        return originalRead(...options);
      });
      return handle;
    });
    await expect(auth.disconnect()).rejects.toMatchObject({ code: "GOOGLE_TOKEN_READ_FAILED" });
    expect(read).not.toHaveBeenCalled();
    expect(mocks.revoke).not.toHaveBeenCalled();
    expect(await readFile(external, "utf8")).toContain("unrelated-token");
  });

  it("does not treat disappearance during open as an initially missing token", async () => {
    await writeFile(tokenFile, JSON.stringify(freshTokens()));
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
      await fs.rename(tokenFile, join(directory, "original.json"));
      return actual.open(...args);
    });
    await expect(auth.status()).rejects.toMatchObject({ code: "GOOGLE_TOKEN_READ_FAILED" });
    expect(mocks.revoke).not.toHaveBeenCalled();
  });

  it("rejects a pathname replacement during descriptor reading", async () => {
    await writeFile(tokenFile, JSON.stringify(freshTokens()));
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
      const handle = await actual.open(...args);
      const read = handle.readFile.bind(handle);
      vi.spyOn(handle, "readFile").mockImplementationOnce(async (...options) => {
        const result = await read(...options);
        await fs.rename(tokenFile, join(directory, "original.json"));
        await writeFile(tokenFile, "replacement user content");
        return result;
      });
      return handle;
    });
    await expect(auth.disconnect()).rejects.toMatchObject({ code: "GOOGLE_TOKEN_READ_FAILED" });
    expect(await readFile(tokenFile, "utf8")).toBe("replacement user content");
    expect(mocks.revoke).not.toHaveBeenCalled();
  });

  it("preserves a main token replaced while revocation is pending", async () => {
    await writeFile(tokenFile, JSON.stringify(freshTokens()));
    mocks.revoke.mockImplementation(async () => {
      await fs.rename(tokenFile, join(directory, "original.json"));
      await writeFile(tokenFile, "replacement user content");
    });
    await expect(auth.disconnect()).rejects.toMatchObject({ code: "GOOGLE_DISCONNECT_LOCAL_FAILED" });
    expect(await readFile(tokenFile, "utf8")).toBe("replacement user content");
    expect(mocks.revoke).toHaveBeenCalledWith("secret-refresh-token");
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

describe("credential publication safety", () => {
  beforeEach(async () => {
    await writeFile(credentialsFile, JSON.stringify(config));
    await mkdir(join(directory, "private"));
  });

  it.each(["hard-link", "junction"] as const)("refuses an existing %s before exchanging authorization", async kind => {
    const external = join(directory, "external");
    if (kind === "hard-link") {
      await writeFile(external, JSON.stringify(freshTokens()));
      await fs.link(external, tokenFile);
    } else {
      await mkdir(external);
      await fs.symlink(external, tokenFile, "junction");
    }
    await expect(auth.complete("code", verifier)).rejects.toMatchObject({ code: "GOOGLE_TOKEN_WRITE_FAILED" });
    expect(mocks.getToken).not.toHaveBeenCalled();
    expect(await readdir(join(directory, "private"))).toEqual(["token.json"]);
    if (kind === "hard-link") {
      expect(await readFile(external, "utf8")).toBe(await readFile(tokenFile, "utf8"));
      expect((await fs.lstat(tokenFile)).nlink).toBe(2);
    } else expect((await fs.lstat(tokenFile)).isSymbolicLink()).toBe(true);
  });

  it("allows explicit reconnection to replace an unchanged malformed ordinary token", async () => {
    await writeFile(tokenFile, "malformed old authorization");
    await auth.complete("code", verifier);
    expect(await auth.getAccessToken()).toBe("secret-access-token");
    expect(await readdir(join(directory, "private"))).toEqual(["token.json"]);
  });

  it("retries replacement after an overlapping reader closes without unlinking the old token", async () => {
    await saveTokens({ ...freshTokens(), expiry_date: 0, refresh_token: "old-token" });
    mocks.refresh.mockResolvedValue({ credentials: { ...freshTokens(), refresh_token: "rotated-token" } });
    const reader = await fs.open(tokenFile, "r");
    let closed = false;
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(fs.rename).mockImplementationOnce(async (...args) => {
      try {
        await actual.rename(...args);
      } catch (error) {
        expect(error).toMatchObject({ code: "EPERM" });
        expect(JSON.parse(await reader.readFile("utf8")).refresh_token).toBe("old-token");
        await reader.close();
        closed = true;
        throw error;
      }
    });
    try {
      expect(await auth.getAccessToken()).toBe("secret-access-token");
      expect(JSON.parse(await readFile(tokenFile, "utf8")).refresh_token).toBe("rotated-token");
      if (!closed) expect(JSON.parse(await reader.readFile("utf8")).refresh_token).toBe("old-token");
      expect(await readdir(join(directory, "private"))).toEqual(["token.json"]);
    } finally {
      if (!closed) await reader.close();
    }
  });

  it.each(["existing", "missing"] as const)("retains a flushed pending save after a rename failure with a %s destination", async kind => {
    if (kind === "existing") await saveTokens({ ...freshTokens(), refresh_token: "old-token" });
    const original = kind === "existing" ? await readFile(tokenFile, "utf8") : null;
    vi.mocked(fs.rename).mockRejectedValue(Object.assign(new Error("synthetic sharing conflict"), { code: "EPERM" }));
    await expect(auth.complete("code", verifier)).rejects.toMatchObject({ code: "GOOGLE_TOKEN_WRITE_FAILED" });
    if (original !== null) expect(await readFile(tokenFile, "utf8")).toBe(original);
    else await expect(readFile(tokenFile)).rejects.toMatchObject({ code: "ENOENT" });
    const pending = (await readdir(join(directory, "private"))).find(name => name.endsWith(".pending"))!;
    const intent = JSON.parse(await readFile(join(directory, "private", pending), "utf8"));
    expect(intent).toMatchObject({ refresh_token: "secret-refresh-token", _saveIntent: { version: 1, tokenFile: "token.json" } });
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(fs.rename).mockImplementation(actual.rename);
    expect(await auth.status()).toEqual({ configured: true, connected: true });
    expect(await readdir(join(directory, "private"))).toEqual(["token.json"]);
    expect(mocks.getToken).toHaveBeenCalledTimes(1);
  });

  it("rechecks destination identity before retrying a sharing conflict", async () => {
    await saveTokens(freshTokens());
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(fs.rename).mockImplementationOnce(async () => {
      await actual.rename(tokenFile, join(directory, "previous.json"));
      await saveTokens({ ...freshTokens(), refresh_token: "replacement-account" });
      throw Object.assign(new Error("synthetic sharing conflict"), { code: "EPERM" });
    });
    await expect(auth.complete("code", verifier)).rejects.toMatchObject({ code: "GOOGLE_TOKEN_WRITE_FAILED" });
    expect(vi.mocked(fs.rename)).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await readFile(tokenFile, "utf8")).refresh_token).toBe("replacement-account");
    expect((await readdir(join(directory, "private"))).filter(name => name.endsWith(".pending"))).toHaveLength(1);
  });

  it.each(["reconnect", "refresh"] as const)("preserves a target replaced during %s and keeps new credentials for inspection", async operation => {
    await saveTokens({ ...freshTokens(), expiry_date: 0 });
    const replace = async () => {
      await fs.rename(tokenFile, join(directory, "previous.json"));
      await saveTokens({ ...freshTokens(), refresh_token: "newer-account" });
      return { ...freshTokens(), refresh_token: "rotated-token" };
    };
    mocks.getToken.mockImplementation(async () => ({ tokens: await replace() }));
    mocks.refresh.mockImplementation(async () => ({ credentials: await replace() }));
    await expect(operation === "refresh" ? auth.getAccessToken() : auth.complete("code", verifier))
      .rejects.toMatchObject({ code: "GOOGLE_TOKEN_WRITE_FAILED" });
    expect(JSON.parse(await readFile(tokenFile, "utf8")).refresh_token).toBe("newer-account");
    const pending = (await readdir(join(directory, "private"))).find(name => name.endsWith(".pending"))!;
    expect(JSON.parse(await readFile(join(directory, "private", pending), "utf8")).refresh_token).toBe("rotated-token");
    await expect(auth.status()).rejects.toMatchObject({ code: "GOOGLE_PENDING_CLEANUP_FAILED" });
    expect(JSON.parse(await readFile(tokenFile, "utf8")).refresh_token).toBe("newer-account");
  });

  it("preserves the main file when it gains a hard link during authorization", async () => {
    await saveTokens(freshTokens());
    const source = await readFile(tokenFile, "utf8");
    mocks.getToken.mockImplementation(async () => {
      await fs.link(tokenFile, join(directory, "external.json"));
      return { tokens: { ...freshTokens(), refresh_token: "new-token" } };
    });
    await expect(auth.complete("code", verifier)).rejects.toMatchObject({ code: "GOOGLE_TOKEN_WRITE_FAILED" });
    expect(await readFile(tokenFile, "utf8")).toBe(source);
    expect(await readFile(join(directory, "external.json"), "utf8")).toBe(source);
    expect((await readdir(join(directory, "private"))).filter(name => name.endsWith(".pending"))).toHaveLength(1);
  });
});


describe("GoogleAuth explicit write-scope consent", () => {
  const writeScope = "https://www.googleapis.com/auth/youtube";
  const freshWriteTokens = () => ({ ...freshTokens(), scope: writeScope });
  let writeTokenFile: string;

  beforeEach(async () => {
    writeTokenFile = join(dirname(tokenFile), "token-write.json");
    await writeFile(credentialsFile, JSON.stringify(config));
  });

  it("requests the broader write scope on a path fully separate from the read-only token", async () => {
    const result = await auth.beginWrite();
    expect(mocks.authUrl).toHaveBeenCalledWith(expect.objectContaining({ scope: [writeScope] }));
    expect(new URL(result.url).searchParams.get("scope")).toBe(writeScope);
    await expect(readFile(writeTokenFile)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(tokenFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("persists a completed write consent to its own file, leaving the backup token file untouched", async () => {
    mocks.getToken.mockResolvedValue({ tokens: freshWriteTokens() });
    await auth.completeWrite("authorization-code", verifier);
    expect(JSON.parse(await readFile(writeTokenFile, "utf8"))).toMatchObject({ scope: writeScope });
    await expect(readFile(tokenFile)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await auth.status()).toEqual({ configured: true, connected: false });
    expect(await auth.writeStatus()).toEqual({ configured: true, connected: true });
  });

  it("fails closed when no write consent has ever been granted, even though the backup is connected", async () => {
    await mkdir(dirname(tokenFile), { recursive: true });
    await writeFile(tokenFile, JSON.stringify(freshTokens()));
    await expect(auth.getWriteAccessToken()).rejects.toMatchObject({ code: "GOOGLE_WRITE_NOT_CONNECTED" });
    expect(await auth.getAccessToken()).toBe("secret-access-token");
  });

  it("rejects a write-scope token being read back through the read-only accessor", async () => {
    await mkdir(dirname(writeTokenFile), { recursive: true });
    await writeFile(writeTokenFile, JSON.stringify(freshWriteTokens()));
    await expect(auth.getWriteAccessToken()).resolves.toBe("secret-access-token");
    await expect(auth.getAccessToken()).rejects.toMatchObject({ code: "GOOGLE_NOT_CONNECTED" });
  });

  it("refreshes an expired write-scope token independently and validates the returned scope", async () => {
    await mkdir(dirname(writeTokenFile), { recursive: true });
    await writeFile(writeTokenFile, JSON.stringify({ ...freshWriteTokens(), expiry_date: 0 }));
    mocks.refresh.mockResolvedValue({ credentials: { ...freshWriteTokens(), access_token: "refreshed-write-access" } });
    await expect(auth.getWriteAccessToken()).resolves.toBe("refreshed-write-access");
    expect(JSON.parse(await readFile(writeTokenFile, "utf8")).access_token).toBe("refreshed-write-access");
  });

  it("rejects a refreshed write token that drops back to read-only scope", async () => {
    await mkdir(dirname(writeTokenFile), { recursive: true });
    await writeFile(writeTokenFile, JSON.stringify({ ...freshWriteTokens(), expiry_date: 0 }));
    mocks.refresh.mockResolvedValue({ credentials: { ...freshTokens(), access_token: "downgraded" } });
    await expect(auth.getWriteAccessToken()).rejects.toMatchObject({ code: "GOOGLE_WRITE_REFRESH_INVALID" });
  });

  it("disconnects only the write-scope credential, preserving the read-only backup connection", async () => {
    await mkdir(dirname(tokenFile), { recursive: true });
    const readOnlyTokens = JSON.stringify(freshTokens());
    await writeFile(tokenFile, readOnlyTokens);
    await writeFile(writeTokenFile, JSON.stringify(freshWriteTokens()));
    await auth.disconnectWrite();
    expect(mocks.revoke).toHaveBeenCalledWith("secret-refresh-token");
    await expect(readFile(writeTokenFile)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(tokenFile, "utf8")).toBe(readOnlyTokens);
    expect(await auth.getAccessToken()).toBe("secret-access-token");
  });
});
