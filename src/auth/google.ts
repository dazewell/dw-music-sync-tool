import { randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { CodeChallengeMethod, OAuth2Client, type Credentials } from "google-auth-library";
import { z } from "zod";
import { AppError } from "../core/errors.js";

const READONLY_SCOPE = "https://www.googleapis.com/auth/youtube.readonly";
const configSchema = z.object({
  installed: z.object({
    client_id: z.string().trim().min(1),
    client_secret: z.string().trim().min(1),
  }),
});
const tokenSchema = z.object({
  refresh_token: z.string().min(1),
  access_token: z.string().min(1).optional(),
  expiry_date: z.number().finite().nonnegative().optional(),
  token_type: z.literal("Bearer").optional(),
  scope: z.string().optional(),
});
type StoredTokens = z.infer<typeof tokenSchema>;
interface PendingTokens {
  filename: string;
  tokens: StoredTokens;
  identity: Stats;
}

export interface GoogleAuthOptions {
  credentialsFile: string;
  tokenFile: string;
  redirectUri: string;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function unchanged(before: Stats, after: Stats): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size
    && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}

function pendingError(): AppError {
  return new AppError(
    "GOOGLE_PENDING_CLEANUP_FAILED",
    "An unfinished Google credential save could not be recovered safely. Stop other app instances and inspect pending token files in the private token directory. Preserve unrecognized files and retry after resolving them.",
    500,
  );
}

export class GoogleAuth {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly options: GoogleAuthOptions) {}

  async status(): Promise<{ configured: boolean; connected: boolean }> {
    return this.serial(async () => {
      await this.recoverPendingTokens();
      const client = await this.client(false);
      if (client === null) return { configured: false, connected: false };
      const tokens = await this.readTokens();
      return { configured: true, connected: tokens !== null };
    });
  }

  async begin(): Promise<{ url: string; state: string; codeVerifier: string }> {
    await this.serial(() => this.recoverPendingTokens());
    const client = await this.requiredClient();
    try {
      const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
      if (!codeVerifier || !codeChallenge) throw new Error("Invalid PKCE result");
      const state = randomBytes(32).toString("base64url");
      const url = client.generateAuthUrl({
        access_type: "offline",
        prompt: "consent",
        scope: [READONLY_SCOPE],
        state,
        code_challenge_method: CodeChallengeMethod.S256,
        code_challenge: codeChallenge,
        include_granted_scopes: false,
      });
      return { url, state, codeVerifier };
    } catch {
      throw new AppError("GOOGLE_AUTH_START_FAILED", "Unable to start Google authorization. Check the Desktop app OAuth configuration.", 500);
    }
  }

  async complete(code: string, codeVerifier: string): Promise<void> {
    return this.serial(async () => {
      if (!code || !/^[A-Za-z0-9._~-]{43,128}$/.test(codeVerifier)) {
        throw new AppError("GOOGLE_AUTH_INVALID", "The Google authorization response is invalid. Start the connection again.", 400);
      }
      await this.recoverPendingTokens();
      const client = await this.requiredClient();
      let credentials: Credentials;
      try {
        const result = await client.getToken({ code, codeVerifier, redirect_uri: this.options.redirectUri });
        credentials = result.tokens;
      } catch {
        throw new AppError("GOOGLE_AUTH_EXCHANGE_FAILED", "Google authorization could not be completed. Start the connection again and grant read-only YouTube access.", 401);
      }
      const tokens = this.validateTokens(credentials, "GOOGLE_AUTH_TOKEN_INVALID");
      if (!tokens.access_token) {
        throw new AppError("GOOGLE_AUTH_TOKEN_INVALID", "Google did not return usable offline credentials. Reconnect and grant read-only YouTube access.", 401);
      }
      await this.persist(tokens);
    });
  }

  async getAccessToken(): Promise<string> {
    return this.serial(async () => {
      await this.recoverPendingTokens();
      const client = await this.requiredClient();
      const tokens = await this.readTokens();
      if (tokens === null) {
        throw new AppError("GOOGLE_NOT_CONNECTED", "Connect your Google account before backing up YouTube playlists.", 401);
      }
      if (tokens.access_token && tokens.expiry_date !== undefined && tokens.expiry_date > Date.now() + 60_000) {
        return tokens.access_token;
      }
      client.setCredentials({ refresh_token: tokens.refresh_token });
      let credentials: Credentials;
      try {
        const result = await client.refreshAccessToken();
        credentials = result.credentials;
      } catch {
        throw new AppError("GOOGLE_REFRESH_FAILED", "Google access could not be refreshed. Check your network or reconnect your Google account if access has expired or been revoked.", 401);
      }
      // Persist explicitly after refresh; an async 'tokens' listener can race a disconnect or fail unobserved.
      const refreshed = this.validateTokens({
        ...credentials,
        refresh_token: credentials.refresh_token ?? tokens.refresh_token,
        scope: credentials.scope ?? tokens.scope,
      }, "GOOGLE_REFRESH_INVALID");
      if (!refreshed.access_token || refreshed.expiry_date === undefined || refreshed.expiry_date <= Date.now()) {
        throw new AppError("GOOGLE_REFRESH_INVALID", "Google returned unusable refreshed credentials. Reconnect your Google account.", 401);
      }
      await this.persist(refreshed);
      return refreshed.access_token;
    });
  }

  async disconnect(): Promise<void> {
    return this.serial(async () => {
      const pending = await this.pendingTokens();
      const tokens = await this.readTokens();
      const refreshTokens = new Set([
        ...(tokens ? [tokens.refresh_token] : []),
        ...pending.map(item => item.tokens.refresh_token),
      ]);
      if (refreshTokens.size === 0) return;
      let remoteFailed = false;
      for (const refreshToken of refreshTokens) {
        try {
          const client = await this.requiredClient();
          await client.revokeToken(refreshToken);
        } catch {
          remoteFailed = true;
        }
      }
      try {
        for (const item of pending) {
          await this.assertPendingUnchanged(item);
          await unlink(item.filename);
        }
        if (tokens) {
          try {
            await unlink(this.options.tokenFile);
          } catch (error) {
            if (!isMissing(error)) throw error;
          }
        }
      } catch {
        throw new AppError(
          "GOOGLE_DISCONNECT_LOCAL_FAILED",
          remoteFailed
            ? "Google revocation failed and local credentials could not be removed. Revoke this app in your Google Account permissions and inspect the token file and pending credential files."
            : "Google access was revoked, but local credentials could not be removed. Inspect the token file and pending credential files.",
          500,
        );
      }
      if (remoteFailed) {
        throw new AppError("GOOGLE_REVOKE_FAILED", "Local credentials were removed, but Google revocation failed. Remove this app's access in your Google Account permissions to finish disconnecting.", 502);
      }
    });
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation);
    this.queue = next.then(() => undefined, () => undefined);
    return next;
  }

  private async pendingTokens(): Promise<PendingTokens[]> {
    const directory = dirname(this.options.tokenFile);
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if (isMissing(error)) return [];
      throw pendingError();
    }
    const prefix = `${basename(this.options.tokenFile)}.`;
    const pending: PendingTokens[] = [];
    for (const name of names.filter(name => name.startsWith(prefix)
      && /^[a-f0-9]{24}\.pending$/.test(name.slice(prefix.length)))) {
      const filename = join(directory, name);
      try {
        const identity = await lstat(filename);
        if (!identity.isFile() || identity.isSymbolicLink() || identity.nlink !== 1 || identity.size > 1_048_576) {
          throw pendingError();
        }
        const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        let source: string;
        try {
          if (!unchanged(identity, await handle.stat())) throw pendingError();
          source = await handle.readFile("utf8");
          if (!unchanged(identity, await handle.stat())) throw pendingError();
        } finally {
          await handle.close();
        }
        const parsed = tokenSchema.strict().parse(JSON.parse(source) as unknown);
        pending.push({ filename, identity, tokens: this.validateTokens(parsed) });
      } catch {
        throw pendingError();
      }
    }
    return pending;
  }

  private async assertPendingUnchanged(item: PendingTokens): Promise<void> {
    const current = await lstat(item.filename);
    if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1
      || !unchanged(item.identity, current)) throw pendingError();
  }

  private async recoverPendingTokens(): Promise<void> {
    const pending = await this.pendingTokens();
    if (pending.length === 0) return;
    // More than one intent has no trustworthy ordering; disconnect can revoke all.
    if (pending.length !== 1) throw pendingError();
    const item = pending[0]!;
    try {
      try {
        const target = await lstat(this.options.tokenFile);
        if (!target.isFile() || target.isSymbolicLink() || target.nlink !== 1) throw pendingError();
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      await this.assertPendingUnchanged(item);
      await rename(item.filename, this.options.tokenFile);
    } catch {
      throw pendingError();
    }
  }

  private async requiredClient(): Promise<OAuth2Client> {
    const client = await this.client(true);
    if (client === null) throw new AppError("GOOGLE_NOT_CONFIGURED", "Configure Google Desktop app OAuth credentials first.", 400);
    return client;
  }

  private async client(required: boolean): Promise<OAuth2Client | null> {
    let source: string;
    try {
      source = await readFile(this.options.credentialsFile, "utf8");
    } catch (error) {
      if (isMissing(error)) {
        if (!required) return null;
        throw new AppError("GOOGLE_NOT_CONFIGURED", "Google OAuth credentials are missing. Download a Desktop app OAuth client JSON from Google Cloud and configure its file location.", 400);
      }
      throw new AppError("GOOGLE_CONFIG_READ_FAILED", "The Google OAuth credentials file could not be read. Check local file permissions.", 500);
    }
    try {
      const parsed = configSchema.safeParse(JSON.parse(source) as unknown);
      if (!parsed.success) throw new Error("Invalid configuration");
      return new OAuth2Client({
        clientId: parsed.data.installed.client_id,
        clientSecret: parsed.data.installed.client_secret,
        redirectUri: this.options.redirectUri,
        transporterOptions: { timeout: 20_000, maxRedirects: 0 },
      });
    } catch {
      throw new AppError("GOOGLE_CONFIG_INVALID", "The Google OAuth credentials file is malformed or is not a Desktop app client. Download a Desktop app OAuth JSON containing installed.client_id and installed.client_secret; Web application credentials are not supported.", 400);
    }
  }

  private validateTokens(value: unknown, code = "GOOGLE_TOKEN_INVALID"): StoredTokens {
    const parsed = tokenSchema.safeParse(value);
    if (!parsed.success || (parsed.data.scope !== undefined && parsed.data.scope !== READONLY_SCOPE)) {
      throw new AppError(code, "Google credentials are malformed, lack an offline refresh token, or do not grant exactly read-only YouTube access. Reconnect your Google account; inspect or remove an invalid local token file if necessary.", 401);
    }
    return parsed.data;
  }

  private async readTokens(): Promise<StoredTokens | null> {
    let source: string;
    try {
      source = await readFile(this.options.tokenFile, "utf8");
    } catch (error) {
      if (isMissing(error)) return null;
      throw new AppError("GOOGLE_TOKEN_READ_FAILED", "The local Google token file could not be read. Check its permissions.", 500);
    }
    let value: unknown;
    try {
      value = JSON.parse(source) as unknown;
    } catch {
      throw new AppError("GOOGLE_TOKEN_INVALID", "The local Google token file is malformed. Remove it and reconnect your Google account.", 401);
    }
    return this.validateTokens(value);
  }

  private async persist(tokens: StoredTokens): Promise<void> {
    const directory = dirname(this.options.tokenFile);
    const pending = `${this.options.tokenFile}.${randomBytes(12).toString("hex")}.pending`;
    let created = false;
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      const file = await open(pending, "wx", 0o600);
      created = true;
      try {
        await file.writeFile(`${JSON.stringify(tokens)}\n`, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(pending, this.options.tokenFile);
      created = false;
    } catch {
      if (created) {
        try {
          await unlink(pending);
        } catch {
          throw new AppError("GOOGLE_TOKEN_WRITE_FAILED", "Google credentials could not be saved and a pending credential file could not be removed. Check permissions and remove leftover .pending files in the token directory.", 500);
        }
      }
      throw new AppError("GOOGLE_TOKEN_WRITE_FAILED", "Google credentials could not be saved securely. Check the local token directory permissions and available disk space.", 500);
    }
  }
}
