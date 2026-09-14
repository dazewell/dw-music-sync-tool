import { AppError } from "../core/errors.js";

const TOKEN_URL = "https://accounts.spotify.com/api/token";

export interface SpotifyAuthOptions {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
  /**
   * Invoked when Spotify returns a rotated refresh token that differs from
   * the one currently in use, so the caller can persist it durably (for
   * example, rewriting the local `.env` file). Optional: without it, the
   * rotation is still used in-process but only logged for the operator.
   */
  onRefreshTokenRotated?: (refreshToken: string) => Promise<void> | void;
}

/**
 * Refresh-token-only Spotify access. There is no in-app Spotify connect flow;
 * this exchanges an operator-supplied, out-of-band refresh token for
 * short-lived access tokens so explicitly paired playlists can still be
 * mirrored through the real Spotify Web API, without ever persisting a
 * client secret or refresh token in application state; the operator is
 * solely responsible for storing it (for example, in a local `.env` file,
 * which is Git-ignored).
 */
export class SpotifyAuth {
  private readonly fetcher: typeof fetch;
  private readonly timeout: number;
  private cached: { accessToken: string; expiresAt: number } | null = null;
  // Spotify can rotate refresh tokens on any exchange. Track the currently
  // valid one separately from the immutable constructor option so a rotation
  // observed mid-process is actually used on the next refresh in this process,
  // instead of retrying with the now-invalidated original token.
  private currentRefreshToken: string;
  // Serializes calls to onRefreshTokenRotated so concurrent rotations (from overlapping
  // getAccessToken calls) persist in the order they were observed, instead of racing.
  private rotationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly options: SpotifyAuthOptions) {
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.timeout = options.requestTimeoutMs ?? 20_000;
    this.currentRefreshToken = options.refreshToken;
  }

  async getAccessToken(): Promise<string> {
    if (this.cached && this.cached.expiresAt > Date.now() + 60_000) return this.cached.accessToken;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    let body: { access_token?: unknown; expires_in?: unknown; refresh_token?: unknown } | null;
    try {
      let response: Response;
      try {
        response = await this.fetcher(TOKEN_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Authorization: `Basic ${Buffer.from(`${this.options.clientId}:${this.options.clientSecret}`).toString("base64")}`,
          },
          body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: this.currentRefreshToken }).toString(),
          signal: controller.signal,
          redirect: "error",
        });
      } catch {
        throw new AppError(
          controller.signal.aborted ? "SPOTIFY_AUTH_TIMEOUT" : "SPOTIFY_AUTH_NETWORK",
          controller.signal.aborted ? "Spotify authorization did not respond in time." : "Unable to reach Spotify for authorization.",
          502,
        );
      }
      if (!response.ok) {
        throw new AppError(
          "SPOTIFY_AUTH_REJECTED",
          "Spotify rejected the configured refresh token. Reconfigure SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET and SPOTIFY_REFRESH_TOKEN with a valid, unexpired authorization.",
          401,
        );
      }
      // Keep the abort timer (and its timeout guarantee) active until the body has actually
      // been consumed: fetch() resolving only means headers arrived, and a response that stalls
      // while streaming the body would otherwise run unbounded despite requestTimeoutMs. A
      // genuine abort here must still surface as a timeout, not be swallowed as a malformed body.
      try {
        body = (await response.json()) as typeof body;
      } catch {
        if (controller.signal.aborted) {
          throw new AppError("SPOTIFY_AUTH_TIMEOUT", "Spotify authorization did not respond in time.", 502);
        }
        body = null;
      }
    } finally {
      clearTimeout(timer);
    }
    if (!body || typeof body.access_token !== "string" || !body.access_token
      || typeof body.expires_in !== "number" || !(body.expires_in > 0)) {
      throw new AppError("SPOTIFY_AUTH_INVALID", "Spotify returned an invalid authorization response.", 502);
    }
    if (typeof body.refresh_token === "string" && body.refresh_token && body.refresh_token !== this.currentRefreshToken) {
      // Use the rotated token for the remainder of this process so subsequent
      // refreshes do not retry with the now-invalidated original value.
      this.currentRefreshToken = body.refresh_token;
      const rotated = body.refresh_token;
      if (this.options.onRefreshTokenRotated) {
        const persisted = this.rotationQueue.then(() => this.options.onRefreshTokenRotated!(rotated));
        this.rotationQueue = persisted.then(() => undefined, () => undefined);
        try {
          await persisted;
        } catch (error) {
          // Do not silently continue as if the rotation were saved: a restart before this is
          // fixed would use the now-invalidated original token and fail every subsequent refresh.
          throw new AppError(
            "SPOTIFY_AUTH_ROTATION_PERSIST_FAILED",
            `Spotify issued a rotated refresh token but it could not be saved (${error instanceof Error ? error.message : String(error)}). `
              + "Fix the persistence error before restarting, or the previous refresh token will stop working.",
            502,
          );
        }
      } else {
        console.warn("Spotify issued a rotated refresh token. Update SPOTIFY_REFRESH_TOKEN before the previous one expires.");
      }
    }
    this.cached = { accessToken: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
    return this.cached.accessToken;
  }
}
