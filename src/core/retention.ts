import { constants, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { AppError, errorMessage } from "./errors.js";
import {
  BACKUP_OWNER_APP, BACKUP_OWNER_FILENAME, BACKUP_PENDING_FILENAME, readManifest, readPendingExports,
  activeBackupStartedAt, inspectPendingFile, settlePendingExportLinks, verifyExportIntegrity,
} from "./storage.js";

export const RETENTION_DAYS = 30;
const retentionMilliseconds = RETENTION_DAYS * 24 * 60 * 60 * 1_000;
const pruningRoots = new Set<string>();
const ownerSchema = z.strictObject({
  app: z.literal(BACKUP_OWNER_APP),
  schemaVersion: z.literal(1),
  id: z.string(),
  createdAt: z.iso.datetime(),
});

export interface BackupPruneResult {
  deleted: string[];
  warnings: string[];
}

export function backupExpiresAt(startedAt: string): string {
  if (!z.iso.datetime().safeParse(startedAt).success) {
    throw new AppError("INVALID_RETENTION_TIME", "Backup start time must be a valid UTC ISO timestamp.", 400);
  }
  const expiry = Date.parse(startedAt) + retentionMilliseconds;
  if (!Number.isFinite(expiry) || Math.abs(expiry) > 8.64e15) {
    throw new AppError("INVALID_RETENTION_TIME", "Backup expiry is outside the supported date range.", 400);
  }
  return new Date(expiry).toISOString();
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function unchanged(before: Stats, after: Stats): boolean {
  return before.dev === after.dev && before.ino === after.ino
    && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs
    && before.nlink === after.nlink;
}

async function assertRun(root: string, id: string, identity?: Stats): Promise<string> {
  const directory = path.join(root, id);
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()
    || (identity && (info.ino !== identity.ino || info.dev !== identity.dev))
    || path.relative(root, await fs.realpath(directory)) !== id) {
    throw new Error("the run directory is linked, replaced, or outside its backup root");
  }
  return directory;
}

async function regularFile(directory: string, name: string): Promise<Stats> {
  const filename = path.join(directory, name);
  const info = await fs.lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1
    || path.relative(directory, await fs.realpath(filename)) !== name) {
    throw new Error(`"${name}" is not an ordinary, unlinked file inside the run`);
  }
  return info;
}

async function readMetadata(directory: string, name: string, limit: number): Promise<string> {
  const before = await regularFile(directory, name);
  if (before.size > limit) throw new Error(`"${name}" exceeds its metadata size limit`);
  const handle = await fs.open(path.join(directory, name), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!unchanged(before, await handle.stat())) throw new Error(`"${name}" changed while being read`);
    const text = await handle.readFile("utf8");
    if (!unchanged(before, await handle.stat())) throw new Error(`"${name}" changed while being read`);
    return text;
  } finally {
    await handle.close();
  }
}

async function staleActiveMarker(directory: string): Promise<void> {
  const parsed = z.strictObject({ pid: z.number().int().positive(), token: z.uuid() })
    .safeParse(JSON.parse(await readMetadata(directory, ".active.json", 1_024)) as unknown);
  if (!parsed.success) throw new Error("the legacy active marker is malformed");
  try {
    process.kill(parsed.data.pid, 0);
  } catch (error) {
    if (hasCode(error, "ESRCH")) return;
    throw new Error("the legacy active marker may belong to a live process");
  }
  throw new Error("the legacy active marker belongs to a live process");
}

async function restoreMetadata(directory: string, name: string, contents: string): Promise<void> {
  let handle;
  try {
    handle = await fs.open(path.join(directory, name), "wx", 0o600);
  } catch (error) {
    if (hasCode(error, "EEXIST")) {
      if (await readMetadata(directory, name, 16 * 1_024 * 1_024) !== contents) {
        throw new Error(`cannot restore "${name}" because a different file now exists`);
      }
      return;
    }
    throw error;
  }
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function pruneRun(
  root: string, id: string, now: number, settleLinks = true,
): Promise<"deleted" | "recent" | "unmanaged"> {
  const directory = await assertRun(root, id);
  const activeStartedAt = activeBackupStartedAt(directory);
  if (activeStartedAt !== undefined) {
    if (now >= Date.parse(backupExpiresAt(activeStartedAt))) {
      throw new Error("backup is running; active runs are never removed");
    }
    return "recent";
  }
  const identity = await fs.lstat(directory);
  let ownerText: string;
  try {
    ownerText = await readMetadata(directory, BACKUP_OWNER_FILENAME, 4_096);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return "unmanaged";
    throw error;
  }
  const ownerData: unknown = JSON.parse(ownerText);
  if (typeof ownerData === "object" && ownerData !== null
    && "app" in ownerData && ownerData.app !== BACKUP_OWNER_APP) return "unmanaged";
  const owner = ownerSchema.safeParse(ownerData);
  if (!owner.success || owner.data.id !== id) throw new Error("invalid or mismatched app ownership marker");
  const manifest = await readManifest(root, id);
  if (owner.data.createdAt !== manifest.startedAt
    || !id.startsWith(`${manifest.startedAt.replace(/[:.]/g, "-")}_`)) {
    throw new Error("ownership timestamp does not match the run and manifest");
  }
  if (now < Date.parse(backupExpiresAt(manifest.startedAt))) return "recent";
  if (manifest.status === "running") throw new Error("backup is running; active runs are never removed");

  const manifestText = await readMetadata(directory, "manifest.json", 16 * 1_024 * 1_024);
  if (!isDeepStrictEqual(JSON.parse(manifestText), manifest)) {
    throw new Error("manifest changed during retention inspection");
  }
  const exports = manifest.playlists.flatMap(item => item.files ? Object.values(item.files) : []);
  if (exports.some(file => [BACKUP_OWNER_FILENAME, BACKUP_PENDING_FILENAME, "manifest.json", ".active.json"]
    .includes(file.toLowerCase()))) {
    throw new Error("an export filename collides with protected run metadata");
  }
  const pending = await readPendingExports(directory, manifest);
  const outputs = [...new Set([...exports, ...(pending?.files ?? [])])];
  const allowed = new Set([
    ...outputs, BACKUP_OWNER_FILENAME, "manifest.json", ".active.json",
    ...(pending ? [BACKUP_PENDING_FILENAME] : []),
  ]);
  const files = new Map<string, Stats>();
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (!allowed.has(entry.name)) throw new Error(`unexpected entry "${entry.name}"; preserving the entire run`);
    files.set(entry.name, pending?.linkedStages.size
      ? await inspectPendingFile(directory, entry.name, pending) : await regularFile(directory, entry.name));
  }
  if (files.has(".active.json")) await staleActiveMarker(directory);
  if (!files.has(BACKUP_OWNER_FILENAME) || !files.has("manifest.json")) {
    throw new Error("ownership marker or manifest disappeared during inspection");
  }
  const integrity = new Map(pending?.integrity);
  for (const playlist of manifest.playlists) {
    if (!playlist.files) continue;
    for (const format of ["json", "csv", "m3u"] as const) {
      const name = playlist.files[format];
      const proof = playlist.integrity?.[format];
      if (proof) integrity.set(name, proof);
      if (!integrity.has(name)) {
        throw new Error(`no original integrity evidence for "${name}"; legacy exports require manual inspection, not automatic deletion`);
      }
    }
  }
  const verified = new Map(pending?.present);
  for (const [name, proof] of integrity) {
    if (pending?.integrity.has(name)) continue;
    const info = await verifyExportIntegrity(directory, name, proof);
    if (info) verified.set(name, info);
  }
  if (await readMetadata(directory, BACKUP_OWNER_FILENAME, 4_096) !== ownerText
    || await readMetadata(directory, "manifest.json", 16 * 1_024 * 1_024) !== manifestText
    || (pending && await readMetadata(directory, BACKUP_PENDING_FILENAME, 1_024 * 1_024) !== pending.text)) {
    throw new Error("ownership marker, manifest, or pending intent changed during inspection");
  }
  for (const name of integrity.keys()) {
    const before = verified.get(name);
    const after = files.get(name);
    if (before ? !after || !unchanged(before, after) : after) {
      throw new Error("exports changed after content verification");
    }
  }
  if (pending && pending.linkedStages.size > 0) {
    if (!settleLinks) throw new Error("journaled hard links reappeared during retention");
    await assertRun(root, id, identity);
    await settlePendingExportLinks(directory, manifest, pending);
    // Link count and ctime legitimately changed; repeat the complete preflight with fresh identities.
    return pruneRun(root, id, now, false);
  }
  // Missing declared exports are allowed so interrupted deletions can be retried.
  const deletionOrder = [
    ...outputs, ".active.json", ...(pending ? [BACKUP_PENDING_FILENAME] : []),
    "manifest.json", BACKUP_OWNER_FILENAME,
  ];
  const remaining = new Set(files.keys());
  let removedMetadata = false;
  let deletionStarted = false;
  try {
    for (const name of deletionOrder) {
      const expected = files.get(name);
      if (!expected) continue;
      await assertRun(root, id, identity);
      // Also reject a previously missing or deleted output that reappears at an allowed basename.
      const current = await fs.readdir(directory);
      if (current.some(file => !remaining.has(file))) throw new Error("unexpected files were added or reappeared during deletion");
      if (!deletionStarted) {
        for (const [file, info] of files) {
          if (!unchanged(info, await regularFile(directory, file))) {
            throw new Error(`"${file}" changed after the deletion preflight`);
          }
        }
      }
      const proof = integrity.get(name);
      const info = proof ? await verifyExportIntegrity(directory, name, proof) : await regularFile(directory, name);
      if (!info || !unchanged(expected, info)) {
        throw new Error(`"${name}" changed after the deletion preflight`);
      }
      await fs.unlink(path.join(directory, name));
      deletionStarted = true;
      remaining.delete(name);
      if (name === "manifest.json" || name === BACKUP_OWNER_FILENAME || name === BACKUP_PENDING_FILENAME) removedMetadata = true;
    }
    await assertRun(root, id, identity);
    await fs.rmdir(directory);
    return "deleted";
  } catch (error) {
    if (removedMetadata) {
      try {
        await assertRun(root, id, identity);
        await restoreMetadata(directory, BACKUP_OWNER_FILENAME, ownerText);
        await restoreMetadata(directory, "manifest.json", manifestText);
        if (pending) await restoreMetadata(directory, BACKUP_PENDING_FILENAME, pending.text);
      } catch (restoreError) {
        throw new Error(`deletion failed: ${errorMessage(error)}; restoring ownership/manifest also failed: ${errorMessage(restoreError)}`);
      }
    }
    throw new Error(`deletion stopped: ${errorMessage(error)}; ownership and manifest retained for a safe retry`);
  }
}

/**
 * Requires both exclusive runtime locks and startup recovery first. Never follows
 * links, recursively removes directories, or infers ownership from a filename.
 */
export async function pruneExpiredBackups(backupDirectory: string, now = Date.now()): Promise<BackupPruneResult> {
  if (!Number.isFinite(now) || Math.abs(now) > 8.64e15) {
    throw new AppError("INVALID_RETENTION_TIME", "Retention requires a valid current timestamp.", 400);
  }
  const result: BackupPruneResult = { deleted: [], warnings: [] };
  let root: string;
  try {
    root = await fs.realpath(path.resolve(backupDirectory));
    if (!(await fs.stat(root)).isDirectory()) throw new Error("backup root is not a directory");
  } catch (error) {
    if (!hasCode(error, "ENOENT")) result.warnings.push(`Retention could not inspect the backup root: ${errorMessage(error)}`);
    return result;
  }
  if (pruningRoots.has(root)) {
    result.warnings.push("Retention is already running for this backup root.");
    return result;
  }
  pruningRoots.add(root);
  try {
    for (const entry of await fs.readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      try {
        if (await pruneRun(root, entry.name, now) === "deleted") result.deleted.push(entry.name);
      } catch (error) {
        result.warnings.push(`Preserved "${entry.name}": ${errorMessage(error)}`);
      }
    }
  } catch (error) {
    result.warnings.push(`Retention could not finish scanning backups: ${errorMessage(error)}`);
  } finally {
    pruningRoots.delete(root);
  }
  return result;
}
