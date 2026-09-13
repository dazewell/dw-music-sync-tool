import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the `axios` module before importing the client so that `axios.create`
// returns a controllable fake instance for every test.
const mockRequest = vi.fn();
const mockAxiosInstance = { request: mockRequest };
const mockCreate = vi.fn(() => mockAxiosInstance);

vi.mock('axios', () => {
  return {
    default: {
      create: (...args: unknown[]) => mockCreate(...args),
    },
  };
});

// Import after the mock is registered.
const { SoundiizClient } = await import('../src/api/soundiizClient.js');
const { SoundiizApiError } = await import('../src/types/soundiiz.js');

function axiosOk<T>(data: T) {
  return Promise.resolve({ data, status: 200, statusText: 'OK', headers: {}, config: {} });
}

function axiosError(status: number, data?: unknown, headers: Record<string, string> = {}) {
  const error: any = new Error(`Request failed with status code ${status}`);
  error.isAxiosError = true;
  error.response = { status, data, headers, statusText: '', config: {} };
  error.toJSON = () => ({ message: error.message });
  return Promise.reject(error);
}

describe('SoundiizClient', () => {
  beforeEach(() => {
    mockRequest.mockReset();
    mockCreate.mockClear();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('authenticates using the x-soundiiz-token header by default', () => {
    new SoundiizClient({ apiKey: 'secret-key', baseUrl: 'https://soundiiz.com/api' });

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: 'https://soundiiz.com/api',
        headers: expect.objectContaining({ 'x-soundiiz-token': 'secret-key' }),
      }),
    );
  });

  it('authenticates using a Bearer header when authMode is "bearer"', () => {
    new SoundiizClient({ apiKey: 'secret-key', authMode: 'bearer' });

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer secret-key' }),
      }),
    );
  });

  it('defaults the base URL when none is configured', () => {
    new SoundiizClient({ apiKey: 'secret-key' });

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: 'https://soundiiz.com/api' }),
    );
  });

  it('getMe() validates the API key and returns the user profile', async () => {
    mockRequest.mockReturnValueOnce(axiosOk({ id: 'u1', email: 'a@b.com' }));
    const client = new SoundiizClient({ apiKey: 'k' });

    const me = await client.getMe();

    expect(me).toEqual({ id: 'u1', email: 'a@b.com' });
    expect(mockRequest).toHaveBeenCalledWith(expect.objectContaining({ method: 'GET', url: '/me' }));
  });

  it('getUserPlaylists() forwards an optional platform filter', async () => {
    mockRequest.mockReturnValueOnce(axiosOk({ playlists: [{ id: 'p1', title: 'Chill' }] }));
    const client = new SoundiizClient({ apiKey: 'k' });

    const playlists = await client.getUserPlaylists('spotify');

    expect(playlists).toEqual([{ id: 'p1', title: 'Chill' }]);
    expect(mockRequest).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'GET', url: '/playlists', params: { platform: 'spotify' } }),
    );
  });

  it('getUserPlaylists() handles a bare array response', async () => {
    mockRequest.mockReturnValueOnce(axiosOk([{ id: 'p1', title: 'Chill' }]));
    const client = new SoundiizClient({ apiKey: 'k' });

    const playlists = await client.getUserPlaylists();

    expect(playlists).toEqual([{ id: 'p1', title: 'Chill' }]);
  });

  it('getPlaylist() fetches a single playlist by id', async () => {
    mockRequest.mockReturnValueOnce(axiosOk({ id: 'p1', title: 'Chill' }));
    const client = new SoundiizClient({ apiKey: 'k' });

    const playlist = await client.getPlaylist('p1');

    expect(playlist).toEqual({ id: 'p1', title: 'Chill' });
    expect(mockRequest).toHaveBeenCalledWith(expect.objectContaining({ url: '/playlists/p1' }));
  });

  it('getPlaylist() rejects a missing playlist id', async () => {
    const client = new SoundiizClient({ apiKey: 'k' });
    await expect(client.getPlaylist('')).rejects.toThrow(SoundiizApiError);
  });

  it('getPlaylistTracks() follows pagination until hasMore is false', async () => {
    mockRequest
      .mockReturnValueOnce(
        axiosOk({ tracks: [{ title: 'A', artist: 'X' }], page: 1, pageSize: 1, total: 2, hasMore: true }),
      )
      .mockReturnValueOnce(
        axiosOk({ tracks: [{ title: 'B', artist: 'Y' }], page: 2, pageSize: 1, total: 2, hasMore: false }),
      );

    const client = new SoundiizClient({ apiKey: 'k' });
    const tracks = await client.getPlaylistTracks('p1');

    expect(tracks).toEqual([
      { title: 'A', artist: 'X' },
      { title: 'B', artist: 'Y' },
    ]);
    expect(mockRequest).toHaveBeenCalledTimes(2);
  });

  it('getPlaylistTracks() fetches a single page when fetchAllPages is false', async () => {
    mockRequest.mockReturnValueOnce(
      axiosOk({ tracks: [{ title: 'A', artist: 'X' }], page: 1, pageSize: 1, total: 5, hasMore: true }),
    );

    const client = new SoundiizClient({ apiKey: 'k' });
    const tracks = await client.getPlaylistTracks('p1', { fetchAllPages: false });

    expect(tracks).toEqual([{ title: 'A', artist: 'X' }]);
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  it('exportPlaylistFile() formats tracks as JSON', async () => {
    mockRequest
      .mockReturnValueOnce(axiosOk({ id: 'p1', title: 'My Playlist' }))
      .mockReturnValueOnce(
        axiosOk({ tracks: [{ title: 'A', artist: 'X' }], page: 1, pageSize: 10, hasMore: false }),
      );

    const client = new SoundiizClient({ apiKey: 'k' });
    const file = await client.exportPlaylistFile('p1', 'json');

    expect(file.filename).toBe('my-playlist.json');
    expect(JSON.parse(file.content)).toEqual([{ title: 'A', artist: 'X' }]);
  });

  it('exportPlaylistFile() formats tracks as M3U', async () => {
    mockRequest
      .mockReturnValueOnce(axiosOk({ id: 'p1', title: 'My Playlist' }))
      .mockReturnValueOnce(
        axiosOk({
          tracks: [{ title: 'Song', artist: 'Artist', duration: 180, url: 'https://example.com/song' }],
          page: 1,
          pageSize: 10,
          hasMore: false,
        }),
      );

    const client = new SoundiizClient({ apiKey: 'k' });
    const file = await client.exportPlaylistFile('p1', 'm3u');

    expect(file.content).toContain('#EXTM3U');
    expect(file.content).toContain('#EXTINF:180,Artist - Song');
    expect(file.content).toContain('https://example.com/song');
  });

  it('exportPlaylistFile() formats tracks as CSV', async () => {
    mockRequest
      .mockReturnValueOnce(axiosOk({ id: 'p1', title: 'My Playlist' }))
      .mockReturnValueOnce(
        axiosOk({ tracks: [{ title: 'Song', artist: 'Artist', album: 'Album' }], page: 1, pageSize: 10, hasMore: false }),
      );

    const client = new SoundiizClient({ apiKey: 'k' });
    const file = await client.exportPlaylistFile('p1', 'csv');

    const lines = file.content.split('\n');
    expect(lines[0]).toBe('title,artist,album,isrc,duration');
    expect(lines[1]).toBe('"Song","Artist","Album","",""');
  });

  it('exportPlaylistFile() rejects an unsupported format', async () => {
    const client = new SoundiizClient({ apiKey: 'k' });
    // @ts-expect-error intentionally invalid format for test coverage
    await expect(client.exportPlaylistFile('p1', 'xml')).rejects.toThrow(SoundiizApiError);
  });

  it('getSyncs() lists configured syncs', async () => {
    mockRequest.mockReturnValueOnce(
      axiosOk({
        syncs: [
          {
            id: 's1',
            sourcePlaylistId: 'a',
            targetPlaylistId: 'b',
            sourcePlatform: 'spotify',
            targetPlatform: 'youtubeMusic',
          },
        ],
      }),
    );
    const client = new SoundiizClient({ apiKey: 'k' });

    const syncs = await client.getSyncs();

    expect(syncs).toHaveLength(1);
    expect(syncs[0].id).toBe('s1');
  });

  it('triggerSync() manually runs a sync', async () => {
    mockRequest.mockReturnValueOnce(axiosOk({ syncId: 's1', status: 'queued' }));
    const client = new SoundiizClient({ apiKey: 'k' });

    const result = await client.triggerSync('s1');

    expect(result).toEqual({ syncId: 's1', status: 'queued' });
    expect(mockRequest).toHaveBeenCalledWith(expect.objectContaining({ method: 'POST', url: '/syncs/s1/run' }));
  });

  it('retries on HTTP 429 honoring Retry-After and eventually succeeds', async () => {
    mockRequest
      .mockReturnValueOnce(axiosError(429, { message: 'Rate limited' }, { 'retry-after': '0' }))
      .mockReturnValueOnce(axiosOk({ id: 'u1' }));

    const client = new SoundiizClient({ apiKey: 'k', retryDelayMs: 1, maxRetryDelayMs: 5 });
    const me = await client.getMe();

    expect(me).toEqual({ id: 'u1' });
    expect(mockRequest).toHaveBeenCalledTimes(2);
  });

  it('retries transient 5xx errors up to maxRetries then throws SoundiizApiError', async () => {
    mockRequest.mockImplementation(() => axiosError(503, { message: 'Server error' }));

    const client = new SoundiizClient({ apiKey: 'k', maxRetries: 2, retryDelayMs: 1, maxRetryDelayMs: 2 });

    await expect(client.getMe()).rejects.toMatchObject({
      name: 'SoundiizApiError',
      status: 503,
      retryable: true,
    });
    // initial attempt + 2 retries = 3 calls
    expect(mockRequest).toHaveBeenCalledTimes(3);
  });

  it('does not retry non-retryable 4xx errors', async () => {
    mockRequest.mockReturnValueOnce(axiosError(401, { message: 'Unauthorized' }));

    const client = new SoundiizClient({ apiKey: 'bad-key' });

    await expect(client.getMe()).rejects.toMatchObject({ status: 401, retryable: false });
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });
});
