import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createServer } from '../src/web/server.js';
import { SoundiizClient } from '../src/api/soundiizClient.js';
import { BackupEngine } from '../src/services/backupEngine.js';

const backupDir = path.resolve('.test-web-backups');
let server: Server;
let baseUrl: string;
const client = {
  getMe: vi.fn(),
  getUserPlaylists: vi.fn(),
  getPlaylistTracks: vi.fn(),
};
const backup = vi.fn();

async function api(url: string, options: RequestInit = {}) {
  return fetch(`${baseUrl}${url}`, { ...options, headers: { 'x-api-key': 'test-key', ...(options.headers ?? {}) } });
}

beforeEach(async () => {
  fs.rmSync(backupDir, { recursive: true, force: true });
  vi.clearAllMocks();
  client.getMe.mockResolvedValue({ id: 'u1', username: 'casey' });
  client.getUserPlaylists.mockResolvedValue([{ id: 'p1', title: 'Road Trip', platform: 'youtubeMusic' }]);
  backup.mockImplementation(async (options) => {
    options.onProgress?.(1, 1, 'Road Trip', { current: 1, total: 1, playlistName: 'Road Trip', status: 'completed' });
    await fs.promises.mkdir(backupDir, { recursive: true });
    await fs.promises.writeFile(path.join(backupDir, 'road-trip.json'), '[]');
    const manifest = { timestamp: new Date().toISOString(), successfulPlaylists: 1, failedPlaylists: 0, totalTracks: 2, platform: options.platform, format: options.format, playlists: [], failures: [] };
    await fs.promises.writeFile(path.join(backupDir, 'manifest.json'), JSON.stringify(manifest));
    return { outputDir: backupDir, successfulPlaylists: [], failedPlaylists: [], totalTracks: 2, manifest };
  });
  const app = createServer({
    backupDir,
    apiKey: '',
    createClient: () => client as unknown as SoundiizClient,
    createBackupEngine: () => ({ backup } as unknown as BackupEngine),
  });
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  fs.rmSync(backupDir, { recursive: true, force: true });
});

describe('web server', () => {
  it('validates the API key and returns playlists by platform', async () => {
    const status = await api('/api/status');
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ connected: true, user: { username: 'casey' } });
    const playlists = await api('/api/playlists?platform=youtubeMusic');
    expect(await playlists.json()).toMatchObject({ total: 1 });
    expect(client.getUserPlaylists).toHaveBeenCalledWith('youtubeMusic');
  });

  it('rejects API operations without a key', async () => {
    const response = await fetch(`${baseUrl}/api/playlists`);
    expect(response.status).toBe(401);
  });

  it('starts a backup and exposes progress and history downloads', async () => {
    const response = await api('/api/backup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ platform: 'youtubeMusic', format: 'json', outputDir: backupDir, playlistIds: ['p1'] }) });
    expect(response.status).toBe(202);
    await vi.waitFor(async () => {
      const status = await api('/api/backup/status');
      expect(await status.json()).toMatchObject({ state: 'completed', percent: 100 });
    });
    expect(backup).toHaveBeenCalledWith(expect.objectContaining({ playlistIds: ['p1'], createManifest: true }));
    const history = await api('/api/backups/history');
    const payload = await history.json();
    expect(payload.backups[0].files).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'road-trip.json' })]));
    const download = await api(payload.backups[0].files.find((file: { name: string }) => file.name === 'road-trip.json').downloadUrl);
    expect(download.status).toBe(200);
    expect(await download.text()).toBe('[]');
  });

  it('validates backup formats', async () => {
    const response = await api('/api/backup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ format: 'xml' }) });
    expect(response.status).toBe(400);
  });
});
