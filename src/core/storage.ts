import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { AppError, errorMessage } from "./errors.js";
import type { BackupManifest, BackupPlaylistResult, ExportIntegrity } from "./models.js";

const runIdPattern = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const fingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);
const countSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const activeRuns = new Set<string>();
export const BACKUP_OWNER_FILENAME = ".backup-owner.json";
export const BACKUP_OWNER_APP = "dw-music-sync-tool";
export const BACKUP_PENDING_FILENAME = ".backup-pending.json";
const ownerSchema = z.strictObject({
  app: z.literal(BACKUP_OWNER_APP),
  schemaVersion: z.literal(1),
  id: z.string().regex(runIdPattern),
  createdAt: z.iso.datetime(),
});

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

const exportIntegritySchema = z.strictObject({
  size: countSchema,
  sha256: fingerprintSchema,
});
const resultSchema = z.strictObject({
  playlistId: z.string(),
  title: z.string(),
  status: z.enum(["complete", "failed"]),
  entries: countSchema,
  files: filesSchema.nullable(),
  fingerprint: fingerprintSchema.nullable(),
  warnings: z.array(z.string()),
  error: z.string().nullable(),
  integrity: z.strictObject({
    json: exportIntegritySchema,
    csv: exportIntegritySchema,
    m3u: exportIntegritySchema,
  }).optional(),
}).superRefine((result, context) => {
  if (result.status === "complete"
    ? result.files === null || result.fingerprint === null || result.error !== null
    : result.files !== null || result.fingerprint !== null || result.error === null || result.entries !== 0
      || result.integrity !== undefined) {
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

const pendingFileSchema = exportIntegritySchema.extend({
  file: z.string().refine(isBasename),
  temporary: z.string().regex(/^\.write-[0-9a-f-]{36}\.tmp$/),
});
const pendingSchema = z.strictObject({
  app: z.literal(BACKUP_OWNER_APP),
  schemaVersion: z.literal(1),
  id: z.string().regex(runIdPattern),
  createdAt: z.iso.datetime(),
  index: countSchema,
  totalPlaylists: countSchema,
  checkpoint: fingerprintSchema,
  result: resultSchema,
  outputs: z.array(pendingFileSchema).length(3),
  manifestWrite: pendingFileSchema.extend({ file: z.literal("manifest.json") }),
});

function digest(contents: string | Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

function recoveryError(message: string): AppError {
  return new AppError("BACKUP_RECOVERY_ERROR", `${message}; preserving the run for inspection.`, 500);
}

function sameFile(before: Stats, after: Stats): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size
    && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs && before.nlink === after.nlink;
}

async function ordinaryFile(directory: string, name: string): Promise<Stats> {
  const filename = await safeChild(directory, name);
  const info = await fs.lstat(filename);
  if (info.nlink !== 1) throw recoveryError(`"${name}" is not an ordinary, unlinked file`);
  return info;
}

async function checkedText(directory: string, name: string, limit: number): Promise<string> {
  const before = await ordinaryFile(directory, name);
  if (before.size > limit) throw recoveryError(`"${name}" exceeds its metadata size limit`);
  const handle = await fs.open(path.join(directory, name), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!sameFile(before, await handle.stat())) throw recoveryError(`"${name}" changed while being read`);
    const text = await handle.readFile("utf8");
    if (!sameFile(before, await handle.stat())) throw recoveryError(`"${name}" changed while being read`);
    return text;
  } finally {
    await handle.close();
  }
}

function checkpointDigest(manifest: BackupManifest, index: number): string {
  return digest(JSON.stringify({
    id: manifest.id, startedAt: manifest.startedAt, provider: manifest.provider,
    coverage: manifest.coverage, playlists: manifest.playlists.slice(0, index),
  }));
}

export interface PendingExports {
  text: string;
  files: string[];
  present: Map<string, Stats>;
  integrity: Map<string, ExportIntegrity>;
}

/** Verify original bytes, rejecting replacement content and links; missing files permit safe deletion retries. */
export async function verifyExportIntegrity(
  directory: string, name: string, expected: ExportIntegrity,
): Promise<Stats | null> {
  let before: Stats;
  try {
    before = await ordinaryFile(directory, name);
  } catch (error) {
    if (error instanceof AppError && error.code === "BACKUP_NOT_FOUND") return null;
    throw error;
  }
  if (before.size !== expected.size) throw recoveryError(`Export "${name}" has changed from its recorded size`);
  const handle = await fs.open(path.join(directory, name), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!sameFile(before, await handle.stat())) throw recoveryError(`Export "${name}" changed while being read`);
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    if (hash.digest("hex") !== expected.sha256 || !sameFile(before, await handle.stat())) {
      throw recoveryError(`Export "${name}" does not match its recorded contents`);
    }
  } finally {
    await handle.close();
  }
  if (!sameFile(before, await ordinaryFile(directory, name))) {
    throw recoveryError(`Export "${name}" was replaced while its contents were being verified`);
  }
  return before;
}

/** An intent names exact bytes and paths, never a filename pattern to delete. */
export async function readPendingExports(directory: string, manifest: BackupManifest): Promise<PendingExports | null> {
  let text: string;
  try {
    text = await checkedText(directory, BACKUP_PENDING_FILENAME, 1_024 * 1_024);
  } catch (error) {
    if (error instanceof AppError && error.code === "BACKUP_NOT_FOUND") return null;
    throw error;
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw recoveryError("The pending export intent is not valid JSON");
  }
  const parsed = pendingSchema.safeParse(data);
  if (!parsed.success) throw recoveryError("The pending export intent is invalid");
  const intent = parsed.data;
  const result = manifest.playlists[intent.index];
  const expectedFiles = Object.values(intent.result.files ?? {});
  const expectedIntegrity = intent.result.integrity ? Object.values(intent.result.integrity) : undefined;
  const names = [...intent.outputs.flatMap(output => [output.file, output.temporary]), intent.manifestWrite.temporary];
  const protectedNames = [
    BACKUP_OWNER_FILENAME, BACKUP_PENDING_FILENAME, "manifest.json", ".active.json",
    ...manifest.playlists.slice(0, intent.index).flatMap(item => Object.values(item.files ?? {})),
  ].map(name => name.toLowerCase());
  if (intent.id !== manifest.id || intent.createdAt !== manifest.startedAt
    || intent.totalPlaylists !== manifest.totals.playlists || intent.index >= intent.totalPlaylists
    || intent.index > manifest.playlists.length || manifest.playlists.length > intent.index + 1
    || intent.checkpoint !== checkpointDigest(manifest, intent.index)
    || intent.result.status !== "complete"
    || (result && (result.status === "complete"
      ? !isDeepStrictEqual(result, intent.result)
      : result.playlistId !== intent.result.playlistId || result.title !== intent.result.title))
    || new Set(names.map(name => name.toLowerCase())).size !== names.length
    || names.some(name => protectedNames.includes(name.toLowerCase()))
    || intent.outputs.some((output, index) => output.file !== expectedFiles[index]
      || (expectedIntegrity && !isDeepStrictEqual(
        expectedIntegrity[index], { size: output.size, sha256: output.sha256 },
      )))) {
    throw recoveryError("The pending export intent does not match its manifest");
  }
  const present = new Map<string, Stats>();
  const integrity = new Map<string, ExportIntegrity>();
  for (const output of [...intent.outputs, intent.manifestWrite]) {
    const candidates = output.file === "manifest.json" ? [output.temporary] : [output.file, output.temporary];
    for (const name of candidates) {
      integrity.set(name, { size: output.size, sha256: output.sha256 });
      const info = await verifyExportIntegrity(directory, name, output);
      if (info) present.set(name, info);
    }
    if (output.file !== "manifest.json" && present.has(output.file) && present.has(output.temporary)) {
      throw recoveryError("Both a pending export and its staging file exist");
    }
  }
  return { text, files: names, present, integrity };
}

async function assertPendingUnchanged(directory: string, pending: PendingExports): Promise<void> {
  if (await checkedText(directory, BACKUP_PENDING_FILENAME, 1_024 * 1_024) !== pending.text) {
    throw recoveryError("The pending export intent changed");
  }
}

export async function finishPlaylistExport(directory: string, manifest: BackupManifest, discard = false): Promise<void> {
  const pending = await readPendingExports(directory, manifest);
  if (!pending) return;
  if (discard) {
    for (const [name, info] of pending.present) {
      await assertPendingUnchanged(directory, pending);
      if (!sameFile(info, await ordinaryFile(directory, name))) throw recoveryError(`"${name}" changed before cleanup`);
      await fs.unlink(path.join(directory, name));
    }
  }
  await assertPendingUnchanged(directory, pending);
  await fs.unlink(path.join(directory, BACKUP_PENDING_FILENAME));
}

/** Persist ownership and content hashes before publishing any playlist output. */
export async function publishPlaylistExports(
  directory: string,
  manifest: BackupManifest,
  result: BackupPlaylistResult,
  writes: [string, string][],
): Promise<BackupPlaylistResult> {
  const outputs = writes.map(([file, text]) => ({
    file, temporary: `.write-${randomUUID()}.tmp`, size: Buffer.byteLength(text), sha256: digest(text),
  }));
  const proof = (index: number): ExportIntegrity => ({
    size: outputs[index]!.size, sha256: outputs[index]!.sha256,
  });
  const completed: BackupPlaylistResult = {
    ...result,
    integrity: { json: proof(0), csv: proof(1), m3u: proof(2) },
  };
  const checkpoint = manifestText({
    ...manifest,
    playlists: [...manifest.playlists, completed],
    totals: {
      ...manifest.totals,
      completed: manifest.totals.completed + 1,
      entries: manifest.totals.entries + result.entries,
    },
  });
  const manifestWrite = {
    file: "manifest.json", temporary: `.write-${randomUUID()}.tmp`,
    size: Buffer.byteLength(checkpoint), sha256: digest(checkpoint),
  };
  const intent = pendingSchema.parse({
    app: BACKUP_OWNER_APP, schemaVersion: 1, id: manifest.id, createdAt: manifest.startedAt,
    index: manifest.playlists.length, totalPlaylists: manifest.totals.playlists,
    checkpoint: checkpointDigest(manifest, manifest.playlists.length), result: completed, outputs, manifestWrite,
  });
  const existing = new Set((await fs.readdir(directory)).map(name => name.toLowerCase()));
  if ([BACKUP_PENDING_FILENAME, ...outputs.flatMap(output => [output.file, output.temporary]), manifestWrite.temporary]
    .some(name => existing.has(name.toLowerCase()))) {
    throw recoveryError("A playlist output or pending intent already exists");
  }
  await atomicWrite(directory, BACKUP_PENDING_FILENAME, `${JSON.stringify(intent, null, 2)}\n`);
  try {
    for (const [index, [file, text]] of writes.entries()) {
      await atomicWrite(directory, file, text, outputs[index]!.temporary);
    }
  } catch (error) {
    await finishPlaylistExport(directory, manifest, true);
    throw error;
  }
  return completed;
}

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
 * Call at startup under BOTH exclusive data-root and backup-root runtime locks,
 * before retention or backups. Only checkpointed playlists count as complete;
 * validated pending outputs remain journaled for expiration, not downloads.
 * Unmarked legacy manifests remain readable. Unprovable leftovers are preserved
 * and reported, never inferred to be ours from their names or extensions.
 */
export async function recoverInterruptedBackups(backupDirectory: string): Promise<BackupManifest[]> {
  let root: string;
  try {
    root = await rootDirectory(backupDirectory);
  } catch (error) {
    if (error instanceof AppError && error.code === "BACKUP_NOT_FOUND") return [];
    throw error;
  }
  const directories: string[] = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (!runIdPattern.test(entry.name) || (!entry.isDirectory() && !entry.isSymbolicLink())) continue;
    const directory = await runDirectory(root, entry.name);
    if (activeRuns.has(directory)) {
      throw new AppError("BACKUP_ACTIVE", "Cannot recover backups while a backup run is active.", 409);
    }
    directories.push(directory);
  }
  const pending: { directory: string; manifest: BackupManifest; text: string }[] = [];
  const emptyRuns: { directory: string; ownerText: string; identity: Stats }[] = [];
  for (const directory of directories) {
    const id = path.basename(directory);
    const entries = await fs.readdir(directory);
    if (!entries.includes("manifest.json")) {
      if (!entries.includes(BACKUP_OWNER_FILENAME)) {
        if (entries.length > 0) throw recoveryError(`Backup "${id}" has no manifest or ownership marker`);
        continue;
      }
      const ownerText = await checkedText(directory, BACKUP_OWNER_FILENAME, 4_096);
      validateOwner(ownerText, id);
      if (entries.length !== 1) throw recoveryError(`Backup "${id}" has no manifest and contains unexpected files`);
      emptyRuns.push({ directory, ownerText, identity: await fs.lstat(directory) });
      continue;
    }
    const manifest = await loadManifest(directory, id);
    if (manifest.status !== "running" && !entries.includes(BACKUP_PENDING_FILENAME)) continue;
    const text = await checkedText(directory, "manifest.json", 16 * 1_024 * 1_024);
    if (!isDeepStrictEqual(JSON.parse(text), manifest)) throw recoveryError("The manifest changed during recovery");
    if (entries.includes(BACKUP_OWNER_FILENAME)) {
      const ownerText = await checkedText(directory, BACKUP_OWNER_FILENAME, 4_096);
      validateOwner(ownerText, id, manifest.startedAt);
    } else if (entries.includes(BACKUP_PENDING_FILENAME)) {
      throw recoveryError("Pending exports have no app ownership marker");
    }
    const intent = await readPendingExports(directory, manifest);
    const allowed = new Set([
      BACKUP_OWNER_FILENAME, "manifest.json", ".active.json",
      ...manifest.playlists.flatMap(item => Object.values(item.files ?? {})),
      ...(intent ? [BACKUP_PENDING_FILENAME, ...intent.files] : []),
    ]);
    for (const name of entries) {
      if (!allowed.has(name)) throw recoveryError(`Backup "${id}" contains unexpected entry "${name}"`);
      await ordinaryFile(directory, name);
    }
    if (manifest.status === "running") pending.push({ directory, manifest, text });
  }
  // Owner-only runs contain no playlist data and cannot truthfully invent a provider.
  for (const { directory, ownerText, identity } of emptyRuns) {
    if (!sameFile(identity, await fs.lstat(directory))
      || (await fs.readdir(directory)).join() !== BACKUP_OWNER_FILENAME
      || await checkedText(directory, BACKUP_OWNER_FILENAME, 4_096) !== ownerText) {
      throw recoveryError("An owner-only run changed during recovery");
    }
    await fs.unlink(path.join(directory, BACKUP_OWNER_FILENAME));
    try {
      await fs.rmdir(directory);
    } catch (error) {
      const handle = await fs.open(path.join(directory, BACKUP_OWNER_FILENAME), "wx", 0o600);
      try {
        await handle.writeFile(ownerText);
        await handle.sync();
      } finally {
        await handle.close();
      }
      throw storageError(error, "Cannot remove an empty interrupted run");
    }
  }
  const recovered: BackupManifest[] = [];
  for (const { directory, manifest, text } of pending) {
    const interrupted: BackupManifest = {
      ...manifest,
      status: "interrupted",
      error: manifest.error
        ?? "The backup process stopped before completing this run. Only checkpointed playlists are available.",
    };
    if (await checkedText(directory, "manifest.json", 16 * 1_024 * 1_024) !== text) {
      throw recoveryError("The manifest changed before recovery checkpoint");
    }
    await checkpointManifest(directory, interrupted);
    recovered.push(interrupted);
  }
  return recovered;
}

function validateOwner(text: string, id: string, startedAt?: string): void {
  let owner: z.infer<typeof ownerSchema>;
  try {
    owner = ownerSchema.parse(JSON.parse(text));
  } catch {
    throw recoveryError("Invalid app ownership marker");
  }
  if (owner.id !== id || !id.startsWith(`${owner.createdAt.replace(/[:.]/g, "-")}_`)
    || (startedAt !== undefined && owner.createdAt !== startedAt)) {
    throw recoveryError("App ownership does not match the run");
  }
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
export async function atomicWrite(
  directory: string, file: string, contents: string, stagingName?: string, replace = false,
): Promise<void> {
  if (!isBasename(file)) {
    throw new AppError("INVALID_BACKUP_FILE", "Invalid backup output basename.", 400);
  }
  if (stagingName !== undefined && !/^\.write-[0-9a-f-]{36}\.tmp$/.test(stagingName)) {
    throw new AppError("INVALID_BACKUP_FILE", "Invalid backup staging basename.", 400);
  }
  const temporary = path.join(directory, stagingName ?? `.write-${randomUUID()}.tmp`);
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
    if (stagingName && !replace && (await fs.readdir(directory)).some(name => name.toLowerCase() === file.toLowerCase())) {
      throw recoveryError(`Playlist output "${file}" appeared after its intent was saved`);
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

function manifestText(manifest: BackupManifest): string {
  const parsed = manifestSchema.safeParse(manifest);
  if (!parsed.success) {
    throw new AppError("INVALID_MANIFEST", "Refusing to save an inconsistent backup manifest.", 500);
  }
  return `${JSON.stringify(parsed.data, null, 2)}\n`;
}

export async function checkpointManifest(directory: string, manifest: BackupManifest): Promise<void> {
  const text = manifestText(manifest);
  let stagingName: string | undefined;
  try {
    const intent = pendingSchema.parse(JSON.parse(await checkedText(directory, BACKUP_PENDING_FILENAME, 1_024 * 1_024)));
    if (intent.id === manifest.id && intent.manifestWrite.sha256 === digest(text)
      && intent.manifestWrite.size === Buffer.byteLength(text)) {
      stagingName = intent.manifestWrite.temporary;
    }
  } catch (error) {
    if (!(error instanceof AppError && error.code === "BACKUP_NOT_FOUND")) throw error;
  }
  await atomicWrite(directory, "manifest.json", text, stagingName, true);
}
