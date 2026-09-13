import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCli, CliDependencies } from '../src/cli/index.js';
import { SoundiizClient } from '../src/api/soundiizClient.js';
import { BackupEngine } from '../src/services/backupEngine.js';

function dependencies(overrides: Partial<CliDependencies> = {}) {
  const log = vi.fn();
  const error = vi.fn();
  const client = {
    getMe: vi.fn().mockResolvedValue({ id: 'u1', username: 'casey' }),
    getUserPlaylists: vi.fn().mockResolvedValue([{ id: 'p1', title: 'Mix', platform: 'youtubeMusic' }]),
    getPlaylistTracks: vi.fn(),
  };
  const engine = { backup: vi.fn().mockImplementation(async (options) => {
    options.onProgress?.(1, 1, 'Mix', { current: 1, total: 1, playlistName: 'Mix', status: 'completed' });
    return { outputDir: 'backups', successfulPlaylists: [{ id: 'p1' }], failedPlaylists: [], totalTracks: 4 };
  }) };
  return {
    client, engine, log, error,
    deps: {
      createClient: vi.fn(() => client as unknown as SoundiizClient),
      createBackupEngine: vi.fn(() => engine as unknown as BackupEngine),
      promptApiKey: vi.fn().mockResolvedValue('prompted-key'),
      log,
      error,
      ...overrides,
    } satisfies CliDependencies,
  };
}

afterEach(() => { process.exitCode = undefined; vi.restoreAllMocks(); });

describe('CLI', () => {
  it('backs up with documented defaults and prompts for a missing key', async () => {
    const { deps, engine } = dependencies();
    await createCli(deps).parseAsync(['node', 'soundiiz', 'backup']);
    expect(deps.promptApiKey).toHaveBeenCalledOnce();
    expect(engine.backup).toHaveBeenCalledWith(expect.objectContaining({ platform: 'youtubeMusic', format: 'json', outputDir: './backups', createManifest: false }));
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('Backup complete'));
  });

  it('lists playlists with a platform filter', async () => {
    const { deps, client, log } = dependencies();
    await createCli(deps).parseAsync(['node', 'soundiiz', 'list', '--platform', 'spotify', '--api-key', 'key']);
    expect(client.getUserPlaylists).toHaveBeenCalledWith('spotify');
    expect(log).toHaveBeenCalledWith('Mix\tyoutubeMusic\tp1');
  });

  it.each(['status', 'test-connection'])('validates the connection with %s', async (command) => {
    const { deps, client, log } = dependencies();
    await createCli(deps).parseAsync(['node', 'soundiiz', command, '--api-key', 'key']);
    expect(client.getMe).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Connected as casey'));
  });
});
