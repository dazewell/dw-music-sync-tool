import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import { AppError, errorMessage } from "./errors.js";
import type { BackupManifest } from "./models.js";

const runIdPattern = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const fingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);
const countSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const activeRuns = new Set<string>();
export const BACKUP_OWNER_FILENAME = ".backup-owner.json";
export const BACKUP_OWNER_APP = "dw-music-sync-tool";

function isBasename(value: string): boolean {
  return value.length > 0
    && Buffer.byteLength(value, "utf8") <= 255
    && !/[<>:"/\\|?*\u0000-\u001f\u007f]/u.test(value)
    && !/[. ]$/u.test(value)
    && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(value)
    && value !== "." && value !== "..";
}

const filenameSchema = (extension: string) => z.string().refine(
  value => isBasename(value) && value.endsWith(extension),
  `Expected a safe ${extension} basename`,
);
const filesSchema = z.strictObject({
  json: filenameSchema(".json"),
  csv: filenameSchema(".csv"),
  m3u: filenameSchema(".m3u8"),
}).refine(files => files.json.slice(0, -5) === files.csv.slice(0, -4)
  && files.json.slice(0, -5) === files.m3u.slice(0, -5)
  && files.json !== "manifest.json", "Export basenames must match");

const resultSchema = z.strictObject({
  playlistId: z.string(),
  title: z.string(),
  status: z.enum(["complete", "failed"]),
  entries: countSchema,
  files: filesSchema.nullable(),
  fingerprint: fingerprintSchema.nullable(),
  warnings: z.array(z.string()),
  error: z.string().nullable(),
}).superRefine((result, context) => {
  if (result.status === "complete"
    ? result.files === null || result.fingerprint === null || result.error !== null
    : result.files !== null || result.fingerprint !== null || result.error === null || result.entries !== 0) {
    context.addIssue({ code: "custom", message: "Inconsistent playlist result" });
  }
});

const manifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: z.string().regex(runIdPattern),
  provider: z.enum(["youtube", "spotify"]),
  startedAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
  status: z.enum(["running", "complete", "partial", "failed", "interrupted"]),
  coverage: z.string(),
  warnings: z.array(z.string()),
  playlists: z.array(resultSchema),
  totals: z.strictObject({
    playlists: countSchema,
    completed: countSchema,
    failed: countSchema,
    entries: countSchema,
  }),
  error: z.string().nullable(),
}).superRefine((manifest, context) => {
  const completed = manifest.playlists.filter(item => item.status === "complete");
  const files = completed.flatMap(item => Object.values(item.files!));
  if (manifest.totals.completed !== completed.length
    || manifest.totals.failed !== manifest.playlists.length - completed.length
    || manifest.totals.entries !== completed.reduce((total, item) => total + item.entries, 0)
    || manifest.totals.playlists < manifest.playlists.length
    || new Set(files.map(file => file.toLowerCase())).size !== files.length
    || ((manifest.status === "complete" || manifest.status === "partial")
      && manifest.totals.playlists !== manifest.playlists.length)
    || (manifest.status === "complete" && (manifest.totals.failed !== 0 || manifest.error !== null))
    || (manifest.status === "partial" && (manifest.totals.failed === 0 || completed.length === 0))
    || (["complete", "partial", "failed"].includes(manifest.status) && manifest.completedAt === null)
    || (manifest.status === "running" && manifest.completedAt !== null)) {
    context.addIssue({ code: "custom", message: "Inconsistent backup totals or status" });
  }
});

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

export function storageError(error: unknown, action: string): AppError {
  return error instanceof AppError
    ? error
    : new AppError("BACKUP_STORAGE_ERROR", `${action}: ${errorMessage(error)}`, 500);
}

function validateId(id: string): void {
  if (!runIdPattern.test(id)) {
    throw new AppError("INVALID_BACKUP_ID", "Invalid backup identifier.", 400);
  }
}

async function rootDirectory(directory: string): Promise<string> {
  try {
    const root = await fs.realpath(path.resolve(directory));
    if (!(await fs.stat(root)).isDirectory()) {
      throw new AppError("BACKUP_STORAGE_ERROR", "The backup location is not a directory.", 500);
    }
    return root;
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
      throw new AppError("BACKUP_NOT_FOUND", "The backup directory does not exist.", 404);
    }
    throw storageError(error, "Cannot access the backup directory");
  }
}

async function safeChild(parent: string, name: string, directory = false): Promise<string> {
  const candidate = path.join(parent, name);
  try {
    const info = await fs.lstat(candidate);
    if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())) {
      throw new AppError("UNSAFE_BACKUP_PATH", "Backup paths must be regular files and directories, not links.", 400);
    }
    const resolved = await fs.realpath(candidate);
    if (path.relative(parent, resolved) !== name) {
      throw new AppError("UNSAFE_BACKUP_PATH", "The backup path escapes its directory.", 400);
    }
    return resolved;
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
      throw new AppError("BACKUP_NOT_FOUND", "The requested backup or file does not exist.", 404);
    }
    throw storageError(error, "Cannot access the backup file");
  }
}

async function runDirectory(directory: string, id: string): Promise<string> {
  validateId(id);
  return safeChild(await rootDirectory(directory), id, true);
}

async function readJson(filename: string, limit: number): Promise<unknown> {
  const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if ((await handle.stat()).size > limit) {
      throw new AppError("INVALID_MANIFEST", "Backup metadata exceeds its size limit.", 500);
    }
    return JSON.parse(await handle.readFile("utf8")) as unknown;
  } finally {
    await handle.close();
  }
}

async function loadManifest(directory: string, id: string): Promise<BackupManifest> {
  const filename = await safeChild(directory, "manifest.json");
  try {
    const parsed = manifestSchema.safeParse(await readJson(filename, 16 * 1_024 * 1_024));
    if (!parsed.success || parsed.data.id !== id) {
      throw new AppError("INVALID_MANIFEST", "The backup manifest is invalid or belongs to another run.", 500);
    }
    return parsed.data;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new AppError("INVALID_MANIFEST", "The backup manifest is not valid JSON.", 500);
    }
    throw storageError(error, "Cannot read the backup manifest");
  }
}

/** Read the persisted status without inferring process liveness or changing files. */
export async function readManifest(backupDirectory: string, id: string): Promise<BackupManifest> {
  const directory = await runDirectory(backupDirectory, id);
  return loadManifest(directory, id);
}

export async function listBackups(backupDirectory: string): Promise<BackupManifest[]> {
  let root: string;
  try {
    root = await rootDirectory(backupDirectory);
  } catch (error) {
    if (error instanceof AppError && error.code === "BACKUP_NOT_FOUND") return [];
    throw error;
  }
  try {
    const manifests: BackupManifest[] = [];
    for (const entry of await fs.readdir(root, { withFileTypes: true })) {
      if (!runIdPattern.test(entry.name) || (!entry.isDirectory() && !entry.isSymbolicLink())) continue;
      try {
        manifests.push(await readManifest(root, entry.name));
      } catch (error) {
        // A newly-created run may not have published its initial manifest yet.
        if (error instanceof AppError && error.code === "BACKUP_NOT_FOUND") continue;
        throw error;
      }
    }
    return manifests.sort((left, right) => right.startedAt.localeCompare(left.startedAt)
      || right.id.localeCompare(left.id));
  } catch (error) {
    throw storageError(error, "Cannot list backups");
  }
}

/**
 * Call once at startup, while holding the exclusive data-root runtime lock and
 * before starting any backups. Returns only the manifests changed by recovery.
 * Cross-process exclusion belongs to that lock, not unreliable PID heuristics.
 */
export async function recoverInterruptedBackups(backupDirectory: string): Promise<BackupManifest[]> {
  const manifests = await listBackups(backupDirectory);
  const pending: { directory: string; manifest: BackupManifest }[] = [];
  for (const manifest of manifests) {
    if (manifest.status !== "running") continue;
    const directory = await runDirectory(backupDirectory, manifest.id);
    if (activeRuns.has(directory)) {
      throw new AppError("BACKUP_ACTIVE", "Cannot recover backups while a backup run is active.", 409);
    }
    pending.push({ directory, manifest });
  }
  const recovered: BackupManifest[] = [];
  for (const { directory, manifest } of pending) {
    const interrupted: BackupManifest = {
      ...manifest,
      status: "interrupted",
      error: manifest.error
        ?? "The backup process stopped before completing this run. Only checkpointed playlists are available.",
    };
    await checkpointManifest(directory, interrupted);
    recovered.push(interrupted);
  }
  return recovered;
}

export async function resolveBackupFile(backupDirectory: string, id: string, file: string): Promise<string> {
  validateId(id);
  if (!isBasename(file)) {
    throw new AppError("INVALID_BACKUP_FILE", "A backup file must be a safe relative basename.", 400);
  }
  const manifest = await readManifest(backupDirectory, id);
  const allowed = file === "manifest.json" || manifest.playlists.some(
    playlist => playlist.status === "complete" && playlist.files !== null
      && Object.values(playlist.files).includes(file),
  );
  if (!allowed) {
    throw new AppError("BACKUP_FILE_NOT_FOUND", "The file is not part of this backup.", 404);
  }
  return safeChild(await runDirectory(backupDirectory, id), file);
}

/** Publish only fully flushed files. Temporary files belong exclusively to this write. */
export async function atomicWrite(directory: string, file: string, contents: string): Promise<void> {
  if (!isBasename(file)) {
    throw new AppError("INVALID_BACKUP_FILE", "Invalid backup output basename.", 400);
  }
  const temporary = path.join(directory, `.write-${randomUUID()}.tmp`);
  let owned = false;
  try {
    const handle = await fs.open(temporary, "wx", 0o600);
    owned = true;
    try {
      await handle.writeFile(contents, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, path.join(directory, file));
    owned = false;
  } catch (error) {
    throw storageError(error, `Cannot write ${file}`);
  } finally {
    if (owned) {
      try {
        await fs.unlink(temporary);
      } catch (error) {
        if (!hasCode(error, "ENOENT")) throw storageError(error, "Cannot clean up an incomplete backup write");
      }
    }
  }
}

export interface BackupRun {
  id: string;
  directory: string;
  startedAt: string;
  release: () => Promise<void>;
}

export async function createBackupRun(backupDirectory: string): Promise<BackupRun> {
  try {
    await fs.mkdir(path.resolve(backupDirectory), { recursive: true, mode: 0o700 });
    const root = await rootDirectory(backupDirectory);
    const startedAt = new Date().toISOString();
    const id = `${startedAt.replace(/[:.]/g, "-")}_${randomUUID()}`;
    const directory = path.join(root, id);
    await fs.mkdir(directory, { mode: 0o700 });
    activeRuns.add(directory);
    try {
      await atomicWrite(directory, BACKUP_OWNER_FILENAME, `${JSON.stringify({
        app: BACKUP_OWNER_APP,
        schemaVersion: 1,
        id,
        createdAt: startedAt,
      }, null, 2)}\n`);
    } catch (error) {
      activeRuns.delete(directory);
      throw error;
    }
    return {
      id,
      directory,
      startedAt,
      release: async () => {
        activeRuns.delete(directory);
      },
    };
  } catch (error) {
    throw storageError(error, "Cannot create a backup run");
  }
}

export async function checkpointManifest(directory: string, manifest: BackupManifest): Promise<void> {
  const parsed = manifestSchema.safeParse(manifest);
  if (!parsed.success) {
    throw new AppError("INVALID_MANIFEST", "Refusing to save an inconsistent backup manifest.", 500);
  }
  await atomicWrite(directory, "manifest.json", `${JSON.stringify(parsed.data, null, 2)}\n`);
}
