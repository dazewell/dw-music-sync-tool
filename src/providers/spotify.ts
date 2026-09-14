import { z } from "zod";
import { AppError } from "../core/errors.js";
import type { Playlist, PlaylistContents, PlaylistEntry, PlaylistMutation, PlaylistProvider } from "../core/models.js";

const API_ROOT = "https://api.spotify.com/v1/";
// The playlist-items endpoint can return a track, a podcast episode, or a local file under
// the same "track" key. Episodes/local files are not addressable by spotify:track URIs, so
// only "name" is guaranteed; every other field is optional and validated defensively.
const trackSchema = z.object({
  type: z.string().optional(),
  id: z.string().nullable().optional(),
  uri: z.string().nullable().optional(),
  name: z.string().optional(),
  artists: z.array(z.object({ name: z.string() })).optional(),
  album: z.object({ name: z.string() }).optional(),
  external_urls: z.object({ spotify: z.string() }).optional(),
  duration_ms: z.number().int().nonnegative().optional(),
  external_ids: z.object({ isrc: z.string().optional() }).optional(),
}).nullable();
const itemSchema = z.object({
  added_at: z.string().nullable().optional(),
  is_local: z.boolean().optional(),
  track: trackSchema,
});
const pageSchema = z.object({
  items: z.array(itemSchema),
  next: z.string().url().nullable().optional(),
  total: z.number().int().nonnegative().optional(),
});
const playlistPageSchema = z.object({
  items: z.array(z.object({
    id: z.string().min(1), name: z.string(), description: z.string().optional(),
    owner: z.object({ id: z.string().optional() }).optional(),
    public: z.boolean().optional(), collaborative: z.boolean().optional(),
    tracks: z.object({ total: z.number().int().nonnegative().optional() }).optional(),
    external_urls: z.object({ spotify: z.string().url().optional() }).optional(),
  })),
  next: z.string().url().nullable().optional(),
});
const snapshotSchema = z.object({ snapshot_id: z.string().min(1) });

/** Continuation URLs come from responses; they must never send the token elsewhere. */
function requireApiUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new AppError("SPOTIFY_RESPONSE_INVALID", "Spotify returned an unusable continuation URL.", 502);
  }
  if (!parsed.href.startsWith(API_ROOT)) {
    throw new AppError("SPOTIFY_RESPONSE_INVALID", "Spotify returned a continuation URL outside the Spotify Web API.", 502);
  }
  return parsed.href;
}

export interface SpotifyProviderOptions {
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
}

export class SpotifyProvider implements PlaylistProvider, PlaylistMutation {
  readonly id = "spotify" as const;
  readonly coverage = "Spotify playlists available to the authenticated account, subject to Spotify account and application access.";
  private readonly fetcher: typeof fetch;
  private readonly timeout: number;

  constructor(private readonly accessToken: () => Promise<string>, options: SpotifyProviderOptions = {}) {
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.timeout = options.requestTimeoutMs ?? 20_000;
  }

  async listPlaylists(): Promise<Playlist[]> {
    const result: Playlist[] = [];
    let next: string | null = `${API_ROOT}me/playlists?limit=50`;
    const seen = new Set<string>();
    while (next) {
      if (seen.has(next)) throw new AppError("SPOTIFY_PAGINATION_LOOP", "Spotify repeated a continuation URL.", 502);
      seen.add(next);
      const page = playlistPageSchema.safeParse(await this.request(next));
      if (!page.success) throw new AppError("SPOTIFY_RESPONSE_INVALID", "Spotify returned an invalid playlist page.", 502);
      for (const item of page.data.items) {
        const raw = item;
        result.push({
          provider: this.id, id: raw.id, title: raw.name, description: raw.description ?? "",
          url: raw.external_urls?.spotify ?? `https://open.spotify.com/playlist/${encodeURIComponent(raw.id)}`,
          owner: raw.owner?.id ?? "", itemCount: raw.tracks?.total ?? null,
          visibility: raw.collaborative ? "unknown" : raw.public ? "public" : "private",
        });
      }
      next = page.data.next ? requireApiUrl(page.data.next) : null;
    }
    return result;
  }

  /** Fetches the playlist's current snapshot_id from a fresh read, independent of any cached value. */
  private async currentSnapshot(playlistId: string): Promise<string> {
    const parsed = snapshotSchema.safeParse(
      await this.request(`${API_ROOT}playlists/${encodeURIComponent(playlistId)}?fields=snapshot_id`),
    );
    if (!parsed.success) throw new AppError("SPOTIFY_RESPONSE_INVALID", "Spotify did not return a playlist snapshot id.", 502);
    return parsed.data.snapshot_id;
  }

  async getPlaylist(playlist: Playlist): Promise<PlaylistContents> {
    if (playlist.provider !== this.id || !playlist.id) throw new AppError("SPOTIFY_PLAYLIST_INVALID", "A Spotify playlist is required.", 400);
    const snapshotId = await this.currentSnapshot(playlist.id);
    const entries: PlaylistEntry[] = [];
    let next: string | null = `${API_ROOT}playlists/${encodeURIComponent(playlist.id)}/items?limit=50&fields=items(added_at,is_local,track(type,id,uri,name,artists,album,external_urls,duration_ms,external_ids)),next,total`;
    const seen = new Set<string>();
    while (next) {
      if (seen.has(next)) throw new AppError("SPOTIFY_PAGINATION_LOOP", "Spotify repeated a continuation URL.", 502);
      seen.add(next);
      const page = pageSchema.safeParse(await this.request(next));
      if (!page.success) throw new AppError("SPOTIFY_RESPONSE_INVALID", "Spotify returned an invalid playlist item page.", 502);
      for (const item of page.data.items) {
        const track = item.track;
        const position = entries.length;
        const unsupported = item.is_local === true || (track !== null && track.type !== undefined && track.type !== "track");
        if (unsupported) {
          // Local files and podcast episodes cannot be addressed by a spotify:track URI; preserve
          // them as unavailable placeholders instead of dropping them or failing validation.
          entries.push({
            id: `spotify-unsupported-${position}`, position,
            mediaId: null, title: track?.name ?? "Unsupported Spotify item",
            artist: track?.artists?.map(artist => artist.name).join(", ") || null,
            album: track?.album?.name ?? null, url: track?.external_urls?.spotify ?? null,
            availability: "unavailable", addedAt: item.added_at ?? null,
            providerData: {},
          });
          continue;
        }
        entries.push({
          id: track?.uri ?? `spotify-unavailable-${position}`, position,
          mediaId: track?.id ?? null, title: track?.name ?? "Unavailable track",
          artist: track?.artists?.map(artist => artist.name).join(", ") || null,
          album: track?.album?.name ?? null, url: track?.external_urls?.spotify ?? null,
          availability: track?.id ? "available" : "unavailable", addedAt: item.added_at ?? null,
          providerData: track ? { uri: track.uri, isrc: track.external_ids?.isrc, durationMs: track.duration_ms } : {},
        });
      }
      next = page.data.next ? requireApiUrl(page.data.next) : null;
    }
    return {
      playlist: { ...playlist, snapshotId },
      entries,
      warnings: entries.some(entry => entry.availability === "unavailable") ? ["Unavailable Spotify items were preserved."] : [],
    };
  }

  async replacePlaylist(playlist: Playlist, entries: readonly PlaylistEntry[], expectedSnapshotId?: string): Promise<void> {
    if (playlist.provider !== this.id) throw new AppError("SPOTIFY_PLAYLIST_INVALID", "A Spotify playlist is required.", 400);
    // Validate every target-native URI before any destructive request is issued: an unsupported
    // entry must never leave the playlist partially or fully emptied.
    const uris = entries.map(entry => typeof entry.providerData.uri === "string" ? entry.providerData.uri : null);
    if (uris.some(uri => uri === null || !uri.startsWith("spotify:track:"))) {
      throw new AppError("SPOTIFY_ENTRY_UNSUPPORTED", "Every synchronized entry needs an explicit Spotify track URI.", 409);
    }
    const validatedUris = uris as string[];
    // Re-read the playlist and its snapshot fresh; a cached/passed-in snapshot cannot protect
    // against a concurrent edit that happened after the caller last observed the playlist.
    const current = await this.getPlaylist(playlist);
    if (expectedSnapshotId !== undefined && current.playlist.snapshotId !== expectedSnapshotId) {
      throw new AppError("SPOTIFY_STALE_PLAYLIST", "The Spotify playlist changed before the sync could be applied.", 409);
    }
    // getPlaylist deliberately preserves local files/episodes as unaddressable placeholders
    // (no spotify:track URI). They cannot be targeted by a DELETE by URI, so silently skipping
    // them here would leave them behind while everything else is deleted and re-inserted,
    // producing a mixed/duplicated playlist that only surfaces as a failure later, after the
    // destructive request already ran. Fail closed before issuing any request instead.
    if (current.entries.some(entry => typeof entry.providerData.uri !== "string")) {
      throw new AppError(
        "SPOTIFY_ENTRY_UNSUPPORTED",
        "The current Spotify playlist has a local file or episode that cannot be addressed by a track URI; remove or resolve it manually before syncing this playlist.",
        409,
      );
    }
    const tracks = current.entries
      .map((entry, position) => ({ uri: typeof entry.providerData.uri === "string" ? entry.providerData.uri : null, positions: [position] }))
      .filter((track): track is { uri: string; positions: number[] } => track.uri !== null);
    if (tracks.length) {
      await this.request(`${API_ROOT}playlists/${encodeURIComponent(playlist.id)}/items`, {
        method: "DELETE",
        body: JSON.stringify({ tracks, snapshot_id: current.playlist.snapshotId }),
      });
    }
    for (let index = 0; index < validatedUris.length; index += 100) {
      await this.request(`${API_ROOT}playlists/${encodeURIComponent(playlist.id)}/items`, {
        method: "POST",
        body: JSON.stringify({ uris: validatedUris.slice(index, index + 100) }),
      });
    }
  }

  private async request(url: string, init: RequestInit = {}): Promise<unknown> {
    let token: string;
    try { token = await this.accessToken(); } catch { throw new AppError("SPOTIFY_AUTH_FAILED", "Unable to obtain Spotify access.", 401); }
    if (!token) throw new AppError("SPOTIFY_AUTH_FAILED", "Connect Spotify before synchronizing playlists.", 401);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      const response = await this.fetcher(url, { ...init, headers: { Accept: "application/json", Authorization: `Bearer ${token}`, ...(init.body ? { "Content-Type": "application/json" } : {}), ...(init.headers ?? {}) }, signal: controller.signal, redirect: "error" });
      const body: unknown = await response.json().catch(() => undefined);
      if (!response.ok) {
        if (response.status === 401) throw new AppError("SPOTIFY_UNAUTHORIZED", "Spotify authorization was rejected.", 401);
        if (response.status === 403) throw new AppError("SPOTIFY_FORBIDDEN", "Spotify denied playlist access or mutation.", 403);
        if (response.status === 404) throw new AppError("SPOTIFY_NOT_FOUND", "The Spotify playlist was not found or is unavailable.", 404);
        if (response.status === 429) throw new AppError("SPOTIFY_RATE_LIMITED", "Spotify rate-limited the request; retry later.", 429);
        throw new AppError("SPOTIFY_REQUEST_FAILED", "Spotify could not complete the playlist request.", 502);
      }
      return body;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(controller.signal.aborted ? "SPOTIFY_TIMEOUT" : "SPOTIFY_NETWORK", controller.signal.aborted ? "Spotify did not respond in time." : "Unable to reach Spotify.", 502);
    } finally { clearTimeout(timer); }
  }
}