import { z } from "zod";
import { AppError } from "../core/errors.js";
import type { Playlist, PlaylistContents, PlaylistEntry, PlaylistProvider } from "../core/models.js";

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

type YouTubeItem = z.infer<typeof itemSchema>;

export interface YouTubeProviderOptions {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export class YouTubeProvider implements PlaylistProvider {
  readonly id = "youtube" as const;
  readonly coverage = "Owned playlists exposed by the official YouTube Data API, including non-music videos; not a complete YouTube Music library. Saved third-party playlists and special Music collections (mixes, audio uploads, liked Music) are outside this backup's coverage. Private/deleted entries may have incomplete metadata. Metadata only; no audio downloads.";
  private readonly fetcher: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly accessToken: () => Promise<string>,
    options: YouTubeProviderOptions = {},
  ) {
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
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
      owner: item.snippet.channelTitle,
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
        throw new AppError("YOUTUBE_RESPONSE_INVALID", "YouTube returned an invalid playlist response. No complete backup can be assumed.", 502);
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

  private async request(url: URL): Promise<unknown> {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      let token: string;
      try {
        token = await this.accessToken();
      } catch {
        throw new AppError("YOUTUBE_AUTH_FAILED", "Unable to obtain YouTube access. Check your Google connection and reconnect if needed.", 401);
      }
      if (!token) {
        throw new AppError("YOUTUBE_AUTH_FAILED", "Connect your Google account before reading YouTube playlists.", 401);
      }
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let response: Response;
      let body: unknown;
      try {
        const result = await Promise.race([
          (async () => {
            const fetched = await this.fetcher(url, {
              method: "GET",
              headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
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
        throw new AppError("YOUTUBE_UNAUTHORIZED", "Google authorization was rejected. Reconnect your Google account, then retry.", 401);
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
      throw new AppError("YOUTUBE_REQUEST_FAILED", "YouTube could not complete the playlist request. Check your Google connection and retry.", 502);
    }
    throw new AppError("YOUTUBE_REQUEST_FAILED", "YouTube could not complete the playlist request.", 502);
  }
}
