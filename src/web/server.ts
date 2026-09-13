import cors from 'cors';
import express, { Express } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { SoundiizClient } from '../api/soundiizClient.js';
import { BackupEngine, BackupFormat, BackupProgress, BackupResult } from '../services/backupEngine.js';
import { config } from '../config/index.js';

export interface BackupJobStatus {
  state: 'idle' | 'running' | 'completed' | 'failed';
  current: number;
  total: number;
  percent: number;
  playlistName?: string;
  message?: string;
  startedAt?: string;
  finishedAt?: string;
  result?: BackupResult;
}

export interface ServerOptions {
  backupDir?: string;
  staticDir?: string;
  apiKey?: string;
  createClient?: (apiKey: string) => SoundiizClient;
  createBackupEngine?: (client: SoundiizClient) => BackupEngine;
}

const initialStatus = (): BackupJobStatus => ({ state: 'idle', current: 0, total: 0, percent: 0 });
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

function requestApiKey(req: express.Request, fallback: string): string {
  const header = req.header('x-api-key');
  return header?.trim() || fallback;
}

function isFormat(value: unknown): value is BackupFormat {
  return value === 'json' || value === 'm3u' || value === 'csv';
}

async function findManifests(root: string): Promise<string[]> {
  if (!fs.existsSync(root)) return [];
  const found: string[] = [];
  const visit = async (dir: string, depth: number): Promise<void> => {
    if (depth > 4) return;
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    await Promise.all(entries.map(async (entry) => {
      const item = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(item, depth + 1);
      else if (entry.isFile() && entry.name === 'manifest.json') found.push(item);
    }));
  };
  await visit(root, 0);
  return found;
}

export function createServer(options: ServerOptions = {}): Express {
  const app = express();
  const backupRoot = path.resolve(options.backupDir ?? config.backupDir);
  const staticDir = options.staticDir ?? path.resolve(process.cwd(), 'src', 'web', 'public');
  const configuredApiKey = options.apiKey ?? config.soundiizApiKey;
  const createClient = options.createClient ?? ((apiKey: string) => new SoundiizClient({ apiKey, baseUrl: config.soundiizApiUrl }));
  const createBackupEngine = options.createBackupEngine ?? ((client: SoundiizClient) => new BackupEngine(client));
  const allowedRoots = new Set([backupRoot]);
  let backupStatus = initialStatus();

  app.use(cors({ allowedHeaders: ['Content-Type', 'x-api-key'] }));
  app.use(express.json({ limit: '32kb' }));

  app.get('/health', (_req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

  app.get('/api/status', async (req, res) => {
    const apiKey = requestApiKey(req, configuredApiKey);
    if (!apiKey) return res.json({ status: 'ok', configured: false, connected: false, message: 'API key required' });
    try {
      const user = await createClient(apiKey).getMe();
      return res.json({ status: 'ok', configured: true, connected: true, user });
    } catch (error) {
      return res.status(401).json({ status: 'error', configured: true, connected: false, message: errorMessage(error) });
    }
  });

  app.get('/api/playlists', async (req, res) => {
    const apiKey = requestApiKey(req, configuredApiKey);
    if (!apiKey) return res.status(401).json({ error: 'API key required' });
    try {
      const platform = typeof req.query.platform === 'string' ? req.query.platform : undefined;
      const playlists = await createClient(apiKey).getUserPlaylists(platform);
      return res.json({ playlists, total: playlists.length });
    } catch (error) {
      return res.status(502).json({ error: errorMessage(error) });
    }
  });

  app.post('/api/backup', (req, res) => {
    const apiKey = requestApiKey(req, configuredApiKey);
    if (!apiKey) return res.status(401).json({ error: 'API key required' });
    if (backupStatus.state === 'running') return res.status(409).json({ error: 'A backup is already running' });

    const platform = typeof req.body?.platform === 'string' ? req.body.platform : 'youtubeMusic';
    const format = req.body?.format ?? 'json';
    const outputDir = path.resolve(typeof req.body?.outputDir === 'string' ? req.body.outputDir : backupRoot);
    const playlistIds = Array.isArray(req.body?.playlistIds)
      ? req.body.playlistIds.filter((id: unknown): id is string => typeof id === 'string')
      : undefined;
    if (!isFormat(format)) return res.status(400).json({ error: 'format must be json, m3u, or csv' });

    allowedRoots.add(outputDir);
    backupStatus = { state: 'running', current: 0, total: 0, percent: 0, message: 'Loading playlists', startedAt: new Date().toISOString() };
    const engine = createBackupEngine(createClient(apiKey));
    const onProgress = (current: number, total: number, playlistName: string, progress?: BackupProgress) => {
      backupStatus = {
        ...backupStatus,
        state: 'running', current, total, playlistName,
        percent: total ? Math.round((current / total) * 100) : 0,
        message: progress?.status === 'failed' ? progress.error : `${progress?.status ?? 'running'}: ${playlistName}`,
      };
    };

    void engine.backup({ platform, format, outputDir, playlistIds, createManifest: true, onProgress })
      .then((result) => {
        backupStatus = { ...backupStatus, state: 'completed', percent: 100, result, message: 'Backup complete', finishedAt: new Date().toISOString() };
      })
      .catch((error) => {
        backupStatus = { ...backupStatus, state: 'failed', message: errorMessage(error), finishedAt: new Date().toISOString() };
      });

    return res.status(202).json({ accepted: true, statusUrl: '/api/backup/status' });
  });

  app.get('/api/backup/status', (_req, res) => res.json(backupStatus));

  app.get('/api/backups/history', async (_req, res) => {
    try {
      const manifests = (await Promise.all([...allowedRoots].map(findManifests))).flat();
      const history = await Promise.all(manifests.map(async (manifestPath) => {
        const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
        const directory = path.dirname(manifestPath);
        const files = (await fs.promises.readdir(directory, { withFileTypes: true }))
          .filter((entry) => entry.isFile())
          .map((entry) => ({
            name: entry.name,
            downloadUrl: `/api/backups/download?path=${encodeURIComponent(path.join(directory, entry.name))}`,
          }));
        return { manifestPath, directory, ...manifest, files };
      }));
      history.sort((a, b) => String(b.timestamp ?? '').localeCompare(String(a.timestamp ?? '')));
      return res.json({ backups: history });
    } catch (error) {
      return res.status(500).json({ error: errorMessage(error) });
    }
  });

  app.get('/api/backups/download', (req, res) => {
    if (typeof req.query.path !== 'string') return res.status(400).json({ error: 'path is required' });
    const requested = path.resolve(req.query.path);
    const allowed = [...allowedRoots].some((root) => {
      const relative = path.relative(root, requested);
      return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
    });
    if (!allowed || !fs.existsSync(requested) || !fs.statSync(requested).isFile()) return res.status(404).json({ error: 'Backup file not found' });
    return res.download(requested);
  });

  if (fs.existsSync(staticDir)) app.use(express.static(staticDir));
  app.get('*', (_req, res) => res.sendFile(path.join(staticDir, 'index.html')));
  return app;
}

export function startServer(options: ServerOptions = {}) {
  const app = createServer(options);
  return app.listen(config.port, () => console.log(`Soundiiz local UI: http://localhost:${config.port}`));
}
