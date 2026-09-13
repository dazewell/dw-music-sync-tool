import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { SoundiizClient } from '../api/soundiizClient.js';
import {
  SoundiizClientOptions,
  SoundiizPlaylist,
  SoundiizTrack,
} from '../types/soundiiz.js';

export type BackupFormat = 'json' | 'm3u' | 'm3u8' | 'csv';

export interface BackupProgress {
  current: number;
  total: number;
  playlistName: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  error?: string;
}

export type ProgressCallback = (
  current: number,
  total: number,
  playlistName: string,
  progress?: BackupProgress,
) => void;

export interface BackupOptions {
  /** Target directory where backup files and/or manifest will be saved. Defaults to `./backups`. */
  outputDir?: string;
  /** Platform filter: 'youtube' | 'youtubeMusic' | 'spotify' | 'all' | string. */
  platform?: string;
  /** Export format: 'json' | 'm3u' | 'm3u8' | 'csv'. Defaults to 'json'. */
  format?: BackupFormat;
  /** Save individual files per playlist. Defaults to true. */
  saveIndividualFiles?: boolean;
  /** Create a master combined backup manifest (manifest.json). Defaults to true. */
  createManifest?: boolean;
  /** Optional playlist IDs to include in this backup. */
  playlistIds?: string[];
  /** Callback for progress updates. */
  onProgress?: ProgressCallback;
}

export interface BackupPlaylistSummary {
  id: string;
  title: string;
  platform?: string;
  trackCount: number;
  filename?: string;
  filePath?: string;
}

export interface BackupFailureSummary {
  id: string;
  title: string;
  platform?: string;
  error: string;
}

export interface BackupManifest {
  timestamp: string;
  totalPlaylists: number;
  successfulPlaylists: number;
  failedPlaylists: number;
  totalTracks: number;
  platform: string;
  format: BackupFormat;
  playlists: BackupPlaylistSummary[];
  failures: BackupFailureSummary[];
}

export interface BackupResult {
  outputDir: string;
  manifestPath?: string;
  manifest?: BackupManifest;
  successfulPlaylists: BackupPlaylistSummary[];
  failedPlaylists: BackupFailureSummary[];
  totalTracks: number;
}

/**
 * Sanitizes a playlist title for use in filesystem paths.
 * Replaces illegal characters on Windows and Unix filesystems.
 */
export function sanitizeFilename(name: string): string {
  if (!name || typeof name !== 'string') {
    return 'unnamed-playlist';
  }

  let sanitized = name
    .toLowerCase()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim();

  sanitized = sanitized.replace(/^[.-]+|[. -]+$/g, '');

  if (!sanitized) {
    return 'unnamed-playlist';
  }

  const reservedRegex = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
  if (reservedRegex.test(sanitized)) {
    sanitized = `_${sanitized}`;
  }

  return sanitized;
}

/**
 * Checks if a playlist's platform matches the requested target platform filter.
 * Handles 'youtube' and 'youtubeMusic' as equivalent aliases.
 */
export function isPlatformMatch(playlistPlatform?: string, targetPlatform?: string): boolean {
  if (!targetPlatform || targetPlatform.toLowerCase() === 'all' || targetPlatform === '*') {
    return true;
  }
  if (!playlistPlatform) {
    return false;
  }

  const normPlaylist = playlistPlatform.toLowerCase().trim();
  const normTarget = targetPlatform.toLowerCase().trim();

  const isYtmTarget = normTarget === 'youtube' || normTarget === 'youtubemusic' || normTarget === 'ytm';
  const isYtmPlaylist = normPlaylist === 'youtube' || normPlaylist === 'youtubemusic' || normPlaylist === 'ytm';

  if (isYtmTarget && isYtmPlaylist) {
    return true;
  }

  return normPlaylist === normTarget;
}

/**
 * Formats tracks into the requested local backup format string (JSON, M3U/M3U8, CSV).
 */
export function formatTracks(tracks: SoundiizTrack[], format: BackupFormat): string {
  switch (format) {
    case 'json':
      return JSON.stringify(tracks, null, 2);
    case 'm3u':
    case 'm3u8': {
      const lines = ['#EXTM3U'];
      for (const track of tracks) {
        const duration = typeof track.duration === 'number' ? track.duration : -1;
        const artist = track.artist || 'Unknown Artist';
        const title = track.title || 'Unknown Title';
        lines.push(`#EXTINF:${duration},${artist} - ${title}`);
        const location = String(track.url || track.id || `${artist} - ${title}`);
        lines.push(location);
      }
      return lines.join('\n');
    }
    case 'csv': {
      const header = 'title,artist,album,isrc,duration';
      const escape = (val: unknown) => `"${String(val ?? '').replace(/"/g, '""')}"`;
      const rows = tracks.map((t) =>
        [escape(t.title), escape(t.artist), escape(t.album), escape(t.isrc), escape(t.duration)].join(','),
      );
      return [header, ...rows].join('\n');
    }
    default:
      throw new Error(`Unsupported export format: ${String(format)}`);
  }
}

/**
 * Service for backing up and exporting playlists across platforms.
 */
export class BackupEngine extends EventEmitter {
  private client: SoundiizClient;

  constructor(clientOrOptions?: SoundiizClient | SoundiizClientOptions) {
    super();
    if (clientOrOptions instanceof SoundiizClient) {
      this.client = clientOrOptions;
    } else {
      this.client = new SoundiizClient(clientOrOptions);
    }
  }

  /**
   * Executes a playlist backup job based on the specified options.
   */
  public async backup(options: BackupOptions = {}): Promise<BackupResult> {
    const outputDir = path.resolve(options.outputDir ?? './backups');
    const platform = options.platform ?? 'all';
    const format: BackupFormat = options.format ?? 'json';
    const saveIndividualFiles = options.saveIndividualFiles ?? true;
    const createManifest = options.createManifest ?? true;

    const requestedPlatformArg = (platform && platform.toLowerCase() !== 'all') ? platform : undefined;
    const rawPlaylists = await this.client.getUserPlaylists(requestedPlatformArg);

    const selectedIds = options.playlistIds ? new Set(options.playlistIds) : undefined;
    const playlists = rawPlaylists.filter((p) =>
      isPlatformMatch(p.platform, platform) && (!selectedIds || selectedIds.has(p.id)),
    );

    const total = playlists.length;
    const successfulPlaylists: BackupPlaylistSummary[] = [];
    const failedPlaylists: BackupFailureSummary[] = [];
    let totalTracks = 0;

    const usedFilenames = new Set<string>();

    for (let i = 0; i < total; i++) {
      const playlist = playlists[i];
      const current = i + 1;

      this.notifyProgress(options, current, total, playlist.title, 'in_progress');

      try {
        const tracks = await this.client.getPlaylistTracks(playlist.id);

        let filename: string | undefined;
        let filePath: string | undefined;

        if (saveIndividualFiles) {
          if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
          }

          const baseSanitized = sanitizeFilename(playlist.title);
          const ext = format === 'm3u8' ? 'm3u8' : format;
          let candidateFilename = `${baseSanitized}.${ext}`;

          if (usedFilenames.has(candidateFilename.toLowerCase())) {
            candidateFilename = `${baseSanitized}_${sanitizeFilename(playlist.id)}.${ext}`;
          }
          let counter = 2;
          while (usedFilenames.has(candidateFilename.toLowerCase())) {
            candidateFilename = `${baseSanitized}_${counter}.${ext}`;
            counter++;
          }
          usedFilenames.add(candidateFilename.toLowerCase());

          filename = candidateFilename;
          filePath = path.join(outputDir, filename);

          const content = formatTracks(tracks, format);
          await fs.promises.writeFile(filePath, content, 'utf8');
        }

        totalTracks += tracks.length;
        const summary: BackupPlaylistSummary = {
          id: playlist.id,
          title: playlist.title,
          platform: playlist.platform,
          trackCount: tracks.length,
          filename,
          filePath,
        };
        successfulPlaylists.push(summary);

        this.notifyProgress(options, current, total, playlist.title, 'completed');
      } catch (error: any) {
        const errorMessage = error?.message || String(error);
        failedPlaylists.push({
          id: playlist.id,
          title: playlist.title,
          platform: playlist.platform,
          error: errorMessage,
        });

        this.notifyProgress(options, current, total, playlist.title, 'failed', errorMessage);
      }
    }

    let manifestPathWritten: string | undefined;
    let manifestData: BackupManifest | undefined;

    if (createManifest) {
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }

      manifestData = {
        timestamp: new Date().toISOString(),
        totalPlaylists: total,
        successfulPlaylists: successfulPlaylists.length,
        failedPlaylists: failedPlaylists.length,
        totalTracks,
        platform,
        format,
        playlists: successfulPlaylists,
        failures: failedPlaylists,
      };

      manifestPathWritten = path.join(outputDir, 'manifest.json');
      await fs.promises.writeFile(manifestPathWritten, JSON.stringify(manifestData, null, 2), 'utf8');
    }

    return {
      outputDir,
      manifestPath: manifestPathWritten,
      manifest: manifestData,
      successfulPlaylists,
      failedPlaylists,
      totalTracks,
    };
  }

  private notifyProgress(
    options: BackupOptions,
    current: number,
    total: number,
    playlistName: string,
    status: 'pending' | 'in_progress' | 'completed' | 'failed',
    error?: string,
  ) {
    const progress: BackupProgress = { current, total, playlistName, status, error };
    this.emit('progress', current, total, playlistName, progress);
    this.emit('status', progress);
    if (options.onProgress) {
      options.onProgress(current, total, playlistName, progress);
    }
  }
}

