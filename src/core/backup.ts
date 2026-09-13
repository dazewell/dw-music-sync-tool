import { createHash } from "node:crypto";
import { AppError, errorMessage } from "./errors.js";
import type {
  BackupManifest,
  BackupPlaylistResult,
  BackupProgress,
  Playlist,
  PlaylistArchive,
  PlaylistContents,
  PlaylistProvider,
} from "./models.js";
import {
  checkpointManifest, createBackupRun, finishPlaylistExport, publishPlaylistExports, storageError,
} from "./storage.js";
import { fingerprintPlaylist } from "./sync.js";

export { listBackups, readManifest, recoverInterruptedBackups, resolveBackupFile } from "./storage.js";

function exportBasename(playlist: Playlist, index: number): string {
  let title = playlist.title.normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/gu, "-")
    .replace(/^[. ]+|[. ]+$/gu, "") || "playlist";
  title = [...title].slice(0, 70).join("");
  while (Buffer.byteLength(title, "utf8") > 160) title = [...title].slice(0, -1).join("");
  const hash = createHash("sha256").update(`${playlist.provider}:${playlist.id}`).digest("hex").slice(0, 12);
  return `${title}-${hash}-${String(index + 1).padStart(4, "0")}`;
}

function csvCell(value: string | number | null): string {
  let text = value === null ? "" : String(value);
  // Excel and similar readers interpret formulas even when the CSV field is quoted.
  if (/^[\s\u0000-\u001f]*[=+\-@]/u.test(text) || /^[\t\r\n]/u.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function exportCsv(contents: PlaylistContents): string {
  const rows: (string | number | null)[][] = [[
    "position", "entry_id", "media_id", "title", "artist", "album", "url", "availability", "added_at",
  ]];
  for (const entry of contents.entries) {
    rows.push([
      entry.position, entry.id, entry.mediaId, entry.title, entry.artist,
      entry.album, entry.url, entry.availability, entry.addedAt,
    ]);
  }
  return `\ufeff${rows.map(row => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

function singleLine(value: string): string {
  return value.replace(/[\r\n\u0000-\u001f\u007f\u2028\u2029]/gu, " ");
}

function exportM3u(contents: PlaylistContents): string {
  const lines = [
    "#EXTM3U",
    "# Playlist URL references only; no audio is downloaded or included.",
    `#PLAYLIST:${singleLine(contents.playlist.title)}`,
  ];
  for (const entry of contents.entries) {
    const label = singleLine([entry.artist, entry.title].filter(Boolean).join(" - "));
    let url: URL | null = null;
    try {
      if (entry.url && !/[\r\n\u0000-\u0020\u007f]/u.test(entry.url)) url = new URL(entry.url);
    } catch {
      // Invalid or absent URLs remain represented as placeholder comments.
    }
    if (entry.availability === "unavailable" || !url || !["https:", "http:"].includes(url.protocol)) {
      lines.push(`#UNAVAILABLE:${entry.position} ${singleLine(entry.id)} ${label}`);
    } else {
      lines.push(`#EXTINF:-1,${label}`, entry.url!);
    }
  }
  return `${lines.join("\n")}\n`;
}

function failedResult(playlist: Playlist, error: unknown): BackupPlaylistResult {
  return {
    playlistId: playlist.id,
    title: playlist.title,
    status: "failed",
    entries: 0,
    files: null,
    fingerprint: null,
    warnings: [],
    error: errorMessage(error),
  };
}

async function writePlaylist(
  directory: string,
  playlist: Playlist,
  contents: PlaylistContents,
  index: number,
  manifest: BackupManifest,
): Promise<BackupPlaylistResult> {
  const base = exportBasename(playlist, index);
  const files = { json: `${base}.json`, csv: `${base}.csv`, m3u: `${base}.m3u8` };
  const fingerprint = fingerprintPlaylist(playlist.provider, contents.entries);
  const archive: PlaylistArchive = {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    fingerprint,
    playlist: contents.playlist,
    entries: contents.entries,
    warnings: [...contents.warnings],
  };
  const writes: [string, string][] = [
    [files.json, `${JSON.stringify(archive, null, 2)}\n`],
    [files.csv, exportCsv(contents)],
    [files.m3u, exportM3u(contents)],
  ];
  const result: BackupPlaylistResult = {
    playlistId: playlist.id,
    title: playlist.title,
    status: "complete",
    entries: contents.entries.length,
    files,
    fingerprint,
    warnings: [...contents.warnings],
    error: null,
  };
  return publishPlaylistExports(directory, manifest, result, writes);
}

export async function runBackup(
  provider: PlaylistProvider,
  backupDirectory: string,
  onProgress?: (progress: BackupProgress) => void,
): Promise<BackupManifest> {
  const run = await createBackupRun(backupDirectory);
  const manifest: BackupManifest = {
    schemaVersion: 1,
    id: run.id,
    provider: provider.id,
    startedAt: run.startedAt,
    completedAt: null,
    status: "running",
    coverage: provider.coverage,
    warnings: [],
    playlists: [],
    totals: { playlists: 0, completed: 0, failed: 0, entries: 0 },
    error: null,
  };
  const progress = (current: number, playlistTitle: string | null) => {
    try {
      onProgress?.({ current, total: manifest.totals.playlists, playlistTitle });
    } catch {
      const warning = "A progress listener failed; the backup continued without relying on that listener.";
      if (!manifest.warnings.includes(warning)) manifest.warnings.push(warning);
    }
  };
  let failure: unknown;
  try {
    await checkpointManifest(run.directory, manifest);
    let playlists: Playlist[];
    try {
      playlists = await provider.listPlaylists();
    } catch (error) {
      manifest.status = "failed";
      manifest.error = `Playlist discovery failed: ${errorMessage(error)}`;
      manifest.completedAt = new Date().toISOString();
      await checkpointManifest(run.directory, manifest);
      return manifest;
    }
    manifest.totals.playlists = playlists.length;
    await checkpointManifest(run.directory, manifest);
    progress(0, null);
    for (const [index, playlist] of playlists.entries()) {
      progress(index, playlist.title);
      let contents: PlaylistContents | undefined;
      let result: BackupPlaylistResult;
      try {
        const fetched = await provider.getPlaylist(playlist);
        const expectedCount = fetched.playlist.itemCount ?? playlist.itemCount;
        if (expectedCount !== null && expectedCount !== fetched.entries.length) {
          throw new AppError(
            "PLAYLIST_INCOMPLETE",
            `Playlist item count mismatch: expected ${expectedCount} entries but fetched ${fetched.entries.length}. `
              + "The playlist may have changed during reading; retry the backup.",
            502,
          );
        }
        contents = fetched;
      } catch (error) {
        result = failedResult(playlist, error);
      }
      if (contents) {
        try {
          result = await writePlaylist(run.directory, playlist, contents, index, manifest);
        } catch (error) {
          manifest.playlists.push(failedResult(playlist, error));
          manifest.totals.failed++;
          throw storageError(error, "Cannot export playlist");
        }
      } else {
        result ??= failedResult(playlist, new Error("The provider returned no playlist contents."));
      }
      manifest.playlists.push(result);
      if (result.status === "complete") {
        manifest.totals.completed++;
        manifest.totals.entries += result.entries;
      } else {
        manifest.totals.failed++;
      }
      await checkpointManifest(run.directory, manifest);
      if (result.status === "complete") await finishPlaylistExport(run.directory, manifest);
      progress(index + 1, playlist.title);
    }
    manifest.status = manifest.totals.failed === 0
      ? "complete"
      : manifest.totals.completed > 0 ? "partial" : "failed";
    manifest.completedAt = new Date().toISOString();
    if (manifest.status === "failed") manifest.error = "All discovered playlists failed to export.";
    await checkpointManifest(run.directory, manifest);
    return manifest;
  } catch (error) {
    failure = storageError(error, "Backup failed");
    manifest.status = "failed";
    manifest.completedAt = new Date().toISOString();
    manifest.error = errorMessage(failure);
    try {
      await checkpointManifest(run.directory, manifest);
    } catch (checkpointError) {
      failure = new AppError(
        "BACKUP_STORAGE_ERROR",
        `${errorMessage(failure)} The failure manifest also could not be saved: ${errorMessage(checkpointError)}`,
        500,
      );
    }
    throw failure;
  } finally {
    try {
      await run.release();
    } catch (error) {
      if (!failure) throw error;
    }
  }
}
