import type { ApiError, BackupJob, StatusResponse } from "../shared/api.js";
import type { BackupManifest, BackupPlaylistResult, Playlist } from "../core/models.js";

type Platform = "youtube" | "spotify";
interface SyncRef { provider: Platform; accountId: string; playlistId: string; }
interface SyncPair { id: string; left: SyncRef; right: SyncRef; enabled: boolean; createdAt: string; updatedAt: string; }
interface SyncIgnore { provider: Platform; accountId: string; playlistId: string; reason: string; createdAt: string; }
type SyncRunStatus = "running" | "complete" | "partial" | "failed" | "review-required";
interface SyncRun {
  id: string;
  pairId: string;
  status: SyncRunStatus;
  startedAt: string;
  completedAt: string | null;
  message: string | null;
}
interface SyncRemovalRecord {
  runId: string;
  runStatus: SyncRunStatus;
  pairId: string;
  /** The platform the removal was applied to. */
  platform: Platform;
  playlistId: string;
  /** Provider-native identity; never a cross-platform equivalence claim. */
  itemIdentity: string;
  direction: "left-to-right" | "right-to-left";
  /** The paired platform mirrored from, or null when the pair no longer exists. */
  sourcePlatform: Platform | null;
  timestamp: string;
  outcome: "success" | "failed";
  error: string | null;
}
interface SyncState { pairs: SyncPair[]; ignores: SyncIgnore[]; runs: SyncRun[]; removals: SyncRemovalRecord[]; }

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing interface element: ${id}`);
  return found as T;
}

const ui = {
  connection: element("connection-state"),
  connect: element<HTMLButtonElement>("connect-button"),
  disconnect: element<HTMLButtonElement>("disconnect-button"),
  backup: element<HTMLButtonElement>("backup-button"),
  backupNote: element("backup-action-note"),
  demo: element("demo-notice"),
  notice: element("notice"),
  noticeMessage: element("notice-message"),
  retryStatus: element<HTMLButtonElement>("retry-status"),
  dismissNotice: element<HTMLButtonElement>("dismiss-notice"),
  guide: element("connection-guide"),
  guideTitle: element("connection-guide-title"),
  guideCopy: element("connection-guide-copy"),
  connectionError: element("connection-error"),
  recheckConnection: element<HTMLButtonElement>("recheck-connection"),
  setup: element("setup-steps"),
  redirect: element("redirect-uri"),
  coverage: element("coverage-copy"),
  inventorySummary: element("inventory-summary"),
  refreshLibrary: element<HTMLButtonElement>("refresh-library"),
  search: element<HTMLInputElement>("playlist-search"),
  libraryFeedback: element("library-feedback"),
  tableWrap: element("playlist-table-wrap"),
  rows: element<HTMLTableSectionElement>("playlist-rows"),
  visibleCount: element("visible-count"),
  jobBadge: element("job-badge"),
  jobTitle: element("job-title"),
  jobDescription: element("job-description"),
  progressWrap: element("job-progress-wrap"),
  progress: element<HTMLProgressElement>("job-progress"),
  progressTrack: element("progress-track"),
  progressFill: element("progress-fill"),
  progressLabel: element("job-progress-label"),
  jobPlaylist: element("job-playlist"),
  jobTotals: element("job-totals"),
  jobWarning: element("job-warning"),
  retryJob: element<HTMLButtonElement>("retry-job"),
  jobAnnouncement: element("job-announcement"),
  directory: element("backup-directory"),
  retentionNotice: element("retention-notice"),
  retentionLastCheck: element("retention-last-check"),
  retentionWarning: element("retention-warning"),
  retentionError: element("retention-error"),
  recheckRetention: element<HTMLButtonElement>("recheck-retention"),
  refreshHistory: element<HTMLButtonElement>("refresh-history"),
  historyFeedback: element("history-feedback"),
  historyList: element("history-list"),
  syncNow: element<HTMLButtonElement>("sync-now"),
  syncFeedback: element("sync-feedback"),
  syncPairs: element("sync-pairs"),
  syncIgnored: element("sync-ignored"),
  syncLogs: element("sync-logs"),
  syncFooterState: element("sync-footer-state"),
  syncPairSelect: element<HTMLSelectElement>("sync-pair"),
  pairForm: element<HTMLFormElement>("pair-form"),
  pairLeftProvider: element<HTMLSelectElement>("pair-left-provider"),
  pairLeftAccount: element<HTMLInputElement>("pair-left-account"),
  pairLeftPlaylist: element<HTMLInputElement>("pair-left-playlist"),
  pairRightProvider: element<HTMLSelectElement>("pair-right-provider"),
  pairRightAccount: element<HTMLInputElement>("pair-right-account"),
  pairRightPlaylist: element<HTMLInputElement>("pair-right-playlist"),
  removalFeedback: element("removal-feedback"),
  removalTableWrap: element("removal-table-wrap"),
  removalRows: element<HTMLTableSectionElement>("removal-rows"),
  refreshRemovals: element<HTMLButtonElement>("refresh-removals"),
};

let status: StatusResponse | null = null;
let connectionCheckError: string | null = null;
let playlists: Playlist[] = [];
let backups: BackupManifest[] = [];
let inventoryLoaded = false;
let inventoryLoading = false;
let inventoryError: string | null = null;
let historyLoaded = false;
let historyLoading = false;
let historyError: string | null = null;
let job: BackupJob | null = null;
let jobKnown = false;
let jobLoading = false;
let jobError: string | null = null;
let busy: "connect" | "disconnect" | "backup" | null = null;
let booting = false;
let disposed = false;
let pollTimer: number | null = null;
let pollFailures = 0;
let polling = false;
let retentionLoading = false;
let retentionCheckError: string | null = null;
let retention: StatusResponse["retention"] | null = null;
let retentionTimer: number | null = null;
let retentionPolling = false;
let retentionRefreshPromise: Promise<void> | null = null;
let retentionFailures = 0;
let sync: SyncState | null = null;
let syncLoading = false;
let syncError: string | null = null;
let syncBusy = false;
let removals: SyncRemovalRecord[] = [];
let removalsLoaded = false;
let removalsLoading = false;
let removalsError: string | null = null;
const maxRetentionFailures = 3;
const retentionPollInterval = 60_000;
const maxPollFailures = 4;
const lifetime = new AbortController();

function text<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  content: string,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.textContent = content;
  if (className) node.className = className;
  return node;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "An unexpected error occurred. Please try again.";
}

async function request<T>(path: string, method: "GET" | "POST" | "DELETE" = "GET", body?: unknown): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  lifetime.signal.addEventListener("abort", abort, { once: true });
  if (lifetime.signal.aborted) abort();
  const timer = window.setTimeout(abort, 30_000);
  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (method !== "GET") {
      if (!status?.csrfToken) throw new Error("The connection check has expired. Reload this page before trying again.");
      headers["X-CSRF-Token"] = status.csrfToken;
    }
    const response = await fetch(path, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { ...headers, "Content-Type": "application/json" } }),
      credentials: "same-origin",
      cache: "no-store",
      signal: controller.signal,
    });
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new Error(`The local server returned an unreadable response (${response.status}). Check the server, then try again.`);
    }
    if (!response.ok) {
      const apiError = data as Partial<ApiError> | null;
      const detail = apiError?.error?.message;
      throw new Error(typeof detail === "string" && detail
        ? detail
        : `The request failed (${response.status}). Please try again.`);
    }
    return data as T;
  } catch (error) {
    if (controller.signal.aborted && !disposed) {
      throw new Error("The local server did not respond within 30 seconds. Check that it is running, then try again.");
    }
    if (error instanceof TypeError) {
      throw new Error("Cannot reach the local server. Check that it is running, then try again.");
    }
    throw error;
  } finally {
    window.clearTimeout(timer);
    lifetime.signal.removeEventListener("abort", abort);
  }
}

function notify(content: string, tone: "info" | "success" | "error" = "info", retryStatus = false): void {
  ui.noticeMessage.textContent = content;
  ui.notice.dataset.tone = tone;
  ui.notice.hidden = false;
  ui.retryStatus.hidden = !retryStatus;
}

async function requestStatus(): Promise<StatusResponse> {
  try {
    const response = await request<StatusResponse>("/api/status");
    if (!disposed) connectionCheckError = null;
    return response;
  } catch (error) {
    if (!disposed) {
      status = null;
      connectionCheckError = message(error);
      clearInventory();
      renderStatus();
      renderInventory();
    }
    throw error;
  }
}

function running(): boolean {
  return job?.state === "running";
}

function renderControls(): void {
  const locked = busy !== null || booting || retentionLoading;
  ui.connect.hidden = Boolean(status?.connected);
  ui.disconnect.hidden = !status?.connected || Boolean(status.demo);
  ui.connect.disabled = locked || !status?.configured || running() || !jobKnown;
  ui.disconnect.disabled = locked || running() || inventoryLoading || !jobKnown;
  ui.connect.textContent = busy === "connect" ? "Connecting…" : "Connect Google";
  ui.disconnect.textContent = busy === "disconnect" ? "Disconnecting…" : "Disconnect";
  ui.backup.disabled = locked || !status?.connected || running() || !jobKnown || inventoryLoading;
  ui.backup.textContent = busy === "backup" ? "Starting backup…" : running() ? "Backup in progress" : "Back up all";
  ui.refreshLibrary.disabled = locked || !status?.connected || inventoryLoading || running() || !jobKnown;
  ui.refreshLibrary.textContent = inventoryLoading ? "Refreshing…" : "Refresh library";
  ui.search.disabled = !inventoryLoaded || !status?.connected;
  ui.refreshHistory.disabled = historyLoading || booting || retentionLoading;
  ui.refreshHistory.textContent = historyLoading ? "Refreshing…" : "Refresh history";
  ui.retryJob.disabled = polling || jobLoading || booting;
  ui.retryStatus.disabled = locked || inventoryLoading || retentionPolling;
  ui.recheckConnection.disabled = locked || inventoryLoading || retentionPolling;
  ui.recheckConnection.textContent = booting ? "Checking connection…" : "Recheck connection";
  ui.recheckRetention.disabled = locked || retentionPolling || historyLoading || !status;
  ui.recheckRetention.textContent = retentionLoading || retentionPolling ? "Checking cleanup…" : "Recheck cleanup";
  ui.backupNote.textContent = booting
    ? "Checking your workspace…"
    : !status
      ? "Reconnect to the local server first"
      : !status.connected
        ? status.configured ? "Connect Google to start" : "Complete local setup to start"
        : !jobKnown
          ? "Check backup status before starting"
          : running()
            ? "Keep the local server running"
            : "All owned playlists exposed by the API";
}

function renderStatus(): void {
  ui.connection.textContent = !status
    ? "Connection unavailable"
    : status.demo
      ? "Demo · synthetic library"
      : status.connected
        ? "YouTube connected · read-only"
        : status.configured ? "YouTube not connected" : "Local setup needed";
  ui.connection.dataset.connected = String(Boolean(status?.connected));
  ui.demo.hidden = !status?.demo;
  ui.guide.hidden = Boolean(status?.connected) && !connectionCheckError;
  const connectionError = connectionCheckError ?? status?.connectionError?.message ?? null;
  ui.connectionError.hidden = !connectionError;
  ui.connectionError.textContent = connectionError;
  ui.setup.hidden = !status || status.configured;
  if (!status) {
    ui.guideTitle.textContent = "Connection check failed";
    ui.guideCopy.textContent = "Check that the local server is running and resolve the reported setup or credential-file problem, then use Recheck connection. No playlists will be read until authorization is confirmed.";
  }
  if (status) {
    ui.guideTitle.textContent = status.connectionError?.code === "GOOGLE_TOKEN_INVALID"
      ? "Reconnect Google to restore access"
      : status.configured ? "Connect Google to get started" : "Set up your local YouTube connection";
    ui.guideCopy.textContent = status.configured
      ? "Use Connect Google above to authorize read-only access to your account-owned playlists. This tool cannot change your library."
      : "Your Google OAuth client file is missing or invalid. Complete these steps on the machine running this server, then use Recheck connection before connecting your account.";
    ui.redirect.textContent = status.redirectUri;
    ui.coverage.textContent = status.coverage;
    ui.directory.textContent = status.backupDirectory;
    if (status.retention) retention = status.retention;
  }
  renderRetention();
  renderControls();
}

function retentionDays(): number {
  return retention?.days ?? 30;
}

function renderRetention(): void {
  ui.retentionNotice.textContent = `Managed exports are automatically removed ${retentionDays()} days after each run while the app is running. A stopped app cannot enforce this schedule. Downloaded copies are not managed.`;
  const lastCheckedAt = retention?.lastCheckedAt;
  ui.retentionLastCheck.textContent = lastCheckedAt
    ? `Last cleanup check: ${timestamp(lastCheckedAt)}`
    : "No cleanup check has been reported yet.";
  const errors = [retention?.error, retentionCheckError].filter((error): error is string => Boolean(error));
  ui.retentionWarning.hidden = errors.length === 0;
  ui.retentionError.textContent = errors.length > 0 ? `Automatic cleanup needs attention. ${errors.join(" ")}` : "";
}

function renderInventory(): void {
  ui.libraryFeedback.dataset.error = String(Boolean(inventoryError));
  ui.tableWrap.hidden = true;
  ui.libraryFeedback.hidden = false;
  ui.rows.replaceChildren();
  if (!status?.connected) {
    ui.inventorySummary.textContent = status ? "No account inventory loaded" : "Connection unavailable";
    ui.libraryFeedback.textContent = status
      ? "Connect your YouTube account to see the playlists available for backup."
      : "Retry the connection check to load your playlist inventory.";
    ui.visibleCount.textContent = "No inventory loaded";
  } else if (inventoryLoading && !inventoryLoaded) {
    ui.inventorySummary.textContent = "Reading the official API…";
    ui.libraryFeedback.textContent = "Loading your account-owned playlists…";
    ui.visibleCount.textContent = "Loading inventory";
  } else if (inventoryError && !inventoryLoaded) {
    ui.inventorySummary.textContent = "Inventory could not be loaded";
    ui.libraryFeedback.textContent = `${inventoryError} Use Refresh library to retry.`;
    ui.visibleCount.textContent = "No inventory loaded";
  } else if (!inventoryLoaded) {
    ui.inventorySummary.textContent = "Inventory not yet loaded";
    ui.libraryFeedback.textContent = running()
      ? "A backup is running. Refresh the library after it finishes to inspect your account-owned playlists."
      : "Use Refresh library to read your account-owned playlists.";
    ui.visibleCount.textContent = "No inventory loaded";
  } else {
    const query = ui.search.value.trim().toLocaleLowerCase();
    const filtered = playlists.filter((playlist) => playlist.title.toLocaleLowerCase().includes(query));
    ui.inventorySummary.textContent = inventoryLoading
      ? "Refreshing the official API inventory…"
      : `${playlists.length.toLocaleString()} owned ${playlists.length === 1 ? "playlist" : "playlists"} available${status.demo ? " · synthetic data" : ""}`;
    ui.visibleCount.textContent = `${filtered.length.toLocaleString()} of ${playlists.length.toLocaleString()} playlists shown`;
    if (inventoryError) {
      ui.libraryFeedback.textContent = `Showing the last loaded inventory. ${inventoryError} Use Refresh library to retry.`;
    } else if (playlists.length === 0) {
      ui.libraryFeedback.textContent = "No owned playlists were returned by the official API. Saved playlists and special Music lists may still exist outside its coverage.";
    } else if (filtered.length === 0) {
      ui.libraryFeedback.textContent = "No titles match your search. Clear the search to see all loaded playlists.";
    } else {
      ui.libraryFeedback.hidden = true;
    }
    if (filtered.length > 0) {
      ui.tableWrap.hidden = false;
      const fragment = document.createDocumentFragment();
      for (const playlist of filtered) {
        const row = document.createElement("tr");
        const titleCell = document.createElement("td");
        titleCell.append(text("span", playlist.title || "Untitled playlist", "playlist-title"));
        if (playlist.owner) titleCell.append(text("span", playlist.owner, "playlist-owner"));
        const count = text("td", playlist.itemCount === null ? "—" : playlist.itemCount.toLocaleString(), "playlist-count");
        if (playlist.itemCount === null) count.setAttribute("aria-label", "Item count unavailable");
        const visibility = text("td", playlist.visibility, "playlist-visibility");
        row.append(titleCell, count, visibility);
        fragment.append(row);
      }
      ui.rows.append(fragment);
    }
  }
  renderControls();
}

function stateLabel(state: BackupManifest["status"]): string {
  switch (state) {
    case "running": return "In progress";
    case "complete": return "Complete";
    case "partial": return "Partial";
    case "failed": return "Failed";
    case "interrupted": return "Interrupted";
  }
}

function totals(manifest: BackupManifest): string {
  const { completed, failed, entries } = manifest.totals;
  return `${completed.toLocaleString()} saved · ${failed.toLocaleString()} failed · ${entries.toLocaleString()} entries`;
}

function warningCount(manifest: BackupManifest): number {
  return manifest.warnings.length + manifest.playlists.reduce((count, result) => count + result.warnings.length, 0);
}

function timestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, {
    month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
  }).format(date);
}

function renderJob(): void {
  ui.progressWrap.hidden = true;
  ui.jobTotals.hidden = true;
  ui.jobWarning.hidden = !jobError;
  ui.jobWarning.textContent = jobError;
  ui.retryJob.hidden = !jobError;
  if (!jobKnown) {
    ui.jobBadge.textContent = jobLoading || booting ? "Checking" : "Unknown";
    ui.jobBadge.dataset.state = "";
    ui.jobTitle.textContent = jobLoading || booting ? "Checking for an active backup…" : "Backup status unavailable";
    ui.jobDescription.textContent = "Check the local server before starting another backup.";
  } else if (!job) {
    ui.jobBadge.textContent = "Ready";
    ui.jobBadge.dataset.state = "";
    ui.jobTitle.textContent = status?.connected ? "Ready when you are" : "No backup running";
    ui.jobDescription.textContent = status?.connected
      ? "Back up all fetches a fresh inventory, then saves each available owned playlist to local files."
      : "Connect your account to create a local playlist backup. Unexpired exports remain in backup history.";
  } else if (job.state === "running") {
    ui.jobBadge.textContent = "In progress";
    ui.jobBadge.dataset.state = "running";
    const total = Math.max(0, job.progress.total);
    const current = Math.max(0, Math.min(job.progress.current, total));
    ui.jobTitle.textContent = total === 0 ? "Reading your playlist inventory…" : "Saving your playlists";
    ui.jobDescription.textContent = "Keep the local server running. Closing this page does not cancel the backup.";
    ui.progressWrap.hidden = false;
    ui.progressLabel.textContent = total > 0
      ? `${current.toLocaleString()} of ${total.toLocaleString()} playlists processed`
      : "Discovering account-owned playlists";
    if (total > 0) {
      ui.progress.max = total;
      ui.progress.value = current;
      ui.progressFill.style.setProperty("--progress", String(current / total));
    } else {
      ui.progress.removeAttribute("value");
    }
    ui.progressTrack.dataset.indeterminate = String(total === 0);
    ui.jobPlaylist.textContent = job.progress.playlistTitle
      ? `Current playlist: ${job.progress.playlistTitle}`
      : "Waiting for the next progress update";
  } else {
    const manifest = job.manifest;
    const outcome = job.state === "failed" ? "failed" : manifest?.status ?? "failed";
    ui.jobBadge.textContent = stateLabel(outcome);
    ui.jobBadge.dataset.state = outcome;
    ui.jobTitle.textContent = outcome === "complete"
      ? manifest?.totals.playlists === 0 ? "No playlists found" : "Backup complete"
      : outcome === "partial" ? "Backup saved with failures"
        : outcome === "interrupted" ? "Backup was interrupted" : "Backup did not complete";
    ui.jobDescription.textContent = outcome === "complete"
      ? "The playlists exposed by the API have been processed. Inspect files and any warnings in history."
      : "Inspect the errors in backup history. Successfully exported files are kept until expiry; a new run creates a separate backup.";
    if (manifest) {
      ui.jobTotals.hidden = false;
      ui.jobTotals.textContent = totals(manifest);
    }
    const failure = job.error || manifest?.error;
    if (failure && !jobError) {
      ui.jobWarning.hidden = false;
      ui.jobWarning.textContent = failure;
    } else if (manifest && warningCount(manifest) > 0 && !jobError) {
      const count = warningCount(manifest);
      ui.jobWarning.hidden = false;
      ui.jobWarning.textContent = `${count} ${count === 1 ? "warning" : "warnings"} recorded. Expand this backup in history to inspect the details.`;
    }
  }
  const announcement = `${ui.jobTitle.textContent ?? ""}${running() ? `. ${ui.progressLabel.textContent ?? ""}` : ""}`;
  if (ui.jobAnnouncement.textContent !== announcement) ui.jobAnnouncement.textContent = announcement;
  renderControls();
}

function renderResult(manifest: BackupManifest, result: BackupPlaylistResult): HTMLLIElement {
  const item = document.createElement("li");
  const heading = text("div", "", "result-heading");
  const badge = text("span", result.status === "complete" ? "Saved" : "Failed", "badge");
  badge.dataset.state = result.status;
  heading.append(text("span", result.title || "Untitled playlist", "result-title"), badge);
  item.append(heading);
  if (result.status === "complete") {
    item.append(text("p", `${result.entries.toLocaleString()} ordered entries`, "result-meta"));
  }
  if (result.error) item.append(text("p", result.error, "history-error"));
  for (const warning of result.warnings) item.append(text("p", `Warning: ${warning}`, "history-warning"));
  if (result.status === "complete" && result.files) {
    const links = text("div", "", "download-links");
    const formats = [["json", "JSON"], ["csv", "CSV"], ["m3u", "M3U8"]] as const;
    for (const [format, label] of formats) {
      const filename = result.files[format];
      const link = text("a", label);
      link.href = `/api/backups/${encodeURIComponent(manifest.id)}/files/${encodeURIComponent(filename)}`;
      link.download = filename;
      link.setAttribute("aria-label", `Download ${label} for ${result.title || "Untitled playlist"}`);
      links.append(link);
    }
    item.append(links);
  }
  return item;
}

function renderHistory(): void {
  ui.historyFeedback.hidden = false;
  ui.historyFeedback.textContent = historyError
    ? `${historyError} Use Refresh history to retry.${historyLoaded ? " Previously loaded results are shown below." : ""}`
    : historyLoading ? "Loading backup history…"
      : backups.length === 0 ? `No managed backups available. New exports appear here until their ${retentionDays()}-day expiry.`
        : "";
  if (!historyError && !historyLoading && backups.length > 0) ui.historyFeedback.hidden = true;
  const open = new Set(Array.from(ui.historyList.querySelectorAll<HTMLDetailsElement>("details[open]"))
    .map((detail) => detail.dataset.backupId));
  const fragment = document.createDocumentFragment();
  const ordered = [...backups].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  for (const manifest of ordered) {
    const entry = document.createElement("details");
    entry.className = "history-entry";
    entry.dataset.backupId = manifest.id;
    entry.open = open.has(manifest.id);
    const summary = document.createElement("summary");
    const date = text("time", timestamp(manifest.startedAt), "history-time");
    date.dateTime = manifest.startedAt;
    const badge = text("span", stateLabel(manifest.status), "badge");
    badge.dataset.state = manifest.status;
    const warnings = warningCount(manifest);
    summary.append(date, badge, text("span", `${totals(manifest)}${warnings ? ` · ${warnings} ${warnings === 1 ? "warning" : "warnings"}` : ""}`, "history-counts"));
    const expiresAt = new Date(Date.parse(manifest.startedAt) + retentionDays() * 86_400_000);
    const expiry = text("span", "Expires ", "history-expiry");
    if (Number.isNaN(expiresAt.getTime())) {
      expiry.textContent = "Expiry unavailable: review the recorded start time.";
    } else {
      const expiryTime = text("time", timestamp(expiresAt.toISOString()));
      expiryTime.dateTime = expiresAt.toISOString();
      expiry.append(expiryTime);
    }
    summary.append(expiry);
    const content = text("div", "", "history-content");
    content.append(text("p", `${manifest.provider === "youtube" ? "YouTube" : "Spotify"} · ${manifest.totals.playlists.toLocaleString()} playlists in this run`, "history-meta"));
    content.append(text("p", manifest.completedAt ? `Finished ${timestamp(manifest.completedAt)}` : "No completion time recorded", "history-meta"));
    content.append(text("p", `Backup ID: ${manifest.id}`, "history-meta"));
    content.append(text("p", manifest.coverage, "history-meta"));
    if (manifest.error) content.append(text("p", manifest.error, "history-error"));
    for (const warning of manifest.warnings) content.append(text("p", `Warning: ${warning}`, "history-warning"));
    if (manifest.playlists.length === 0) {
      content.append(text("p", "No playlist files were recorded in this run.", "history-meta"));
    } else {
      const results = text("ul", "", "result-list");
      for (const result of manifest.playlists) results.append(renderResult(manifest, result));
      content.append(results);
    }
    entry.append(summary, content);
    fragment.append(entry);
  }
  ui.historyList.replaceChildren(fragment);
  renderControls();
}

function platformLabel(providerId: Platform): string {
  return providerId === "youtube" ? "YouTube Music" : "Spotify";
}

function directionLabel(record: SyncRemovalRecord): string {
  return record.sourcePlatform
    ? `${platformLabel(record.sourcePlatform)} → ${platformLabel(record.platform)}`
    : `Mirrored to ${platformLabel(record.platform)}`;
}

function outcomeLabel(outcome: SyncRemovalRecord["outcome"]): string {
  return outcome === "success" ? "Removed" : "Failed";
}

function pairLabel(pair: SyncPair): string {
  return `${platformLabel(pair.left.provider)} ${pair.left.playlistId} ↔ ${platformLabel(pair.right.provider)} ${pair.right.playlistId}`;
}

function renderRemovals(): void {
  const available = sync !== null;
  ui.refreshRemovals.disabled = removalsLoading || syncBusy || !available;
  ui.refreshRemovals.textContent = removalsLoading ? "Refreshing…" : "Refresh Removal Records";
  ui.removalFeedback.dataset.error = String(Boolean(removalsError));
  ui.removalRows.replaceChildren();
  ui.removalTableWrap.hidden = true;
  if (!available) {
    ui.removalFeedback.textContent = "Removal audit records require a configured synchronization service.";
  } else if (removalsLoading && !removalsLoaded) {
    ui.removalFeedback.textContent = "Loading removal audit records…";
  } else if (removalsError) {
    ui.removalFeedback.textContent = `${removalsError} Use Refresh Removal Records to retry.${removalsLoaded ? " Previously loaded records are shown below." : ""}`;
  } else if (removals.length === 0) {
    ui.removalFeedback.textContent = removalsLoaded
      ? "No removals have been mirrored yet."
      : "Removal audit records have not been loaded yet.";
  } else {
    ui.removalFeedback.textContent = `${removals.length.toLocaleString()} recorded ${removals.length === 1 ? "removal" : "removals"}, newest first.`;
  }
  if (removals.length > 0) {
    ui.removalTableWrap.hidden = false;
    const fragment = document.createDocumentFragment();
    for (const record of removals) {
      const row = document.createElement("tr");
      const playlistCell = document.createElement("td");
      playlistCell.append(text("span", record.playlistId, "playlist-title"));
      playlistCell.append(text("span", `Pair: ${record.pairId}`, "playlist-owner"));
      const identity = document.createElement("td");
      identity.append(text("code", record.itemIdentity));
      const time = document.createElement("td");
      const stamp = text("time", timestamp(record.timestamp));
      stamp.dateTime = record.timestamp;
      time.append(stamp);
      const outcome = document.createElement("td");
      const badge = text("span", outcomeLabel(record.outcome), "badge");
      badge.dataset.state = record.outcome === "success" ? "complete" : "failed";
      outcome.append(badge);
      if (record.error) outcome.append(text("span", record.error, "history-error"));
      row.append(
        text("td", platformLabel(record.platform)),
        playlistCell,
        identity,
        text("td", directionLabel(record)),
        time,
        outcome,
      );
      fragment.append(row);
    }
    ui.removalRows.append(fragment);
  }
}

async function loadRemovals(): Promise<void> {
  if (removalsLoading || sync === null) {
    renderRemovals();
    return;
  }
  removalsLoading = true;
  removalsError = null;
  renderRemovals();
  try {
    const response = await request<{ removals: SyncRemovalRecord[] }>("/api/sync/removals");
    if (disposed) return;
    removals = response.removals;
    removalsLoaded = true;
  } catch (error) {
    if (!disposed) removalsError = message(error);
  } finally {
    removalsLoading = false;
    if (!disposed) renderRemovals();
  }
}

function renderSync(): void {
  const available = sync !== null;
  const pairs = sync?.pairs ?? [];
  ui.syncFooterState.textContent = available ? "Available" : "Not configured";
  ui.syncFeedback.textContent = syncError
    ? `${syncError} No remote changes were made.`
    : syncLoading ? "Loading pair state…"
      : available ? "Pairing is explicit. Ambiguous, unpaired or ignored playlists are never changed."
        : "Direct Spotify and YouTube Music synchronization is not configured in this release.";
  ui.syncFeedback.dataset.error = String(Boolean(syncError));
  const selected = ui.syncPairSelect.value;
  ui.syncPairSelect.replaceChildren();
  for (const pair of pairs) {
    const option = document.createElement("option");
    option.value = pair.id;
    option.textContent = pairLabel(pair);
    ui.syncPairSelect.append(option);
  }
  if (pairs.some((pair) => pair.id === selected)) ui.syncPairSelect.value = selected;
  ui.syncPairSelect.disabled = syncBusy || syncLoading || !available || pairs.length === 0;
  ui.syncNow.disabled = ui.syncPairSelect.disabled;
  ui.pairForm.querySelectorAll("input, select, button").forEach((control) => {
    (control as HTMLInputElement | HTMLSelectElement | HTMLButtonElement).disabled = syncBusy || syncLoading || !available;
  });
  ui.syncPairs.replaceChildren();
  for (const pair of pairs) {
    const row = text("p", pairLabel(pair), "sync-record");
    row.append(text("span", pair.enabled ? "Active" : "Inactive", "badge"));
    const remove = text("button", "Remove", "text-button") as HTMLButtonElement;
    remove.type = "button";
    remove.disabled = syncBusy || !available;
    remove.addEventListener("click", () => { void removePair(pair.id); });
    row.append(remove);
    ui.syncPairs.append(row);
  }
  if (pairs.length === 0) ui.syncPairs.append(text("p", "No pairs have been confirmed.", "sync-empty"));
  ui.syncIgnored.replaceChildren();
  for (const item of sync?.ignores ?? []) {
    const row = text("p", `${platformLabel(item.provider)} ${item.playlistId}`, "sync-record");
    row.append(text("span", "Ignored", "badge"));
    if (item.reason) row.append(text("span", item.reason, "playlist-owner"));
    const restore = text("button", "Unignore", "text-button") as HTMLButtonElement;
    restore.type = "button";
    restore.disabled = syncBusy || !available;
    restore.addEventListener("click", () => { void unignore(item); });
    row.append(restore);
    ui.syncIgnored.append(row);
  }
  if (!sync?.ignores.length) ui.syncIgnored.append(text("p", "No playlists are ignored.", "sync-empty"));
  ui.syncLogs.replaceChildren();
  for (const run of sync?.runs ?? []) {
    const row = text("p", `${timestamp(run.startedAt)} · ${run.status}`, "sync-record");
    if (run.message) row.append(text("span", run.message, "playlist-owner"));
    ui.syncLogs.append(row);
  }
  if (!sync?.runs.length) ui.syncLogs.append(text("p", "No sync runs have been recorded.", "sync-empty"));
  renderRemovals();
}

async function loadSync(): Promise<void> {
  if (syncLoading) return;
  syncLoading = true;
  syncError = null;
  renderSync();
  try {
    sync = await request<SyncState>("/api/sync");
    removals = sync.removals ?? [];
    removalsLoaded = true;
  } catch (error) {
    sync = null;
    removals = [];
    removalsLoaded = false;
    syncError = message(error);
  } finally {
    syncLoading = false;
    if (!disposed) renderSync();
  }
}

async function syncNow(): Promise<void> {
  if (ui.syncNow.disabled) return;
  const pairId = ui.syncPairSelect.value;
  if (!pairId) {
    notify("Select an explicit pair before synchronizing. Unpaired playlists are never changed.", "error");
    return;
  }
  syncBusy = true;
  renderSync();
  try {
    const response = await request<{ run: SyncRun }>("/api/sync/run", "POST", { pairId });
    notify(
      response.run.status === "complete"
        ? "Synchronization completed."
        : `Synchronization finished with status: ${response.run.status}.`,
      response.run.status === "complete" ? "success" : "info",
    );
    await loadSync();
  } catch (error) {
    notify(`Synchronization did not start. ${message(error)}`, "error");
  } finally {
    syncBusy = false;
    if (!disposed) renderSync();
  }
}

async function removePair(id: string): Promise<void> {
  syncBusy = true;
  renderSync();
  try { sync = await request<SyncState>(`/api/sync/pairs/${encodeURIComponent(id)}`, "DELETE"); }
  catch (error) { notify(`Could not remove the pair. ${message(error)}`, "error"); }
  finally { syncBusy = false; if (!disposed) renderSync(); }
}

async function unignore(ref: SyncRef): Promise<void> {
  syncBusy = true;
  renderSync();
  const path = `/api/sync/ignored/${ref.provider}/${encodeURIComponent(ref.accountId)}/${encodeURIComponent(ref.playlistId)}`;
  try { sync = await request<SyncState>(path, "DELETE"); }
  catch (error) { notify(`Could not restore the playlist. ${message(error)}`, "error"); }
  finally { syncBusy = false; if (!disposed) renderSync(); }
}

async function savePair(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  if (ui.pairForm.querySelector(":invalid")) return;
  const left: SyncRef = {
    provider: ui.pairLeftProvider.value as Platform,
    accountId: ui.pairLeftAccount.value.trim(),
    playlistId: ui.pairLeftPlaylist.value.trim(),
  };
  const right: SyncRef = {
    provider: ui.pairRightProvider.value as Platform,
    accountId: ui.pairRightAccount.value.trim(),
    playlistId: ui.pairRightPlaylist.value.trim(),
  };
  if (left.provider === right.provider) {
    notify("A pair needs one Spotify playlist and one YouTube Music playlist.", "error");
    return;
  }
  syncBusy = true;
  renderSync();
  try {
    sync = await request<SyncState>("/api/sync/pairs", "POST", { left, right });
    removals = sync.removals ?? removals;
    ui.pairForm.reset();
    notify("Pair saved. Review it before running synchronization.", "success");
  } catch (error) { notify(`Could not save the pair. ${message(error)}`, "error"); }
  finally { syncBusy = false; if (!disposed) renderSync(); }
}

async function loadInventory(): Promise<void> {
  if (inventoryLoading || !status?.connected || running() || !jobKnown) return;
  inventoryLoading = true;
  inventoryError = null;
  renderInventory();
  try {
    const response = await request<{ playlists: Playlist[]; coverage: string }>("/api/playlists");
    if (disposed) return;
    playlists = response.playlists;
    inventoryLoaded = true;
    ui.coverage.textContent = response.coverage;
  } catch (error) {
    if (!disposed) inventoryError = message(error);
  } finally {
    inventoryLoading = false;
    if (!disposed) renderInventory();
  }
}

async function loadHistory(): Promise<void> {
  if (historyLoading) return;
  historyLoading = true;
  historyError = null;
  renderHistory();
  try {
    const response = await request<{ backups: BackupManifest[] }>("/api/backups");
    if (disposed) return;
    backups = response.backups;
    historyLoaded = true;
  } catch (error) {
    if (!disposed) historyError = message(error);
  } finally {
    historyLoading = false;
    if (!disposed) renderHistory();
  }
}

async function recheckRetention(): Promise<void> {
  if (ui.recheckRetention.disabled) return;
  retentionLoading = true;
  stopRetentionPolling();
  renderControls();
  try {
    await request<{ retention: StatusResponse["retention"] }>("/api/retention/check", "POST");
    const response = await requestStatus();
    if (disposed) return;
    status = response;
    retentionCheckError = null;
    retentionFailures = 0;
    if (!status.connected) {
      clearInventory();
      renderInventory();
    }
    renderStatus();
    await loadHistory();
  } catch (error) {
    if (!disposed) retentionCheckError = `Could not recheck cleanup. ${message(error)}`;
  } finally {
    retentionLoading = false;
    if (!disposed) {
      renderRetention();
      renderControls();
      scheduleRetentionPoll();
    }
  }
}

function stopRetentionPolling(): void {
  if (retentionTimer !== null) window.clearTimeout(retentionTimer);
  retentionTimer = null;
}

function scheduleRetentionPoll(delay = retentionPollInterval): void {
  stopRetentionPolling();
  if (disposed || document.hidden || (!status && !retention) || retentionFailures >= maxRetentionFailures) return;
  retentionTimer = window.setTimeout(() => {
    retentionTimer = null;
    if (disposed || document.hidden) return;
    if (busy || booting || retentionLoading) {
      scheduleRetentionPoll();
      return;
    }
    void refreshRetentionStatus();
  }, delay);
}

function refreshRetentionStatus(forceFresh = false): Promise<void> {
  if (retentionRefreshPromise) {
    return forceFresh
      ? retentionRefreshPromise.then(() => refreshRetentionStatus())
      : retentionRefreshPromise;
  }
  if (disposed) return Promise.resolve();
  retentionPolling = true;
  stopRetentionPolling();
  renderControls();
  retentionRefreshPromise = (async () => {
    try {
      const response = await requestStatus();
      if (disposed) return;
      status = response;
      retention = response.retention;
      if (!status.connected) {
        clearInventory();
        renderInventory();
      }
      renderStatus();
      retentionCheckError = null;
      retentionFailures = 0;
    } catch (error) {
      if (disposed) return;
      retentionFailures += 1;
      retentionCheckError = retentionFailures >= maxRetentionFailures
        ? `Cleanup status updates paused after ${maxRetentionFailures} unsuccessful checks. ${message(error)} Use Recheck connection to resume.`
        : `Cleanup status could not be updated; retrying in one minute (${retentionFailures}/${maxRetentionFailures}). ${message(error)}`;
    } finally {
      retentionPolling = false;
      retentionRefreshPromise = null;
      if (!disposed) {
        renderRetention();
        renderControls();
        scheduleRetentionPoll();
      }
    }
  })();
  return retentionRefreshPromise;
}

function stopPolling(): void {
  if (pollTimer !== null) window.clearTimeout(pollTimer);
  pollTimer = null;
}

function schedulePoll(delay = 1500): void {
  stopPolling();
  if (disposed || document.hidden || !running() || pollFailures >= maxPollFailures) return;
  pollTimer = window.setTimeout(() => { void pollJob(); }, delay);
}

async function pollJob(): Promise<void> {
  if (disposed || polling || !job || !running() || document.hidden) return;
  polling = true;
  const id = job.id;
  try {
    const response = await request<{ job: BackupJob }>(`/api/jobs/${encodeURIComponent(id)}`);
    if (disposed || job.id !== id) return;
    job = response.job;
    jobError = null;
    pollFailures = 0;
    renderJob();
    if (!running()) {
      void loadHistory();
      if (!inventoryLoaded) renderInventory();
    }
  } catch (error) {
    if (disposed) return;
    pollFailures += 1;
    jobError = pollFailures >= maxPollFailures
      ? `Progress updates paused after ${maxPollFailures} unsuccessful attempts. The backup may still be running. ${message(error)} Use Check backup status to resume.`
      : `Progress update unavailable; retrying (${pollFailures}/${maxPollFailures}). The backup may still be running. ${message(error)}`;
    renderJob();
  } finally {
    polling = false;
    if (!disposed) {
      renderControls();
      schedulePoll(pollFailures ? Math.min(12_000, 1500 * 2 ** pollFailures) : 1500);
    }
  }
}

async function loadCurrentJob(): Promise<void> {
  if (jobLoading || polling) return;
  jobLoading = true;
  stopPolling();
  renderJob();
  try {
    const response = await request<{ job: BackupJob | null }>("/api/jobs/current");
    if (disposed) return;
    const wasRunning = running();
    job = response.job;
    jobKnown = true;
    jobError = null;
    pollFailures = 0;
    if (wasRunning && !running()) void loadHistory();
  } catch (error) {
    if (!disposed) jobError = `Cannot confirm the current backup state. ${message(error)} Use Check backup status to retry.`;
  } finally {
    jobLoading = false;
    if (!disposed) {
      renderJob();
      if (!inventoryLoaded) renderInventory();
      schedulePoll();
    }
  }
}

async function boot(loadPlaylists = true): Promise<void> {
  if (booting || disposed) return;
  booting = true;
  renderControls();
  try {
    status = await requestStatus();
    if (disposed) return;
    retentionCheckError = null;
    retentionFailures = 0;
    if (!status.connected) clearInventory();
    renderStatus();
    renderInventory();
    await loadCurrentJob();
    if (disposed) return;
    await Promise.all([loadHistory(), loadSync(), loadPlaylists && jobKnown && !running() ? loadInventory() : Promise.resolve()]);
    if (disposed) return;
    renderInventory();
    ui.retryStatus.hidden = true;
  } catch {
    if (disposed) return;
    renderStatus();
    renderInventory();
    ui.historyFeedback.textContent = "Backup history was not refreshed because the connection check failed.";
    ui.jobTitle.textContent = "Workspace check failed";
    ui.jobDescription.textContent = "Resolve the connection error above, then use Recheck connection to recover your workspace.";
    ui.jobBadge.textContent = "Unavailable";
  } finally {
    booting = false;
    if (!disposed) {
      renderControls();
      scheduleRetentionPoll();
    }
  }
}

async function connect(): Promise<void> {
  if (ui.connect.disabled) return;
  busy = "connect";
  renderControls();
  notify("Opening Google authorization. This tool requests read-only access.");
  try {
    const response = await request<{ url: string }>("/api/auth/connect", "POST");
    if (!disposed) window.location.assign(response.url);
  } catch (error) {
    if (!disposed) {
      busy = null;
      notify(`Could not start authorization. ${message(error)}`, "error");
      renderControls();
    }
  }
}

function clearInventory(): void {
  playlists = [];
  inventoryLoaded = false;
  inventoryError = null;
  ui.search.value = "";
}

async function disconnect(): Promise<void> {
  if (ui.disconnect.disabled) return;
  busy = "disconnect";
  renderControls();
  try {
    await request<{ ok: true }>("/api/auth/disconnect", "POST");
    if (disposed) return;
    if (status) status.connected = false;
    clearInventory();
    notify("YouTube disconnected. Your local backups remain until their scheduled expiry.", "success");
    renderStatus();
    renderInventory();
    renderJob();
  } catch (error) {
    if (disposed) return;
    const disconnectError = message(error);
    try {
      status = await requestStatus();
      if (disposed) return;
      if (!status.connected) clearInventory();
      notify(status.connected
        ? `Could not disconnect YouTube. ${disconnectError}`
        : `YouTube is disconnected locally, but Google revocation could not be confirmed. ${disconnectError} Your local backups remain until their scheduled expiry.`, "error");
    } catch (statusError) {
      if (disposed) return;
      status = null;
      clearInventory();
      notify(`Disconnect could not be confirmed. ${disconnectError} The connection recheck also failed: ${message(statusError)}`, "error", true);
    }
    renderStatus();
    renderInventory();
    renderJob();
  } finally {
    busy = null;
    if (!disposed) renderControls();
  }
}

async function startBackup(): Promise<void> {
  if (ui.backup.disabled) return;
  busy = "backup";
  ui.notice.hidden = true;
  renderControls();
  try {
    const response = await request<{ job: BackupJob }>("/api/backups", "POST");
    if (disposed) return;
    job = response.job;
    jobKnown = true;
    jobError = null;
    pollFailures = 0;
    renderJob();
    if (window.matchMedia("(max-width: 800px)").matches) {
      ui.jobTitle.scrollIntoView({ block: "center", behavior: "instant" });
    }
    if (running()) schedulePoll();
    else void loadHistory();
  } catch (error) {
    if (disposed) return;
    jobKnown = false;
    notify(`Could not confirm that the backup started. ${message(error)} Checking for an active run before allowing another attempt.`, "error");
    await Promise.all([loadCurrentJob(), refreshRetentionStatus(true)]);
  } finally {
    busy = null;
    if (!disposed) renderControls();
  }
}

ui.connect.addEventListener("click", () => { void connect(); });
ui.disconnect.addEventListener("click", () => { void disconnect(); });
ui.backup.addEventListener("click", () => { void startBackup(); });
ui.refreshLibrary.addEventListener("click", () => { void loadInventory(); });
ui.refreshHistory.addEventListener("click", () => { void loadHistory(); });
ui.recheckRetention.addEventListener("click", () => { void recheckRetention(); });
ui.search.addEventListener("input", renderInventory);
ui.retryJob.addEventListener("click", () => { void loadCurrentJob(); });
ui.syncNow.addEventListener("click", () => { void syncNow(); });
ui.pairForm.addEventListener("submit", (event) => { void savePair(event); });
ui.refreshRemovals.addEventListener("click", () => { void loadRemovals(); });
ui.retryStatus.addEventListener("click", () => { void boot(false); });
ui.recheckConnection.addEventListener("click", () => { void boot(false); });
ui.dismissNotice.addEventListener("click", () => { ui.notice.hidden = true; });
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    stopPolling();
    stopRetentionPolling();
  } else {
    schedulePoll(0);
    scheduleRetentionPoll(0);
  }
});
window.addEventListener("pagehide", () => {
  disposed = true;
  stopPolling();
  stopRetentionPolling();
  lifetime.abort();
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted) window.location.reload();
});

const callbackUrl = new URL(window.location.href);
const authError = callbackUrl.searchParams.get("authError");
if (authError) notify(`YouTube authorization was not completed. ${authError}`, "error");
else if (callbackUrl.searchParams.get("connected") === "1") notify("YouTube authorization completed. Checking your connection…", "success");
if (callbackUrl.searchParams.has("authError") || callbackUrl.searchParams.has("connected")) {
  callbackUrl.searchParams.delete("authError");
  callbackUrl.searchParams.delete("connected");
  window.history.replaceState(null, "", callbackUrl);
}
void boot();
