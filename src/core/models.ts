export type ProviderId = "youtube" | "spotify";

export interface Playlist {
  provider: ProviderId;
  id: string;
  title: string;
  description: string;
  url: string;
  owner: string;
  itemCount: number | null;
  visibility: "public" | "private" | "unlisted" | "unknown";
  snapshotId?: string;
}

export interface PlaylistEntry {
  id: string;
  position: number;
  mediaId: string | null;
  title: string;
  artist: string | null;
  album: string | null;
  url: string | null;
  availability: "available" | "unavailable" | "unknown";
  addedAt: string | null;
  providerData: Record<string, unknown>;
}

export interface PlaylistContents {
  playlist: Playlist;
  entries: PlaylistEntry[];
  warnings: string[];
}

export interface PlaylistProvider {
  readonly id: ProviderId;
  readonly coverage: string;
  listPlaylists(): Promise<Playlist[]>;
  getPlaylist(playlist: Playlist): Promise<PlaylistContents>;
}

export interface PlaylistArchive extends PlaylistContents {
  schemaVersion: 1;
  exportedAt: string;
  fingerprint: string;
}

export interface ExportIntegrity {
  size: number;
  sha256: string;
}

export interface BackupPlaylistResult {
  playlistId: string;
  title: string;
  status: "complete" | "failed";
  entries: number;
  files: { json: string; csv: string; m3u: string } | null;
  fingerprint: string | null;
  warnings: string[];
  error: string | null;
  /** Original export bytes; omitted for failed or legacy results, never inferred from disk. */
  integrity?: { json: ExportIntegrity; csv: ExportIntegrity; m3u: ExportIntegrity } | undefined;
}

export interface BackupManifest {
  schemaVersion: 1;
  id: string;
  provider: ProviderId;
  startedAt: string;
  completedAt: string | null;
  status: "running" | "complete" | "partial" | "failed" | "interrupted";
  coverage: string;
  warnings: string[];
  playlists: BackupPlaylistResult[];
  totals: { playlists: number; completed: number; failed: number; entries: number };
  error: string | null;
}

export interface BackupProgress {
  total: number;
  current: number;
  playlistTitle: string | null;
}
