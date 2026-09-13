import { randomBytes } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, readdir, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { CodeChallengeMethod, OAuth2Client, type Credentials } from "google-auth-library";
import { z } from "zod";
import { AppError } from "../core/errors.js";
import { replaceFile } from "../core/replace-file.js";

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
  scope: z.literal(READONLY_SCOPE),
});
type StoredTokens = z.infer<typeof tokenSchema>;
const destinationSchema = z.object({
  dev: z.string().regex(/^\d+$/),
  ino: z.string().regex(/^\d+$/),
  size: z.string().regex(/^\d+$/),
  mtimeNs: z.string().regex(/^-?\d+$/),
  ctimeNs: z.string().regex(/^-?\d+$/),
}).strict();
type Destination = z.infer<typeof destinationSchema> | null;
const pendingSchema = tokenSchema.extend({
  _saveIntent: z.object({
    version: z.literal(1),
    tokenFile: z.string().min(1),
    destination: destinationSchema.nullable(),
  }).strict().optional(),
}).strict();
interface TokenText {
  source: string;
  identity: BigIntStats;
}
interface StoredTokenFile {
  filename: string;
  tokens: StoredTokens;
  identity: BigIntStats;
}
interface PendingTokenFile extends StoredTokenFile {
  destination: Destination | undefined;
}

export interface GoogleAuthOptions {
  credentialsFile: string;
  tokenFile: string;
  redirectUri: string;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function unchanged(before: BigIntStats, after: BigIntStats): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size
    && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs && before.nlink === after.nlink;
}

function ordinaryToken(info: BigIntStats): boolean {
  return info.isFile() && !info.isSymbolicLink() && info.nlink === 1n && info.size <= 1_048_576n;
}

function destinationIdentity(info: BigIntStats): Exclude<Destination, null> {
  return {
    dev: String(info.dev), ino: String(info.ino), size: String(info.size),
    mtimeNs: String(info.mtimeNs), ctimeNs: String(info.ctimeNs),
  };
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
      let destination: Destination;
      try {
        destination = await this.tokenDestination();
      } catch {
        throw new AppError("GOOGLE_TOKEN_WRITE_FAILED", "The existing Google token path is not a safe regular file. Preserve it and inspect its links and permissions before reconnecting.", 500);
      }
      let credentials: Credentials;
      try {
        const result = await client.getToken({ code, codeVerifier, redirect_uri: this.options.redirectUri });
        credentials = result.tokens;
      } catch {
        throw new AppError("GOOGLE_AUTH_EXCHANGE_FAILED", "Google authorization could not be completed. Start the connection again and grant read-only YouTube access.", 401);
      }
      if (credentials.scope === undefined && typeof credentials.access_token === "string" && credentials.access_token) {
        try {
          const info = await client.getTokenInfo(credentials.access_token);
          credentials = { ...credentials, scope: info.scopes.join(" ") };
        } catch {
          throw new AppError("GOOGLE_AUTH_SCOPE_UNVERIFIED", "Google did not report token scopes and their granted access could not be verified. No credentials were saved. Retry connecting with read-only YouTube access.", 401);
        }
      }
      const tokens = this.validateTokens(credentials, "GOOGLE_AUTH_TOKEN_INVALID");
      if (!tokens.access_token) {
        throw new AppError("GOOGLE_AUTH_TOKEN_INVALID", "Google did not return usable offline credentials. Reconnect and grant read-only YouTube access.", 401);
      }
      await this.persist(tokens, destination);
    });
  }

  async getAccessToken(): Promise<string> {
    return this.serial(async () => {
      await this.recoverPendingTokens();
      const client = await this.requiredClient();
      const saved = await this.readTokens();
      if (saved === null) {
        throw new AppError("GOOGLE_NOT_CONNECTED", "Connect your Google account before backing up YouTube playlists.", 401);
      }
      const tokens = saved.tokens;
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
        scope: credentials.scope === undefined ? tokens.scope : credentials.scope,
      }, "GOOGLE_REFRESH_INVALID");
      if (!refreshed.access_token || refreshed.expiry_date === undefined || refreshed.expiry_date <= Date.now()) {
        throw new AppError("GOOGLE_REFRESH_INVALID", "Google returned unusable refreshed credentials. Reconnect your Google account.", 401);
      }
      await this.persist(refreshed, destinationIdentity(saved.identity));
      return refreshed.access_token;
    });
  }

  async disconnect(): Promise<void> {
    return this.serial(async () => {
      const pending = await this.pendingTokens();
      let saved: StoredTokenFile | null = null;
      let mainError: AppError | null = null;
      try {
        saved = await this.readTokens();
      } catch (error) {
        mainError = error instanceof AppError ? error
          : new AppError("GOOGLE_TOKEN_READ_FAILED", "The main Google token could not be inspected safely.", 500);
      }
      const tokens = saved?.tokens;
      const refreshTokens = new Set([
        ...(tokens ? [tokens.refresh_token] : []),
        ...pending.files.map(item => item.tokens.refresh_token),
      ]);
      if (refreshTokens.size === 0) {
        if (mainError && pending.failed) {
          throw new AppError("GOOGLE_DISCONNECT_LOCAL_FAILED", "The main and pending Google credentials could not be inspected safely and were preserved. Inspect the private token directory and revoke this app in your Google Account permissions to finish disconnecting.", 500);
        }
        if (mainError) throw mainError;
        if (pending.failed) throw pendingError();
        return;
      }
      let remoteFailed = false;
      for (const refreshToken of refreshTokens) {
        try {
          const client = await this.requiredClient();
          await client.revokeToken(refreshToken);
        } catch {
          remoteFailed = true;
        }
      }
      let localFailed = pending.failed || mainError !== null;
      for (const item of [...pending.files, ...(saved ? [saved] : [])]) {
        try {
          await this.assertTokenUnchanged(item);
          await unlink(item.filename);
        } catch {
          localFailed = true;
        }
      }
      if (localFailed) {
        throw new AppError(
          "GOOGLE_DISCONNECT_LOCAL_FAILED",
          remoteFailed
            ? "Google revocation failed for some validated credentials, and some local credentials could not be inspected or removed. Other validated files were processed. Revoke this app in your Google Account permissions and inspect the token file and pending credential files."
            : "Revocation completed for validated credentials only; some local credentials could not be inspected or removed. Other validated files were processed. Inspect the token file and pending credential files, and revoke this app in your Google Account permissions to finish disconnecting.",
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

  private async readTokenText(filename: string): Promise<TokenText | null> {
    let identity: BigIntStats;
    try {
      identity = await lstat(filename, { bigint: true });
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
    if (!ordinaryToken(identity)) throw new Error("The credential path is not an ordinary, unlinked file.");
    const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      if (!unchanged(identity, await handle.stat({ bigint: true }))) throw new Error("Credentials changed before reading.");
      const source = await handle.readFile("utf8");
      if (!unchanged(identity, await handle.stat({ bigint: true }))
        || !unchanged(identity, await lstat(filename, { bigint: true }))) {
        throw new Error("Credentials changed while reading.");
      }
      return { source, identity };
    } finally {
      await handle.close();
    }
  }

  private async pendingTokens(): Promise<{ files: PendingTokenFile[]; failed: boolean }> {
    const directory = dirname(this.options.tokenFile);
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      return { files: [], failed: !isMissing(error) };
    }
    const prefix = `${basename(this.options.tokenFile)}.`;
    const pending: PendingTokenFile[] = [];
    let failed = false;
    for (const name of names.filter(name => name.startsWith(prefix)
      && /^[a-f0-9]{24}\.pending$/.test(name.slice(prefix.length)))) {
      const filename = join(directory, name);
      try {
        const record = await this.readTokenText(filename);
        if (!record) throw pendingError();
        const parsed = pendingSchema.parse(JSON.parse(record.source) as unknown);
        if (parsed._saveIntent && parsed._saveIntent.tokenFile !== basename(this.options.tokenFile)) throw pendingError();
        pending.push({
          filename, identity: record.identity, tokens: this.validateTokens(parsed),
          destination: parsed._saveIntent?.destination,
        });
      } catch {
        failed = true;
      }
    }
    return { files: pending, failed };
  }

  private async assertTokenUnchanged(item: StoredTokenFile): Promise<void> {
    const current = await lstat(item.filename, { bigint: true });
    if (!ordinaryToken(current) || !unchanged(item.identity, current)) throw new Error("The credential file changed.");
  }

  private async recoverPendingTokens(): Promise<void> {
    const pending = await this.pendingTokens();
    if (pending.failed) throw pendingError();
    if (pending.files.length === 0) return;
    // More than one intent has no trustworthy ordering; disconnect can revoke all.
    if (pending.files.length !== 1) throw pendingError();
    const item = pending.files[0]!;
    const destination = item.destination;
    if (destination === undefined) throw pendingError();
    try {
      await replaceFile(item.filename, this.options.tokenFile, async () => {
        await this.assertDestination(destination);
        await this.assertTokenUnchanged(item);
      });
    } catch {
      throw pendingError();
    }
  }

  private async tokenDestination(): Promise<Destination> {
    let info: BigIntStats;
    try {
      info = await lstat(this.options.tokenFile, { bigint: true });
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
    if (!ordinaryToken(info)) throw new Error("Unsafe credential destination.");
    return destinationIdentity(info);
  }

  private async assertDestination(expected: Destination): Promise<void> {
    const actual = await this.tokenDestination();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("The credential destination changed.");
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
    if (!parsed.success) {
      throw new AppError(code, "Google credentials are malformed, lack an offline refresh token, or do not grant exactly read-only YouTube access. Reconnect your Google account; inspect or remove an invalid local token file if necessary.", 401);
    }
    return parsed.data;
  }

  private async readTokens(): Promise<StoredTokenFile | null> {
    let record: TokenText | null;
    try {
      record = await this.readTokenText(this.options.tokenFile);
    } catch {
      throw new AppError("GOOGLE_TOKEN_READ_FAILED", "The local Google token file could not be read safely. It must be an unchanged, regular file without links. Check its path and permissions before retrying.", 500);
    }
    if (!record) return null;
    let value: unknown;
    try {
      value = JSON.parse(record.source) as unknown;
    } catch {
      throw new AppError("GOOGLE_TOKEN_INVALID", "The local Google token file is malformed. Remove it and reconnect your Google account.", 401);
    }
    return { filename: this.options.tokenFile, identity: record.identity, tokens: this.validateTokens(value) };
  }

  private async persist(tokens: StoredTokens, destination: Destination): Promise<void> {
    const directory = dirname(this.options.tokenFile);
    const pending = `${this.options.tokenFile}.${randomBytes(12).toString("hex")}.pending`;
    let created = false;
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      const file = await open(pending, "wx", 0o600);
      created = true;
      let identity: BigIntStats;
      try {
        await file.writeFile(`${JSON.stringify({
          ...tokens, _saveIntent: { version: 1, tokenFile: basename(this.options.tokenFile), destination },
        })}\n`, "utf8");
        await file.sync();
        identity = await file.stat({ bigint: true });
      } finally {
        await file.close();
      }
      await replaceFile(pending, this.options.tokenFile, async () => {
        await this.assertDestination(destination);
        await this.assertTokenUnchanged({ filename: pending, tokens, identity });
      });
      created = false;
    } catch {
      if (created) {
        throw new AppError("GOOGLE_TOKEN_WRITE_FAILED", "Google credentials could not be published. An unfinished credential save was preserved in the private token directory. Retry after resolving permissions, or inspect pending files and any changed destination before reconnecting.", 500);
      }
      throw new AppError("GOOGLE_TOKEN_WRITE_FAILED", "Google credentials could not be saved securely. Check the local token directory permissions and available disk space.", 500);
    }
  }
}
