/**
 * Typed SDK for the Soundiiz API.
 *
 * Provides authenticated access to playlists, tracks, syncs and local export
 * helpers, with built-in retry/backoff handling for rate limiting (HTTP 429)
 * and transient server/network errors.
 */
import axios, { AxiosError, AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import {
  ExportedPlaylistFile,
  ExportFormat,
  GetPlaylistTracksOptions,
  SoundiizApiError,
  SoundiizAuthMode,
  SoundiizClientOptions,
  SoundiizPaginated,
  SoundiizPlaylist,
  SoundiizSync,
  SoundiizSyncTriggerResult,
  SoundiizTrack,
  SoundiizUser,
} from '../types/soundiiz.js';

const DEFAULT_BASE_URL = 'https://soundiiz.com/api';
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 500;
const DEFAULT_MAX_RETRY_DELAY_MS = 10_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Extracts a `{ items, page, ... }`-shaped payload from varying API response envelopes. */
function normalizePaginated<T>(data: unknown, fallbackItemsKey = 'items'): SoundiizPaginated<T> {
  const body = (data ?? {}) as Record<string, unknown>;
  const items =
    (Array.isArray(body[fallbackItemsKey]) && (body[fallbackItemsKey] as T[])) ||
    (Array.isArray(body.data) && (body.data as T[])) ||
    (Array.isArray(body) && (body as unknown as T[])) ||
    [];
  const page = typeof body.page === 'number' ? body.page : 1;
  const pageSize = typeof body.pageSize === 'number' ? body.pageSize : items.length;
  const total = typeof body.total === 'number' ? body.total : undefined;
  const hasMore =
    typeof body.hasMore === 'boolean'
      ? body.hasMore
      : total !== undefined
      ? page * pageSize < total
      : false;

  return { items, page, pageSize, total, hasMore };
}

/**
 * Client for the Soundiiz API.
 *
 * @example
 * ```ts
 * const client = new SoundiizClient({ apiKey: process.env.SOUNDIIZ_API_KEY });
 * const me = await client.getMe();
 * const playlists = await client.getUserPlaylists('spotify');
 * ```
 */
export class SoundiizClient {
  private readonly http: AxiosInstance;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly maxRetryDelayMs: number;

  constructor(options: SoundiizClientOptions = {}) {
    const apiKey = options.apiKey ?? process.env.SOUNDIIZ_API_KEY ?? '';
    const baseUrl =
      options.baseUrl ?? process.env.SOUNDIIZ_API_URL ?? process.env.SOUNDIIZ_BASE_URL ?? DEFAULT_BASE_URL;
    const authMode: SoundiizAuthMode = options.authMode ?? 'token';

    if (!apiKey) {
      // Not fatal: allows constructing a client to inspect config/tests, but every
      // request will fail fast with a clear error instead of an opaque 401.
      // eslint-disable-next-line no-console
      console.warn('[SoundiizClient] No API key provided. Set SOUNDIIZ_API_KEY or pass { apiKey }.');
    }

    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;

    this.http = axios.create({
      baseURL: baseUrl,
      timeout: options.timeout ?? DEFAULT_TIMEOUT_MS,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(authMode === 'bearer'
          ? { Authorization: `Bearer ${apiKey}` }
          : { 'x-soundiiz-token': apiKey }),
      },
    });
  }

  /** Exposes the underlying axios instance for advanced use cases (e.g. custom requests). */
  public getHttpClient(): AxiosInstance {
    return this.http;
  }

  /** Validate the configured API key and fetch the authenticated user's profile. */
  public async getMe(): Promise<SoundiizUser> {
    return this.request<SoundiizUser>({ method: 'GET', url: '/me' });
  }

  /** Fetch the authenticated user's playlists, optionally filtered by platform. */
  public async getUserPlaylists(platform?: string): Promise<SoundiizPlaylist[]> {
    const data = await this.request<unknown>({
      method: 'GET',
      url: '/playlists',
      params: platform ? { platform } : undefined,
    });
    const body = (data ?? {}) as Record<string, unknown>;
    if (Array.isArray(data)) {
      return data as SoundiizPlaylist[];
    }
    if (Array.isArray(body.playlists)) {
      return body.playlists as SoundiizPlaylist[];
    }
    if (Array.isArray(body.items)) {
      return body.items as SoundiizPlaylist[];
    }
    return [];
  }

  /** Get metadata for a single playlist. */
  public async getPlaylist(playlistId: string): Promise<SoundiizPlaylist> {
    this.assertId(playlistId, 'playlistId');
    return this.request<SoundiizPlaylist>({ method: 'GET', url: `/playlists/${encodeURIComponent(playlistId)}` });
  }

  /**
   * Fetch the tracklist for a playlist.
   *
   * By default all pages are followed automatically and the full track list is
   * returned. Pass `{ fetchAllPages: false }` to retrieve a single page.
   */
  public async getPlaylistTracks(
    playlistId: string,
    options: GetPlaylistTracksOptions = {},
  ): Promise<SoundiizTrack[]> {
    this.assertId(playlistId, 'playlistId');
    const fetchAllPages = options.fetchAllPages ?? true;
    const pageSize = options.pageSize;

    let page = options.page ?? 1;
    const tracks: SoundiizTrack[] = [];

    // Loop guard: even in "fetch all" mode we cap iterations to avoid runaway
    // requests if an API misreports `hasMore`.
    const maxPages = fetchAllPages ? 1000 : 1;

    for (let i = 0; i < maxPages; i += 1) {
      const data = await this.request<unknown>({
        method: 'GET',
        url: `/playlists/${encodeURIComponent(playlistId)}/tracks`,
        params: { page, ...(pageSize ? { pageSize } : {}) },
      });
      const result = normalizePaginated<SoundiizTrack>(data, 'tracks');
      tracks.push(...result.items);

      if (!fetchAllPages || !result.hasMore || result.items.length === 0) {
        break;
      }
      page += 1;
    }

    return tracks;
  }

  /**
   * Retrieve a playlist's tracks formatted for a local backup file.
   *
   * Supported formats: `json`, `m3u`, `csv`.
   */
  public async exportPlaylistFile(playlistId: string, format: ExportFormat): Promise<ExportedPlaylistFile> {
    this.assertId(playlistId, 'playlistId');
    if (!['json', 'm3u', 'csv'].includes(format)) {
      throw new SoundiizApiError(`Unsupported export format: ${String(format)}`, { retryable: false });
    }

    const [playlist, tracks] = await Promise.all([
      this.getPlaylist(playlistId),
      this.getPlaylistTracks(playlistId),
    ]);

    const content = this.formatTracks(tracks, format);
    const filename = `${this.slugify(playlist.title || playlistId)}.${format}`;

    return { playlistId, format, filename, content };
  }

  /** List the syncs configured for the authenticated user. */
  public async getSyncs(): Promise<SoundiizSync[]> {
    const data = await this.request<unknown>({ method: 'GET', url: '/syncs' });
    const body = (data ?? {}) as Record<string, unknown>;
    if (Array.isArray(data)) {
      return data as SoundiizSync[];
    }
    if (Array.isArray(body.syncs)) {
      return body.syncs as SoundiizSync[];
    }
    if (Array.isArray(body.items)) {
      return body.items as SoundiizSync[];
    }
    return [];
  }

  /** Manually trigger an existing sync by id. */
  public async triggerSync(syncId: string): Promise<SoundiizSyncTriggerResult> {
    this.assertId(syncId, 'syncId');
    return this.request<SoundiizSyncTriggerResult>({
      method: 'POST',
      url: `/syncs/${encodeURIComponent(syncId)}/run`,
    });
  }

  private assertId(value: string, name: string): void {
    if (!value || typeof value !== 'string') {
      throw new SoundiizApiError(`${name} is required`, { retryable: false });
    }
  }

  private formatTracks(tracks: SoundiizTrack[], format: ExportFormat): string {
    switch (format) {
      case 'json':
        return JSON.stringify(tracks, null, 2);
      case 'm3u': {
        const lines = ['#EXTM3U'];
        for (const track of tracks) {
          const duration = track.duration ?? -1;
          lines.push(`#EXTINF:${duration},${track.artist} - ${track.title}`);
          lines.push(String(track.url ?? track.id ?? `${track.artist} - ${track.title}`));
        }
        return lines.join('\n');
      }
      case 'csv': {
        const header = 'title,artist,album,isrc,duration';
        const escape = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`;
        const rows = tracks.map((t) =>
          [escape(t.title), escape(t.artist), escape(t.album), escape(t.isrc), escape(t.duration)].join(','),
        );
        return [header, ...rows].join('\n');
      }
      default:
        throw new SoundiizApiError(`Unsupported export format: ${String(format)}`, { retryable: false });
    }
  }

  private slugify(value: string): string {
    return value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '') || 'playlist';
  }

  /**
   * Performs an HTTP request with automatic retry/backoff for rate limiting
   * (HTTP 429) and transient failures (5xx / network errors), and normalizes
   * failures into `SoundiizApiError`.
   */
  private async request<T>(config: AxiosRequestConfig): Promise<T> {
    let attempt = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        const response: AxiosResponse<T> = await this.http.request<T>(config);
        return response.data;
      } catch (error) {
        const axiosError = error as AxiosError;
        const status = axiosError.response?.status;
        const isRetryable = this.isRetryableError(axiosError);

        if (isRetryable && attempt < this.maxRetries) {
          const delay = this.getRetryDelay(axiosError, attempt);
          attempt += 1;
          await sleep(delay);
          continue;
        }

        throw this.toApiError(axiosError, status, isRetryable);
      }
    }
  }

  private isRetryableError(error: AxiosError): boolean {
    if (!error.response) {
      // Network error / timeout - retryable.
      return true;
    }
    const status = error.response.status;
    return status === 429 || (status >= 500 && status < 600);
  }

  private getRetryDelay(error: AxiosError, attempt: number): number {
    const retryAfterHeader = error.response?.headers?.['retry-after'];
    if (retryAfterHeader) {
      const parsed = Number(retryAfterHeader);
      if (!Number.isNaN(parsed)) {
        return Math.min(parsed * 1000, this.maxRetryDelayMs);
      }
      const retryAfterDate = new Date(String(retryAfterHeader)).getTime();
      if (!Number.isNaN(retryAfterDate)) {
        return Math.min(Math.max(retryAfterDate - Date.now(), 0), this.maxRetryDelayMs);
      }
    }
    // Exponential backoff with jitter.
    const exponential = this.retryDelayMs * 2 ** attempt;
    const jitter = Math.random() * this.retryDelayMs;
    return Math.min(exponential + jitter, this.maxRetryDelayMs);
  }

  private toApiError(error: AxiosError, status: number | undefined, retryable: boolean): SoundiizApiError {
    const data = error.response?.data as Record<string, unknown> | undefined;
    const code = (data?.code as string | undefined) ?? error.code;
    const message =
      (data?.message as string | undefined) ??
      (data?.error as string | undefined) ??
      error.message ??
      'Soundiiz API request failed';

    return new SoundiizApiError(message, { status, code, details: data ?? error.toJSON?.(), retryable });
  }
}

export default SoundiizClient;
