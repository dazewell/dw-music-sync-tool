import { z } from "zod";
import { AppError } from "../core/errors.js";
import type { Playlist, PlaylistContents, PlaylistEntry, PlaylistMutation, PlaylistProvider } from "../core/models.js";

const API_ROOT = "https://www.googleapis.com/youtube/v3/";
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RETRIES = 3;
const MAX_RETRY_DELAY_MS = 30_000;
const visibility = z.enum(["public", "private", "unlisted"]);
const nonempty = z.string().min(1);
const count = z.number().int().nonnegative();
const status = z.object({ privacyStatus: visibility.optional() });

const playlistSchema = z.object({
  id: nonempty,
  snippet: z.object({
    title: z.string(),
    description: z.string(),
    channelId: z.string().optional(),
    channelTitle: z.string(),
  }),
  contentDetails: z.object({ itemCount: count }),
  status: status.optional(),
});

const itemSchema = z.object({
  id: nonempty,
  snippet: z.object({
    title: z.string(),
    position: count,
    playlistId: nonempty,
    description: z.string().optional(),
    channelId: z.string().optional(),
    channelTitle: z.string().optional(),
    publishedAt: z.string().optional(),
    videoOwnerChannelTitle: z.string().optional(),
    videoOwnerChannelId: z.string().optional(),
    resourceId: z.object({
      kind: z.literal("youtube#video"),
      videoId: nonempty.optional(),
    }),
  }),
  contentDetails: z.object({
    videoId: nonempty.optional(),
    videoPublishedAt: z.string().optional(),
    note: z.string().optional(),
    startAt: z.string().optional(),
    endAt: z.string().optional(),
  }).optional(),
  status: status.optional(),
});

const insertedItemSchema = z.object({ id: nonempty });

function pageSchema<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    nextPageToken: nonempty.optional(),
    pageInfo: z.object({
      totalResults: count,
      resultsPerPage: count.optional(),
    }).optional(),
  });
}

/** Summarizes the first few schema validation issues so a shape mismatch is diagnosable
 * from the error message alone, instead of a bare "invalid response" with no detail. */
function describeIssues(result: z.ZodSafeParseError<unknown>): string {
  return result.error.issues.slice(0, 3).map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
}

type YouTubeItem = z.infer<typeof itemSchema>;

export interface YouTubeProviderOptions {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Supplies an access token for a separately, explicitly consented write-capable Google
   * credential. Never derive this from the read-only backup credential: if it is omitted,
   * every mutating call fails closed before any request is sent.
   */
  writeAccessToken?: () => Promise<string>;
}

export class YouTubeProvider implements PlaylistProvider, PlaylistMutation {
  readonly id = "youtube" as const;
  readonly coverage = "Owned playlists exposed by the official YouTube Data API, including non-music videos; not a complete YouTube Music library. Saved third-party playlists and special Music collections (mixes, audio uploads, liked Music) are outside this backup's coverage. Private/deleted entries may have incomplete metadata. Metadata only; no audio downloads.";
  private readonly fetcher: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly writeAccessToken: (() => Promise<string>) | undefined;

  constructor(
    private readonly accessToken: () => Promise<string>,
    options: YouTubeProviderOptions = {},
  ) {
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.writeAccessToken = options.writeAccessToken;
  }

  async listPlaylists(): Promise<Playlist[]> {
    const { items, totals } = await this.pages(
      "playlists",
      { part: "snippet,contentDetails,status", mine: "true", maxResults: "50" },
      playlistSchema,
    );
    if (new Set(items.map((item) => item.id)).size !== items.length) {
      throw new AppError(
        "YOUTUBE_PLAYLISTS_CHANGED",
        "YouTube returned repeated playlist IDs during discovery. Refresh the library and try again.",
        409,
      );
    }
    // YouTube can overcount discovery totals even after the final page. Tokens, not totals, control pagination.
    if (totals.some((total) => total !== items.length)) {
      console.warn(
        `YouTube playlist discovery: read all pages and received ${items.length} distinct playlists; `
          + `pageInfo.totalResults reported ${[...new Set(totals)].join(", ")}. Using the returned playlists.`,
      );
    }
    return items.map((item) => ({
      provider: this.id,
      id: item.id,
      title: item.snippet.title,
      description: item.snippet.description,
      owner: item.snippet.channelId ?? item.snippet.channelTitle,
      itemCount: item.contentDetails.itemCount,
      visibility: item.status?.privacyStatus ?? "unknown",
      url: `https://www.youtube.com/playlist?list=${encodeURIComponent(item.id)}`,
    }));
  }

  async getPlaylist(playlist: Playlist): Promise<PlaylistContents> {
    if (playlist.provider !== this.id || !playlist.id) {
      throw new AppError("YOUTUBE_PLAYLIST_INVALID", "A YouTube playlist is required.", 400);
    }

    const { items, totals } = await this.pages(
      "playlistItems",
      { part: "snippet,contentDetails,status", playlistId: playlist.id, maxResults: "50" },
      itemSchema,
    );
    if (items.some((item) => item.snippet.playlistId !== playlist.id)) {
      throw new AppError("YOUTUBE_RESPONSE_INVALID", "YouTube returned items from an unexpected playlist.", 502);
    }
    const entries = items.map((item) => this.entry(item)).sort((a, b) => a.position - b.position);
    if ((playlist.itemCount !== null && playlist.itemCount !== entries.length) ||
        totals.some((total) => total !== entries.length) ||
        new Set(entries.map((entry) => entry.id)).size !== entries.length ||
        entries.some((entry, index) => entry.position !== index)) {
      throw new AppError(
        "YOUTUBE_PLAYLIST_CHANGED",
        "The YouTube playlist changed or returned inconsistent item counts, repeated playlist-item IDs, or missing/repeated positions. A complete zero-based snapshot could not be verified. Retry the backup.",
        409,
      );
    }
    const warnings: string[] = [];
    if (entries.some((entry) => entry.availability === "unavailable")) {
      warnings.push("Private or deleted video placeholders were preserved. Their media and full metadata may be unavailable.");
    }
    if (entries.some((entry) => entry.mediaId === null)) {
      warnings.push("Some entries have no video ID in the API response; the entries were preserved without a media link.");
    }
    return { playlist, entries, warnings };
  }

  async replacePlaylist(playlist: Playlist, entries: readonly PlaylistEntry[]): Promise<void> {
    if (playlist.provider !== this.id || !playlist.id) {
      throw new AppError("YOUTUBE_PLAYLIST_INVALID", "A YouTube playlist is required.", 400);
    }
    // Fail closed before any request: without a separately consented write-capable credential,
    // no playlist mutation can be authorized by Google, and none is attempted.
    if (this.writeAccessToken === undefined) {
      throw new AppError(
        "YOUTUBE_WRITE_NOT_AUTHORIZED",
        "YouTube playlist writes require a separately, explicitly authorized write-scope Google credential. Connect write access before syncing changes to YouTube.",
        403,
      );
    }
    if (entries.some(entry => entry.mediaId === null || entry.availability === "unavailable")) {
      throw new AppError("YOUTUBE_ENTRY_UNSUPPORTED", "Unavailable entries cannot be written to YouTube without a video ID.", 409);
    }
    const current = await this.getPlaylist(playlist);
    // Insert the new entries before removing the previous ones. If insertion fails partway
    // (network error, quota, malformed response) the previous playlist entries are still
    // intact instead of already deleted; nothing is lost, and the failure is explicit.
    const insertUrl = new URL(`playlistItems?${new URLSearchParams({ part: "snippet" }).toString()}`, API_ROOT);
    const insertedIds: string[] = [];
    try {
      for (const entry of entries) {
        const body = await this.request(insertUrl, {
          method: "POST",
          body: JSON.stringify({ snippet: { playlistId: playlist.id, resourceId: { kind: "youtube#video", videoId: entry.mediaId } } }),
        }, "write");
        const inserted = insertedItemSchema.safeParse(body);
        if (!inserted.success) {
          throw new AppError(
            "YOUTUBE_INSERT_UNCONFIRMED",
            "YouTube did not confirm the inserted playlist item. The previously existing items were preserved; review the playlist before retrying.",
            502,
          );
        }
        insertedIds.push(inserted.data.id);
      }
    } catch (error) {
      // A later insert failed after some earlier ones succeeded. Leaving the successful
      // inserts in place alongside the still-intact original entries would let a retry
      // compound duplicates, so best-effort clean them up before surfacing the failure.
      for (const id of insertedIds) {
        try {
          await this.request(new URL(`playlistItems?${new URLSearchParams({ id }).toString()}`, API_ROOT), { method: "DELETE" }, "write");
        } catch {
          // Cleanup failing must not mask the original insert failure below; the playlist may
          // still contain some inserted duplicates and needs manual review in that case.
        }
      }
      throw error;
    }
    for (const entry of current.entries) {
      await this.request(new URL(`playlistItems?${new URLSearchParams({ id: entry.id }).toString()}`, API_ROOT), { method: "DELETE" }, "write");
    }
  }

  private entry(item: YouTubeItem): PlaylistEntry {
    const mediaId = item.contentDetails?.videoId ?? item.snippet.resourceId.videoId ?? null;
    const unavailable = /^(?:private|deleted) video$/i.test(item.snippet.title.trim());
    return {
      id: item.id,
      position: item.snippet.position,
      mediaId,
      title: item.snippet.title,
      artist: null,
      album: null,
      url: mediaId === null ? null : `https://www.youtube.com/watch?v=${encodeURIComponent(mediaId)}`,
      availability: unavailable ? "unavailable" : "unknown",
      addedAt: item.snippet.publishedAt ?? null,
      // Schema-selected provider metadata only: never retain response headers or unknown fields.
      providerData: { ...item },
    };
  }

  private async pages<T extends z.ZodType>(
    endpoint: string,
    parameters: Record<string, string>,
    schema: T,
  ): Promise<{ items: z.infer<T>[]; totals: number[] }> {
    const items: z.infer<T>[] = [];
    const totals: number[] = [];
    const seen = new Set<string>();
    let pageToken: string | undefined;
    do {
      const url = new URL(endpoint, API_ROOT);
      for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
      if (pageToken !== undefined) url.searchParams.set("pageToken", pageToken);
      const parsed = pageSchema(schema).safeParse(await this.request(url));
      if (!parsed.success) {
        throw new AppError("YOUTUBE_RESPONSE_INVALID", `YouTube returned an invalid playlist response (${describeIssues(parsed)}). No complete backup can be assumed.`, 502);
      }
      items.push(...parsed.data.items);
      if (parsed.data.pageInfo !== undefined) totals.push(parsed.data.pageInfo.totalResults);
      pageToken = parsed.data.nextPageToken;
      if (pageToken !== undefined) {
        if (seen.has(pageToken)) {
          throw new AppError("YOUTUBE_PAGINATION_LOOP", "YouTube repeated a continuation token. The playlist download was stopped to avoid an incomplete backup.", 502);
        }
        seen.add(pageToken);
      }
    } while (pageToken !== undefined);
    return { items, totals };
  }

  private async request(url: URL, init: RequestInit = {}, tokenKind: "read" | "write" = "read"): Promise<unknown> {
    const method = (init.method ?? "GET").toUpperCase();
    // Automatic retries are safe only for idempotent reads. A lost or transient response to a
    // non-idempotent playlist insert/delete could otherwise be retried and duplicate or repeat it.
    const retryable = method === "GET";
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      let token: string;
      try {
        token = tokenKind === "write" ? await this.writeAccessToken!() : await this.accessToken();
      } catch {
        throw new AppError(
          tokenKind === "write" ? "YOUTUBE_WRITE_AUTH_FAILED" : "YOUTUBE_AUTH_FAILED",
          "Unable to obtain YouTube access. Check your Google connection and reconnect if needed.",
          401,
        );
      }
      if (!token) {
        throw new AppError(
          tokenKind === "write" ? "YOUTUBE_WRITE_AUTH_FAILED" : "YOUTUBE_AUTH_FAILED",
          tokenKind === "write"
            ? "Connect write-capable Google access before changing YouTube playlists."
            : "Connect your Google account before reading YouTube playlists.",
          401,
        );
      }
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let response: Response;
      let body: unknown;
      try {
        const result = await Promise.race([
          (async () => {
            const fetched = await this.fetcher(url, {
              ...init,
              method: init.method ?? "GET",
              headers: {
                Authorization: `Bearer ${token}`,
                Accept: "application/json",
                ...(init.body ? { "Content-Type": "application/json" } : {}),
                ...(init.headers ?? {}),
              },
              signal: controller.signal,
              redirect: "error",
            });
            // Error bodies are used only for a small allowlist of quota reason codes.
            const data: unknown = await fetched.json().catch(() => undefined);
            return { response: fetched, body: data };
          })(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              reject(new Error("timeout"));
            }, REQUEST_TIMEOUT_MS);
          }),
        ]);
        response = result.response;
        body = result.body;
      } catch {
        throw new AppError(
          controller.signal.aborted ? "YOUTUBE_TIMEOUT" : "YOUTUBE_NETWORK",
          controller.signal.aborted
            ? "YouTube did not respond in time. Retry the backup."
            : "Unable to reach YouTube. Check your connection and retry.",
          502,
        );
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
      if (response.ok) return body;
      if (response.status === 401) {
        throw new AppError(
          "YOUTUBE_UNAUTHORIZED",
          tokenKind === "write"
            ? "Google write authorization was rejected. Reconnect write access, then retry."
            : "Google authorization was rejected. Reconnect your Google account, then retry.",
          401,
        );
      }
      let rateLimited = response.status === 429;
      if (response.status === 403) {
        const quota = z.object({
          error: z.object({ errors: z.array(z.object({ reason: z.string() })) }),
        }).safeParse(body);
        if (quota.success && quota.data.error.errors.some(({ reason }) =>
          ["quotaExceeded", "dailyLimitExceeded", "dailyLimitExceededUnreg"].includes(reason))) {
          throw new AppError("YOUTUBE_QUOTA", "The YouTube API quota is exhausted. Wait for the quota to reset or review your Google Cloud quota before retrying.", 429);
        }
        rateLimited = quota.success && quota.data.error.errors.some(({ reason }) =>
          ["rateLimitExceeded", "userRateLimitExceeded"].includes(reason));
        if (!rateLimited) {
          throw new AppError("YOUTUBE_FORBIDDEN", "YouTube denied access. Check that the YouTube Data API is enabled and that your account has read access to this playlist.", 403);
        }
      }
      if (response.status === 404) {
        throw new AppError("YOUTUBE_NOT_FOUND", "The YouTube playlist was not found or is no longer accessible.", 404);
      }
      if (rateLimited || response.status >= 500) {
        if (!retryable) {
          throw new AppError(
            "YOUTUBE_MUTATION_FAILED",
            "YouTube rate-limited or temporarily failed this playlist write. Automatic retry was skipped because retrying a non-idempotent change could duplicate or repeat it. Check the playlist state, then retry manually.",
            502,
          );
        }
        if (attempt < MAX_RETRIES) {
          const retryAfter = response.headers.get("retry-after");
          const requested = retryAfter === null ? NaN
            : /^\d+(?:\.\d+)?$/.test(retryAfter.trim())
              ? Number(retryAfter) * 1000
              : Date.parse(retryAfter) - Date.now();
          if (requested > MAX_RETRY_DELAY_MS) {
            throw new AppError(
              "YOUTUBE_RETRY_LATER",
              "YouTube requested a retry delay longer than this backup's 30-second wait limit. No early retry was sent. Wait for YouTube's rate limit to clear, then retry the backup later.",
              503,
            );
          }
          const delay = Math.max(0, Number.isFinite(requested) ? requested : 1000 * 2 ** attempt);
          try {
            await this.sleep(delay);
          } catch {
            throw new AppError("YOUTUBE_RETRY_FAILED", "YouTube request retries were interrupted. Retry the backup.", 503);
          }
          continue;
        }
        throw new AppError(
          "YOUTUBE_RETRY_EXHAUSTED",
          "YouTube is rate-limiting requests or temporarily unavailable. Bounded retries were exhausted; try the backup again later.",
          503,
        );
      }
      throw new AppError(
        tokenKind === "write" ? "YOUTUBE_MUTATION_FAILED" : "YOUTUBE_REQUEST_FAILED",
        tokenKind === "write"
          ? "YouTube could not complete the playlist write. Check your Google write access and retry."
          : "YouTube could not complete the playlist request. Check your Google connection and retry.",
        502,
      );
    }
    throw new AppError("YOUTUBE_REQUEST_FAILED", "YouTube could not complete the playlist request.", 502);
  }
}