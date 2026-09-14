import { createHash } from "node:crypto";
import { AppError } from "./errors.js";
import type { Playlist, PlaylistContents, PlaylistEntry, PlaylistProvider, ProviderId, PlaylistMutation } from "./models.js";

export function normalizePlaylistName(name: string): string {
  return name.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}

export interface PlaylistPairCandidate {
  normalizedName: string;
  source: Playlist;
  target: Playlist;
}

export interface PlaylistPairAmbiguity {
  normalizedName: string;
  sources: Playlist[];
  targets: Playlist[];
}

export interface PlaylistPairProposal {
  candidates: PlaylistPairCandidate[];
  ambiguities: PlaylistPairAmbiguity[];
}

/** Names propose pairs; they never establish track equivalence or authorize writes. */
export function proposePlaylistPairs(
  sources: readonly Playlist[],
  targets: readonly Playlist[],
): PlaylistPairProposal {
  const group = (playlists: readonly Playlist[]) => {
    const groups = new Map<string, Playlist[]>();
    for (const playlist of playlists) {
      const name = normalizePlaylistName(playlist.title);
      if (!name) continue;
      const items = groups.get(name) ?? [];
      items.push(playlist);
      groups.set(name, items);
    }
    return groups;
  };
  const sourceGroups = group(sources);
  const targetGroups = group(targets);
  const proposal: PlaylistPairProposal = { candidates: [], ambiguities: [] };
  for (const [normalizedName, sourceGroup] of sourceGroups) {
    const targetGroup = targetGroups.get(normalizedName);
    if (!targetGroup) continue;
    const source = sourceGroup[0]!;
    const target = targetGroup[0]!;
    if (sourceGroup.length === 1 && targetGroup.length === 1) {
      if (source.provider !== target.provider) {
        proposal.candidates.push({ normalizedName, source, target });
      }
    } else if (sourceGroup.some(left => targetGroup.some(right => left.provider !== right.provider))) {
      proposal.ambiguities.push({ normalizedName, sources: [...sourceGroup], targets: [...targetGroup] });
    }
  }
  return proposal;
}

/**
 * Provider namespaces prevent accidental cross-service ID equivalence. Array
 * order and duplicates are meaningful; display metadata and timestamps are not.
 */
export function fingerprintPlaylist(provider: ProviderId, entries: readonly PlaylistEntry[]): string {
  const identities = entries.map(entry => [
    entry.mediaId === null ? "unavailable-entry" : "media",
    entry.mediaId ?? entry.id,
  ]);
  return createHash("sha256").update(JSON.stringify([1, provider, identities])).digest("hex");
}

export type SyncComparison = "unchanged" | "source-changed" | "target-changed" | "conflict" | "uninitialized";

export interface SyncBaseline {
  sourceFingerprint: string;
  targetFingerprint: string;
}

export interface SyncPairRef {
  provider: ProviderId;
  accountId: string;
  playlistId: string;
}

export interface SyncPair {
  id: string;
  left: SyncPairRef;
  right: SyncPairRef;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SyncIgnore {
  provider: ProviderId;
  accountId: string;
  playlistId: string;
  reason: string;
  createdAt: string;
}

export type SyncPlanStatus = "ready" | "unchanged" | "review-required" | "unsupported";

export interface SyncPlan {
  status: SyncPlanStatus;
  direction: "left-to-right" | "right-to-left" | "none";
  source: PlaylistContents | null;
  target: PlaylistContents | null;
  entries: PlaylistEntry[];
  additions: number;
  removals: number;
  reason: string | null;
}

export type SyncRemovalOutcome = "success" | "failed";

export interface SyncRemovalAudit {
  pairId: string;
  platform: ProviderId;
  playlistId: string;
  itemIdentity: string;
  direction: "left-to-right" | "right-to-left";
  timestamp: string;
  outcome: SyncRemovalOutcome;
  error: string | null;
}

export interface SyncRemovalAuditSink {
  recordRemovalAudits(runId: string, audits: readonly SyncRemovalAudit[]): Promise<void>;
}

export function playlistEntryIdentity(entry: PlaylistEntry): string | null {
  if (entry.mediaId !== null) return `media:${entry.mediaId}`;
  const data = entry.providerData;
  const isrc = typeof data.isrc === "string" ? data.isrc.trim().toUpperCase() : "";
  if (isrc) return `isrc:${isrc}`;
  if (!entry.title.trim() || !entry.artist?.trim()) return null;
  return `recording:${entry.artist.trim().normalize("NFKC").toLowerCase()}\u0000${entry.title.trim().normalize("NFKC").toLowerCase()}`;
}

function mapUnambiguous(entries: readonly PlaylistEntry[]): Map<string, PlaylistEntry> | null {
  const result = new Map<string, PlaylistEntry>();
  for (const entry of entries) {
    const key = playlistEntryIdentity(entry);
    if (key === null || result.has(key)) return null;
    result.set(key, entry);
  }
  return result;
}

/**
 * Creates one side of a bidirectional mirror. It never guesses a pair and
 * refuses duplicate/ambiguous recording identities rather than deleting data.
 */
export function planBidirectionalSync(
  left: PlaylistContents,
  right: PlaylistContents,
  baseline: SyncBaseline | null | undefined,
): SyncPlan {
  const comparison = compareFingerprints(
    fingerprintPlaylist(left.playlist.provider, left.entries),
    fingerprintPlaylist(right.playlist.provider, right.entries),
    baseline,
  );
  if (comparison === "unchanged") {
    return { status: "unchanged", direction: "none", source: null, target: null, entries: [], additions: 0, removals: 0, reason: null };
  }
  if (comparison === "uninitialized" || comparison === "conflict") {
    return {
      status: "review-required", direction: "none", source: null, target: null, entries: [],
      additions: 0, removals: 0,
      reason: comparison === "uninitialized" ? "An acknowledged common baseline is required." : "Both playlists changed since the last verified sync.",
    };
  }

  const source = comparison === "source-changed" ? left : right;
  const target = comparison === "source-changed" ? right : left;
  const sourceMap = mapUnambiguous(source.entries);
  const targetMap = mapUnambiguous(target.entries);
  if (!sourceMap || !targetMap) {
    return {
      status: "review-required", direction: "none", source: null, target: null, entries: [],
      additions: 0, removals: 0,
      reason: "Duplicate or incomplete recording identities require explicit matching before mirroring.",
    };
  }

  const entries = source.entries.map((entry) => ({ ...entry, position: 0 }));
  const sourceKeys = new Set(sourceMap.keys());
  const targetKeys = new Set(targetMap.keys());
  return {
    status: "ready",
    direction: comparison === "source-changed" ? "left-to-right" : "right-to-left",
    source, target, entries: entries.map((entry, position) => ({ ...entry, position })),
    additions: [...sourceKeys].filter(key => !targetKeys.has(key)).length,
    removals: [...targetKeys].filter(key => !sourceKeys.has(key)).length,
    reason: null,
  };
}

export async function applySyncPlan(
  plan: SyncPlan,
  targetProvider: PlaylistProvider & PlaylistMutation,
  audit?: { runId: string; pairId: string; sink: SyncRemovalAuditSink },
): Promise<SyncBaseline> {
  if (plan.status !== "ready" || !plan.source || !plan.target) {
    throw new AppError("SYNC_PLAN_NOT_READY", plan.reason ?? "The sync plan is not ready for execution.", 409);
  }
  if (plan.direction === "none") {
    throw new AppError("SYNC_PLAN_NOT_READY", "A ready sync plan must have an explicit direction.", 409);
  }
  const direction = plan.direction;
  const plannedRemovals = plan.target.entries
    .filter(entry => !plan.entries.some(candidate => playlistEntryIdentity(candidate) === playlistEntryIdentity(entry)))
    .map(entry => playlistEntryIdentity(entry))
    .filter((value): value is string => value !== null);
  const recordAudits = (outcome: SyncRemovalOutcome, error: string | null) => {
    if (!audit || plannedRemovals.length === 0) return Promise.resolve();
    const timestamp = new Date().toISOString();
    return audit.sink.recordRemovalAudits(audit.runId, plannedRemovals.map(itemIdentity => ({
      pairId: audit.pairId,
      platform: plan.target!.playlist.provider,
      playlistId: plan.target!.playlist.id,
      itemIdentity,
      direction,
      timestamp,
      outcome,
      error,
    })));
  };
  try {
    if (plan.target.playlist.snapshotId === undefined) {
      await targetProvider.replacePlaylist(plan.target.playlist, plan.entries);
    } else {
      await targetProvider.replacePlaylist(plan.target.playlist, plan.entries, plan.target.playlist.snapshotId);
    }
    const verified = await targetProvider.getPlaylist(plan.target.playlist);
    if (verified.entries.length !== plan.entries.length
      || verified.entries.some((entry, index) => playlistEntryIdentity(entry) !== playlistEntryIdentity(plan.entries[index]!))) {
      throw new AppError("SYNC_VERIFY_FAILED", "The destination did not match the planned ordered result; no new baseline was recorded.", 502);
    }
    await recordAudits("success", null);
    return {
      sourceFingerprint: fingerprintPlaylist(plan.source.playlist.provider, plan.source.entries),
      targetFingerprint: fingerprintPlaylist(verified.playlist.provider, verified.entries),
    };
  } catch (error) {
    const message = error instanceof AppError ? error.message : "The destination mutation failed.";
    await recordAudits("failed", message);
    throw error;
  }
}

/** A common baseline stores both platform hashes from the same acknowledged sync. */
export function compareFingerprints(
  sourceFingerprint: string,
  targetFingerprint: string,
  baseline: SyncBaseline | null | undefined,
): SyncComparison {
  if (!baseline) return "uninitialized";
  const sourceChanged = sourceFingerprint !== baseline.sourceFingerprint;
  const targetChanged = targetFingerprint !== baseline.targetFingerprint;
  if (sourceChanged && targetChanged) return "conflict";
  if (sourceChanged) return "source-changed";
  if (targetChanged) return "target-changed";
  return "unchanged";
}
