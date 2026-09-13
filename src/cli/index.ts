#!/usr/bin/env node
import { Command } from 'commander';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { pathToFileURL } from 'node:url';
import { SoundiizClient } from '../api/soundiizClient.js';
import { BackupEngine, BackupFormat } from '../services/backupEngine.js';
import { config } from '../config/index.js';

export interface CliDependencies {
  createClient(apiKey: string): Pick<SoundiizClient, 'getMe' | 'getUserPlaylists' | 'getPlaylistTracks'>;
  createBackupEngine(client: SoundiizClient): BackupEngine;
  promptApiKey(): Promise<string>;
  log(message: string): void;
  error(message: string): void;
}

const color = (code: number, text: string) => stdout.isTTY ? `\u001b[${code}m${text}\u001b[0m` : text;

async function defaultPromptApiKey(): Promise<string> {
  if (!stdin.isTTY) throw new Error('Missing API key. Pass --api-key or set SOUNDIIZ_API_KEY.');
  const prompt = readline.createInterface({ input: stdin, output: stdout });
  try {
    return (await prompt.question('Soundiiz API key: ')).trim();
  } finally {
    prompt.close();
  }
}

const defaults: CliDependencies = {
  createClient: (apiKey) => new SoundiizClient({ apiKey, baseUrl: config.soundiizApiUrl }),
  createBackupEngine: (client) => new BackupEngine(client),
  promptApiKey: defaultPromptApiKey,
  log: console.log,
  error: console.error,
};

async function resolveApiKey(value: string | undefined, deps: CliDependencies): Promise<string> {
  const key = value?.trim() || config.soundiizApiKey || await deps.promptApiKey();
  if (!key) throw new Error('A Soundiiz API key is required.');
  return key;
}

function reportError(error: unknown, deps: CliDependencies): void {
  deps.error(color(31, `Error: ${error instanceof Error ? error.message : String(error)}`));
  process.exitCode = 1;
}

export function createCli(overrides: Partial<CliDependencies> = {}): Command {
  const deps = { ...defaults, ...overrides };
  const program = new Command()
    .name('soundiiz')
    .description('Back up Soundiiz playlists locally')
    .version('1.0.0')
    .showHelpAfterError();

  program.command('backup')
    .description('Back up playlists to local files')
    .option('--platform <name>', 'platform to back up', 'youtubeMusic')
    .option('--format <json|m3u|csv>', 'backup file format', 'json')
    .option('--output <dir>', 'output directory', './backups')
    .option('--api-key <key>', 'Soundiiz API key')
    .option('--include-manifest', 'write manifest.json')
    .action(async (options) => {
      try {
        if (!['json', 'm3u', 'csv'].includes(options.format)) throw new Error('Format must be json, m3u, or csv.');
        const apiKey = await resolveApiKey(options.apiKey, deps);
        const client = deps.createClient(apiKey) as SoundiizClient;
        const engine = deps.createBackupEngine(client);
        deps.log(color(36, `Backing up ${options.platform} playlists...`));
        const result = await engine.backup({
          platform: options.platform,
          format: options.format as BackupFormat,
          outputDir: options.output,
          createManifest: Boolean(options.includeManifest),
          onProgress: (current, total, name, progress) => {
            const percent = total ? Math.round((current / total) * 100) : 100;
            deps.log(`${progress?.status === 'failed' ? color(31, 'failed') : color(32, '✓')} ${percent}% ${name}`);
          },
        });
        deps.log(color(32, `Backup complete: ${result.successfulPlaylists.length} playlists, ${result.totalTracks} tracks → ${result.outputDir}`));
        if (result.failedPlaylists.length) deps.error(color(33, `${result.failedPlaylists.length} playlist(s) failed.`));
      } catch (error) { reportError(error, deps); }
    });

  program.command('list')
    .description('List playlists on the connected account')
    .option('--platform <name>', 'filter by platform')
    .option('--api-key <key>', 'Soundiiz API key')
    .action(async (options) => {
      try {
        const apiKey = await resolveApiKey(options.apiKey, deps);
        const playlists = await deps.createClient(apiKey).getUserPlaylists(options.platform);
        if (!playlists.length) return deps.log('No playlists found.');
        for (const playlist of playlists) deps.log(`${playlist.title}\t${playlist.platform ?? 'unknown'}\t${playlist.id}`);
      } catch (error) { reportError(error, deps); }
    });

  const connectionAction = async (options: { apiKey?: string }) => {
    try {
      const apiKey = await resolveApiKey(options.apiKey, deps);
      const user = await deps.createClient(apiKey).getMe();
      deps.log(color(32, `Connected${user.username ? ` as ${user.username}` : user.email ? ` as ${user.email}` : ''}.`));
    } catch (error) { reportError(error, deps); }
  };

  program.command('status').description('Validate configuration and connection').option('--api-key <key>').action(connectionAction);
  program.command('test-connection').description('Test the Soundiiz API connection').option('--api-key <key>').action(connectionAction);
  return program;
}

export async function runCli(argv = process.argv): Promise<void> {
  await createCli().parseAsync(argv);
}

const entryUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === entryUrl) void runCli();
