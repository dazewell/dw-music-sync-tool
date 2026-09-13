import { createHash } from "node:crypto";
import type { Playlist, PlaylistEntry, ProviderId } from "./models.js";

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
