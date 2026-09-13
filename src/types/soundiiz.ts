/**
 * Type definitions for the Soundiiz API client.
 */

/** Authentication scheme used to talk to the Soundiiz API. */
export type SoundiizAuthMode = 'token' | 'bearer';

/** Supported local export formats for playlist backups. */
export type ExportFormat = 'json' | 'm3u' | 'csv';

/** Options accepted by the `SoundiizClient` constructor. */
export interface SoundiizClientOptions {
  /** API key used to authenticate requests. Defaults to `SOUNDIIZ_API_KEY`. */
  apiKey?: string;
  /** Base URL of the Soundiiz API. Defaults to `SOUNDIIZ_API_URL` or `https://soundiiz.com/api`. */
  baseUrl?: string;
  /** Header scheme to use for authentication. Defaults to `'token'`. */
  authMode?: SoundiizAuthMode;
  /** Request timeout in milliseconds. Defaults to `15000`. */
  timeout?: number;
  /** Maximum number of retries for retryable errors (429 / 5xx / network). Defaults to `3`. */
  maxRetries?: number;
  /** Base delay in milliseconds used for exponential backoff between retries. Defaults to `500`. */
  retryDelayMs?: number;
  /** Maximum delay in milliseconds allowed between retries. Defaults to `10000`. */
  maxRetryDelayMs?: number;
}

/** Authenticated user information returned by the Soundiiz API. */
export interface SoundiizUser {
  id: string;
  email?: string;
  username?: string;
  plan?: string;
  [key: string]: unknown;
}

/** A playlist as represented by the Soundiiz API. */
export interface SoundiizPlaylist {
  id: string;
  title: string;
  description?: string;
  platform?: string;
  tracksCount?: number;
  url?: string;
  [key: string]: unknown;
}

/** A single track belonging to a playlist. */
export interface SoundiizTrack {
  id?: string;
  title: string;
  artist: string;
  album?: string;
  isrc?: string;
  duration?: number;
  [key: string]: unknown;
}

/** A configured sync between two playlists on (potentially) different platforms. */
export interface SoundiizSync {
  id: string;
  sourcePlaylistId: string;
  targetPlaylistId: string;
  sourcePlatform: string;
  targetPlatform: string;
  status?: string;
  lastRunAt?: string;
  [key: string]: unknown;
}

/** Result of manually triggering a sync. */
export interface SoundiizSyncTriggerResult {
  syncId: string;
  status: string;
  [key: string]: unknown;
}

/** Generic paginated collection returned by list endpoints. */
export interface SoundiizPaginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total?: number;
  hasMore: boolean;
}

/** Options controlling pagination when fetching playlist tracks. */
export interface GetPlaylistTracksOptions {
  /** Page number to start fetching from (1-indexed). Defaults to `1`. */
  page?: number;
  /** Number of items requested per page. */
  pageSize?: number;
  /** When `true`, automatically follow pagination and return every track. Defaults to `true`. */
  fetchAllPages?: boolean;
}

/** Result of exporting a playlist to a local backup format. */
export interface ExportedPlaylistFile {
  playlistId: string;
  format: ExportFormat;
  filename: string;
  content: string;
}

/** Normalized error thrown by the `SoundiizClient` for any failed request. */
export class SoundiizApiError extends Error {
  /** HTTP status code, if the failure originated from an HTTP response. */
  public readonly status?: number;
  /** Machine readable error code returned by the API, if any. */
  public readonly code?: string;
  /** Raw response body / details, if available. */
  public readonly details?: unknown;
  /** Whether the request was retried before ultimately failing. */
  public readonly retryable: boolean;

  constructor(message: string, options: { status?: number; code?: string; details?: unknown; retryable?: boolean } = {}) {
    super(message);
    this.name = 'SoundiizApiError';
    this.status = options.status;
    this.code = options.code;
    this.details = options.details;
    this.retryable = options.retryable ?? false;
  }
}
