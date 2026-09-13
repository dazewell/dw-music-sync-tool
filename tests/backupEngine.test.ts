import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  BackupEngine,
  sanitizeFilename,
  isPlatformMatch,
  formatTracks,
  BackupProgress,
} from '../src/services/backupEngine.js';
import { SoundiizClient } from '../src/api/soundiizClient.js';
import { SoundiizPlaylist, SoundiizTrack } from '../src/types/soundiiz.js';

// Mock SoundiizClient
vi.mock('../src/api/soundiizClient.js', () => {
  const SoundiizClient = vi.fn();
  return { SoundiizClient };
});

const TEST_OUTPUT_DIR = path.resolve('./test-backup-output');

function cleanupTestDir() {
  if (fs.existsSync(TEST_OUTPUT_DIR)) {
    fs.rmSync(TEST_OUTPUT_DIR, { recursive: true, force: true });
  }
}

describe('BackupEngine - Helper Functions', () => {
  describe('sanitizeFilename', () => {
    it('sanitizes invalid filesystem characters on Windows and Unix', () => {
      expect(sanitizeFilename('Rock & Roll: Best Of / 2024?')).toBe('rock-&-roll_-best-of-_-2024_');
      expect(sanitizeFilename('Track <1> * 2 | 3 "Quotes"')).toBe('track-_1_-_-2-_-3-_quotes_');
      expect(sanitizeFilename('Trailing spaces and dots...   ')).toBe('trailing-spaces-and-dots');
    });

    it('handles Windows reserved filenames', () => {
      expect(sanitizeFilename('CON')).toBe('_con');
      expect(sanitizeFilename('aux')).toBe('_aux');
      expect(sanitizeFilename('NUL')).toBe('_nul');
      expect(sanitizeFilename('COM1')).toBe('_com1');
    });

    it('handles fallback for empty or non-string inputs', () => {
      expect(sanitizeFilename('')).toBe('unnamed-playlist');
      expect(sanitizeFilename('   ')).toBe('unnamed-playlist');
      expect(sanitizeFilename('...')).toBe('unnamed-playlist');
      // @ts-expect-error test invalid type input
      expect(sanitizeFilename(null)).toBe('unnamed-playlist');
    });
  });

  describe('isPlatformMatch', () => {
    it('matches all platforms when filter is all or empty', () => {
      expect(isPlatformMatch('spotify', 'all')).toBe(true);
      expect(isPlatformMatch('youtubeMusic', '')).toBe(true);
      expect(isPlatformMatch('deezer', undefined)).toBe(true);
      expect(isPlatformMatch('tidal', '*')).toBe(true);
    });

    it('matches youtube and youtubeMusic aliases specifically', () => {
      expect(isPlatformMatch('youtubeMusic', 'youtube')).toBe(true);
      expect(isPlatformMatch('youtube', 'youtubeMusic')).toBe(true);
      expect(isPlatformMatch('youtube', 'youtube')).toBe(true);
      expect(isPlatformMatch('youtubeMusic', 'youtubeMusic')).toBe(true);
      expect(isPlatformMatch('ytm', 'youtube')).toBe(true);
      expect(isPlatformMatch('spotify', 'youtube')).toBe(false);
      expect(isPlatformMatch('spotify', 'youtubeMusic')).toBe(false);
    });

    it('matches exact or case-insensitive platforms', () => {
      expect(isPlatformMatch('Spotify', 'spotify')).toBe(true);
      expect(isPlatformMatch('deezer', 'Deezer')).toBe(true);
      expect(isPlatformMatch('appleMusic', 'spotify')).toBe(false);
    });

    it('returns false when playlist platform is missing for a specific target filter', () => {
      expect(isPlatformMatch(undefined, 'spotify')).toBe(false);
    });
  });

  describe('formatTracks', () => {
    const mockTracks: SoundiizTrack[] = [
      {
        id: 't1',
        title: 'Song One',
        artist: 'Artist A',
        album: 'Album 1',
        isrc: 'US1234567890',
        duration: 210,
        url: 'https://music.youtube.com/watch?v=t1',
      },
      {
        id: 't2',
        title: 'Song "Two"',
        artist: 'Artist B',
        album: 'Album, Two',
        duration: 180,
      },
    ];

    it('formats tracks as JSON', () => {
      const output = formatTracks(mockTracks, 'json');
      const parsed = JSON.parse(output);
      expect(parsed).toEqual(mockTracks);
    });

    it('formats tracks as M3U / M3U8', () => {
      const outputM3U = formatTracks(mockTracks, 'm3u');
      expect(outputM3U).toContain('#EXTM3U');
      expect(outputM3U).toContain('#EXTINF:210,Artist A - Song One');
      expect(outputM3U).toContain('https://music.youtube.com/watch?v=t1');
      expect(outputM3U).toContain('#EXTINF:180,Artist B - Song "Two"');
      expect(outputM3U).toContain('t2');

      const outputM3U8 = formatTracks(mockTracks, 'm3u8');
      expect(outputM3U8).toBe(outputM3U);
    });

    it('formats tracks as CSV with proper quoting and escaping', () => {
      const output = formatTracks(mockTracks, 'csv');
      const lines = output.split('\n');
      expect(lines[0]).toBe('title,artist,album,isrc,duration');
      expect(lines[1]).toBe('"Song One","Artist A","Album 1","US1234567890","210"');
      expect(lines[2]).toBe('"Song ""Two""","Artist B","Album, Two","","180"');
    });

    it('throws error on unsupported format', () => {
      // @ts-expect-error testing unsupported format
      expect(() => formatTracks(mockTracks, 'xml')).toThrow('Unsupported export format');
    });
  });
});

describe('BackupEngine - Main Integration', () => {
  let mockClientInstance: {
    getUserPlaylists: ReturnType<typeof vi.fn>;
    getPlaylistTracks: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    cleanupTestDir();

    mockClientInstance = {
      getUserPlaylists: vi.fn(),
      getPlaylistTracks: vi.fn(),
    };

    (SoundiizClient as any).mockImplementation(() => mockClientInstance);
  });

  afterEach(() => {
    cleanupTestDir();
    vi.clearAllMocks();
  });

  it('creates output directory if it does not exist', async () => {
    const playlists: SoundiizPlaylist[] = [{ id: 'p1', title: 'Test Playlist', platform: 'spotify' }];
    const tracks: SoundiizTrack[] = [{ title: 'Track 1', artist: 'Artist 1' }];

    mockClientInstance.getUserPlaylists.mockResolvedValueOnce(playlists);
    mockClientInstance.getPlaylistTracks.mockResolvedValueOnce(tracks);

    const engine = new BackupEngine();
    expect(fs.existsSync(TEST_OUTPUT_DIR)).toBe(false);

    const result = await engine.backup({ outputDir: TEST_OUTPUT_DIR });

    expect(fs.existsSync(TEST_OUTPUT_DIR)).toBe(true);
    expect(result.successfulPlaylists).toHaveLength(1);
    expect(fs.existsSync(path.join(TEST_OUTPUT_DIR, 'test-playlist.json'))).toBe(true);
    expect(fs.existsSync(path.join(TEST_OUTPUT_DIR, 'manifest.json'))).toBe(true);
  });

  it('backs up YouTube Music playlists specifically when youtube or youtubeMusic filter is provided', async () => {
    const playlists: SoundiizPlaylist[] = [
      { id: 'p1', title: 'YTM Rock', platform: 'youtubeMusic' },
      { id: 'p2', title: 'YT Mix', platform: 'youtube' },
      { id: 'p3', title: 'Spotify Hits', platform: 'spotify' },
    ];

    mockClientInstance.getUserPlaylists.mockResolvedValueOnce(playlists);
    mockClientInstance.getPlaylistTracks.mockResolvedValue({ id: 't1', title: 'Song', artist: 'Artist' });

    const engine = new BackupEngine();

    // Test with 'youtubeMusic' filter
    const resultYTM = await engine.backup({ outputDir: TEST_OUTPUT_DIR, platform: 'youtubeMusic' });
    expect(resultYTM.successfulPlaylists).toHaveLength(2);
    expect(resultYTM.successfulPlaylists.map((p) => p.id)).toEqual(['p1', 'p2']);

    cleanupTestDir();
    mockClientInstance.getUserPlaylists.mockResolvedValueOnce(playlists);

    // Test with 'youtube' filter
    const resultYT = await engine.backup({ outputDir: TEST_OUTPUT_DIR, platform: 'youtube' });
    expect(resultYT.successfulPlaylists).toHaveLength(2);
    expect(resultYT.successfulPlaylists.map((p) => p.id)).toEqual(['p1', 'p2']);
  });

  it('filters by other specific platforms e.g. spotify', async () => {
    const playlists: SoundiizPlaylist[] = [
      { id: 'p1', title: 'YTM Rock', platform: 'youtubeMusic' },
      { id: 'p2', title: 'Spotify Pop', platform: 'spotify' },
    ];

    mockClientInstance.getUserPlaylists.mockResolvedValueOnce(playlists);
    mockClientInstance.getPlaylistTracks.mockResolvedValue([{ title: 'Song', artist: 'Artist' }]);

    const engine = new BackupEngine();
    const result = await engine.backup({ outputDir: TEST_OUTPUT_DIR, platform: 'spotify' });

    expect(result.successfulPlaylists).toHaveLength(1);
    expect(result.successfulPlaylists[0].id).toBe('p2');
  });

  it('supports CSV, M3U and M3U8 format exports', async () => {
    const playlists: SoundiizPlaylist[] = [{ id: 'p1', title: 'My Mix', platform: 'spotify' }];
    const tracks: SoundiizTrack[] = [{ title: 'Track A', artist: 'Artist A', album: 'Album A', duration: 120 }];

    mockClientInstance.getUserPlaylists.mockResolvedValue(playlists);
    mockClientInstance.getPlaylistTracks.mockResolvedValue(tracks);

    const engine = new BackupEngine();

    // CSV
    await engine.backup({ outputDir: TEST_OUTPUT_DIR, format: 'csv' });
    const csvContent = fs.readFileSync(path.join(TEST_OUTPUT_DIR, 'my-mix.csv'), 'utf8');
    expect(csvContent).toContain('title,artist,album,isrc,duration');
    expect(csvContent).toContain('"Track A","Artist A","Album A","","120"');

    cleanupTestDir();

    // M3U8
    await engine.backup({ outputDir: TEST_OUTPUT_DIR, format: 'm3u8' });
    const m3uContent = fs.readFileSync(path.join(TEST_OUTPUT_DIR, 'my-mix.m3u8'), 'utf8');
    expect(m3uContent).toContain('#EXTM3U');
    expect(m3uContent).toContain('#EXTINF:120,Artist A - Track A');
  });

  it('creates manifest.json containing backup run metadata when createManifest is true', async () => {
    const playlists: SoundiizPlaylist[] = [
      { id: 'p1', title: 'List 1', platform: 'spotify' },
      { id: 'p2', title: 'List 2', platform: 'youtubeMusic' },
    ];

    mockClientInstance.getUserPlaylists.mockResolvedValueOnce(playlists);
    mockClientInstance.getPlaylistTracks.mockResolvedValue([{ title: 'T', artist: 'A' }]);

    const engine = new BackupEngine();
    const result = await engine.backup({
      outputDir: TEST_OUTPUT_DIR,
      createManifest: true,
      platform: 'all',
      format: 'json',
    });

    expect(result.manifestPath).toBe(path.join(TEST_OUTPUT_DIR, 'manifest.json'));
    expect(result.manifest).toBeDefined();
    expect(result.manifest?.totalPlaylists).toBe(2);
    expect(result.manifest?.successfulPlaylists).toBe(2);
    expect(result.manifest?.failedPlaylists).toBe(0);
    expect(result.manifest?.totalTracks).toBe(2);

    const manifestFile = JSON.parse(fs.readFileSync(result.manifestPath!, 'utf8'));
    expect(manifestFile.totalPlaylists).toBe(2);
    expect(manifestFile.playlists).toHaveLength(2);
  });

  it('respects saveIndividualFiles: false option', async () => {
    const playlists: SoundiizPlaylist[] = [{ id: 'p1', title: 'List 1', platform: 'spotify' }];
    mockClientInstance.getUserPlaylists.mockResolvedValueOnce(playlists);
    mockClientInstance.getPlaylistTracks.mockResolvedValue([{ title: 'T', artist: 'A' }]);

    const engine = new BackupEngine();
    const result = await engine.backup({
      outputDir: TEST_OUTPUT_DIR,
      saveIndividualFiles: false,
      createManifest: true,
    });

    expect(fs.existsSync(path.join(TEST_OUTPUT_DIR, 'list-1.json'))).toBe(false);
    expect(fs.existsSync(path.join(TEST_OUTPUT_DIR, 'manifest.json'))).toBe(true);
    expect(result.successfulPlaylists[0].filename).toBeUndefined();
  });

  it('emits progress events and invokes onProgress callback during execution', async () => {
    const playlists: SoundiizPlaylist[] = [
      { id: 'p1', title: 'List A', platform: 'spotify' },
      { id: 'p2', title: 'List B', platform: 'spotify' },
    ];

    mockClientInstance.getUserPlaylists.mockResolvedValueOnce(playlists);
    mockClientInstance.getPlaylistTracks.mockResolvedValue([{ title: 'T', artist: 'A' }]);

    const onProgress = vi.fn();
    const onEventListener = vi.fn();

    const engine = new BackupEngine();
    engine.on('progress', onEventListener);

    await engine.backup({
      outputDir: TEST_OUTPUT_DIR,
      onProgress,
    });

    expect(onProgress).toHaveBeenCalled();
    expect(onEventListener).toHaveBeenCalled();

    // Verify calls pass current, total, and playlistName
    expect(onProgress).toHaveBeenCalledWith(1, 2, 'List A', expect.objectContaining({ status: 'in_progress' }));
    expect(onProgress).toHaveBeenCalledWith(1, 2, 'List A', expect.objectContaining({ status: 'completed' }));
    expect(onProgress).toHaveBeenCalledWith(2, 2, 'List B', expect.objectContaining({ status: 'completed' }));
  });

  it('handles errors gracefully by continuing with remaining playlists and reporting failures', async () => {
    const playlists: SoundiizPlaylist[] = [
      { id: 'p1', title: 'Good Playlist 1', platform: 'spotify' },
      { id: 'p2', title: 'Bad Playlist', platform: 'spotify' },
      { id: 'p3', title: 'Good Playlist 2', platform: 'spotify' },
    ];

    mockClientInstance.getUserPlaylists.mockResolvedValueOnce(playlists);
    mockClientInstance.getPlaylistTracks
      .mockResolvedValueOnce([{ title: 'Track 1', artist: 'Artist 1' }])
      .mockRejectedValueOnce(new Error('Network error downloading tracks'))
      .mockResolvedValueOnce([{ title: 'Track 2', artist: 'Artist 2' }]);

    const engine = new BackupEngine();
    const result = await engine.backup({ outputDir: TEST_OUTPUT_DIR });

    expect(result.successfulPlaylists).toHaveLength(2);
    expect(result.failedPlaylists).toHaveLength(1);

    expect(result.successfulPlaylists.map((p) => p.id)).toEqual(['p1', 'p3']);
    expect(result.failedPlaylists[0]).toEqual({
      id: 'p2',
      title: 'Bad Playlist',
      platform: 'spotify',
      error: 'Network error downloading tracks',
    });

    expect(result.totalTracks).toBe(2);
    expect(result.manifest?.successfulPlaylists).toBe(2);
    expect(result.manifest?.failedPlaylists).toBe(1);

    // Verify individual files: p1 and p3 written, p2 not written
    expect(fs.existsSync(path.join(TEST_OUTPUT_DIR, 'good-playlist-1.json'))).toBe(true);
    expect(fs.existsSync(path.join(TEST_OUTPUT_DIR, 'bad-playlist.json'))).toBe(false);
    expect(fs.existsSync(path.join(TEST_OUTPUT_DIR, 'good-playlist-2.json'))).toBe(true);
  });

  it('handles duplicate playlist titles cleanly by appending playlist ID to avoid overwriting', async () => {
    const playlists: SoundiizPlaylist[] = [
      { id: 'p1', title: 'Favorites', platform: 'spotify' },
      { id: 'p2', title: 'Favorites', platform: 'youtube' },
    ];

    mockClientInstance.getUserPlaylists.mockResolvedValueOnce(playlists);
    mockClientInstance.getPlaylistTracks.mockResolvedValue([{ title: 'Track', artist: 'Artist' }]);

    const engine = new BackupEngine();
    const result = await engine.backup({ outputDir: TEST_OUTPUT_DIR });

    expect(result.successfulPlaylists).toHaveLength(2);
    const file1 = result.successfulPlaylists[0].filename;
    const file2 = result.successfulPlaylists[1].filename;

    expect(file1).toBe('favorites.json');
    expect(file2).toBe('favorites_p2.json');

    expect(fs.existsSync(path.join(TEST_OUTPUT_DIR, 'favorites.json'))).toBe(true);
    expect(fs.existsSync(path.join(TEST_OUTPUT_DIR, 'favorites_p2.json'))).toBe(true);
  });
});
