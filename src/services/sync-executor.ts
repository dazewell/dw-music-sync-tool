import { AppError } from "../core/errors.js";
import type { Playlist, PlaylistMutation, PlaylistProvider, ProviderId } from "../core/models.js";
import { applySyncPlan, planBidirectionalSync, type SyncPairRef } from "../core/sync.js";
import type { SyncRun, SyncStateStore } from "../core/sync-state.js";

export type MutablePlaylistProvider = PlaylistProvider & PlaylistMutation;

/**
 * The direct API writers actually available to the running application. A
 * `null` entry means that platform is not authenticated for mutation right
 * now (for example, demo mode for YouTube, or Spotify without a configured
 * refresh token) - never a fake/no-op writer.
 */
export interface SyncExecutorProviders {
  youtube: MutablePlaylistProvider | null;
  spotify: MutablePlaylistProvider | null;
}

function requireProvider(providers: SyncExecutorProviders, id: ProviderId): MutablePlaylistProvider {
  const provider = providers[id];
  if (provider) return provider;
  if (id === "spotify") {
    throw new AppError(
      "SPOTIFY_NOT_CONFIGURED",
      "Direct Spotify synchronization is not configured. Set SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET and SPOTIFY_REFRESH_TOKEN, then retry. No remote changes were made.",
      501,
    );
  }
  throw new AppError(
    "YOUTUBE_SYNC_NOT_AVAILABLE",
    "Direct YouTube synchronization is not available in this mode. Connect a real Google account (not demo mode), then retry. No remote changes were made.",
    501,
  );
}

/**
 * Lists the real playlists currently visible to an authenticated provider, so
 * pairing/ignoring can be driven by picking from real discovery instead of
 * hand-typed account/playlist IDs. Fails closed the same way a mutation would
 * if that platform is not actually configured right now.
 */
export async function discoverPlaylists(providers: SyncExecutorProviders, id: ProviderId): Promise<Playlist[]> {
  const provider = requireProvider(providers, id);
  return provider.listPlaylists();
}

async function observe(provider: MutablePlaylistProvider, ref: SyncPairRef) {
  const playlists = await provider.listPlaylists();
  const playlist = playlists.find((item) => item.id === ref.playlistId);
  if (!playlist) {
    throw new AppError(
      "SYNC_PLAYLIST_NOT_FOUND",
      `The paired ${ref.provider} playlist was not found in a fresh discovery; it may have been deleted or made inaccessible.`,
      404,
    );
  }
  // A playlist ID alone is not sufficient: after switching the configured account, a fresh
  // discovery can still return a followed/collaborative playlist that happens to share the same
  // ID under a different owner. Verify the discovered owner still matches the account the pair
  // was created against before reading or mutating anything.
  const discoveredAccountId = playlist.owner.trim() || "default";
  if (discoveredAccountId !== ref.accountId) {
    throw new AppError(
      "SYNC_PLAYLIST_ACCOUNT_MISMATCH",
      `The paired ${ref.provider} playlist is no longer owned by the account this pair was created for; it may belong to a different or switched account.`,
      409,
    );
  }
  // Re-read fresh content (not the just-listed summary) so a stale plan is never applied.
  return provider.getPlaylist(playlist);
}

/**
 * Executes one explicitly selected pair: re-observes both sides, plans a
 * bidirectional mirror against the last verified baseline, applies it through
 * the real authenticated provider on the changed side, verifies the result and
 * records a new baseline plus a durable per-removal audit trail. Every run is
 * persisted, including failures and review-required outcomes, so nothing is
 * silently dropped.
 */
export async function executeSyncRun(
  store: SyncStateStore,
  providers: SyncExecutorProviders,
  pairId: string,
): Promise<SyncRun> {
  const initial = await store.read();
  const pair = initial.pairs.find((item) => item.id === pairId);
  if (!pair) throw new AppError("SYNC_PAIR_NOT_FOUND", "That playlist pair does not exist.", 404);
  if (!pair.enabled) throw new AppError("SYNC_PAIR_DISABLED", "That playlist pair is disabled.", 409);

  const run = await store.startRun(pair.id);
  try {
    const leftProvider = requireProvider(providers, pair.left.provider);
    const rightProvider = requireProvider(providers, pair.right.provider);
    const [left, right] = await Promise.all([observe(leftProvider, pair.left), observe(rightProvider, pair.right)]);
    const baseline = initial.baselines[pair.id] ?? null;
    const plan = planBidirectionalSync(left, right, baseline);

    if (plan.status === "unchanged") {
      const finished = await store.finishRun(run.id, "complete", "Both playlists already match the last verified sync; no changes were needed.");
      return finished.runs.find((item) => item.id === run.id)!;
    }
    if (plan.status !== "ready") {
      const finished = await store.finishRun(run.id, "review-required", plan.reason);
      return finished.runs.find((item) => item.id === run.id)!;
    }

    const targetProvider = plan.direction === "left-to-right" ? rightProvider : leftProvider;
    const baselineResult = await applySyncPlan(plan, targetProvider, { runId: run.id, pairId: pair.id, sink: store });
    await store.update((state) => { state.baselines[pair.id] = baselineResult; });
    const finished = await store.finishRun(run.id, "complete", null);
    return finished.runs.find((item) => item.id === run.id)!;
  } catch (error) {
    const message = error instanceof AppError ? error.message : "The synchronization run failed unexpectedly.";
    await store.finishRun(run.id, "failed", message);
    throw error;
  }
}
