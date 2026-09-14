import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Playlist, PlaylistContents, PlaylistEntry, PlaylistMutation, PlaylistProvider, ProviderId } from "../src/core/models.js";
import { fingerprintPlaylist } from "../src/core/sync.js";
import { SyncStateStore } from "../src/core/sync-state.js";
import { executeSyncRun, type SyncExecutorProviders } from "../src/services/sync-executor.js";

function playlist(id: string, provider: ProviderId, title = id): Playlist {
  return { provider, id, title, description: "", url: "", owner: "", itemCount: null, visibility: "unknown" };
}

function entry(id: string, mediaId: string | null, providerData: Record<string, unknown> = {}): PlaylistEntry {
  return {
    id, mediaId, position: 0, title: "Song", artist: null, album: null,
    url: null, availability: mediaId ? "available" : "unavailable", addedAt: null, providerData,
  };
}

class FakeProvider implements PlaylistProvider, PlaylistMutation {
  replaceCalls: Array<{ playlist: Playlist; entries: readonly PlaylistEntry[]; expectedSnapshotId?: string }> = [];
  constructor(
    readonly id: ProviderId,
    private readonly playlists: Playlist[],
    private contents: Map<string, PlaylistEntry[]>,
    private readonly onReplace?: (playlistId: string, entries: readonly PlaylistEntry[]) => void,
  ) {}
  readonly coverage = "fake";
  async listPlaylists(): Promise<Playlist[]> {
    return this.playlists;
  }
  async getPlaylist(playlist: Playlist): Promise<PlaylistContents> {
    return { playlist, entries: this.contents.get(playlist.id) ?? [], warnings: [] };
  }
  async replacePlaylist(playlist: Playlist, entries: readonly PlaylistEntry[], expectedSnapshotId?: string): Promise<void> {
    this.replaceCalls.push({ playlist, entries, expectedSnapshotId });
    this.onReplace?.(playlist.id, entries);
    this.contents.set(playlist.id, entries.map((item) => ({ ...item })));
  }
}

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function makeStore(): Promise<SyncStateStore> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "music-sync-executor-"));
  directories.push(directory);
  return new SyncStateStore(path.join(directory, "sync-state.json"));
}

const now = new Date().toISOString();

describe("executeSyncRun", () => {
  it("fails closed when the paired provider has no configured authenticated writer", async () => {
    const store = await makeStore();
    await store.pair({
      id: "pair-1",
      left: { provider: "youtube", accountId: "default", playlistId: "yt-1" },
      right: { provider: "spotify", accountId: "default", playlistId: "sp-1" },
      enabled: true, createdAt: now, updatedAt: now,
    });
    const providers: SyncExecutorProviders = { youtube: new FakeProvider("youtube", [], new Map()), spotify: null };
    await expect(executeSyncRun(store, providers, "pair-1")).rejects.toMatchObject({ code: "SPOTIFY_NOT_CONFIGURED" });
    const state = await store.read();
    expect(state.runs).toHaveLength(1);
    expect(state.runs[0]?.status).toBe("failed");
    expect(state.runs[0]?.message).toMatch(/SPOTIFY_CLIENT_ID/);
  });

  it("rejects an unknown pair without starting a run", async () => {
    const store = await makeStore();
    await expect(executeSyncRun(store, { youtube: null, spotify: null }, "missing")).rejects.toMatchObject({ code: "SYNC_PAIR_NOT_FOUND" });
    expect((await store.read()).runs).toHaveLength(0);
  });

  it("fails closed when the paired playlist is missing from a fresh discovery", async () => {
    const store = await makeStore();
    await store.pair({
      id: "pair-1",
      left: { provider: "youtube", accountId: "default", playlistId: "yt-1" },
      right: { provider: "spotify", accountId: "default", playlistId: "sp-1" },
      enabled: true, createdAt: now, updatedAt: now,
    });
    const providers: SyncExecutorProviders = {
      youtube: new FakeProvider("youtube", [], new Map()),
      spotify: new FakeProvider("spotify", [playlist("sp-1", "spotify")], new Map()),
    };
    await expect(executeSyncRun(store, providers, "pair-1")).rejects.toMatchObject({ code: "SYNC_PLAYLIST_NOT_FOUND" });
    const state = await store.read();
    expect(state.runs[0]?.status).toBe("failed");
  });

  it("fails closed when a fresh discovery finds the paired playlist ID under a different account", async () => {
    const store = await makeStore();
    await store.pair({
      id: "pair-1",
      left: { provider: "youtube", accountId: "old-account", playlistId: "yt-1" },
      right: { provider: "spotify", accountId: "default", playlistId: "sp-1" },
      enabled: true, createdAt: now, updatedAt: now,
    });
    const providers: SyncExecutorProviders = {
      // Same playlist ID as the pair, but now discovered under a different owner - for example
      // after the configured account changed, or the ID collides with a followed/collaborative
      // playlist the current account can see but does not own.
      youtube: new FakeProvider("youtube", [{ ...playlist("yt-1", "youtube"), owner: "new-account" }], new Map()),
      spotify: new FakeProvider("spotify", [playlist("sp-1", "spotify")], new Map()),
    };
    await expect(executeSyncRun(store, providers, "pair-1")).rejects.toMatchObject({ code: "SYNC_PLAYLIST_ACCOUNT_MISMATCH" });
    const state = await store.read();
    expect(state.runs[0]?.status).toBe("failed");
  });

  it("records an uninitialized pair as review-required without mutating either side", async () => {
    const store = await makeStore();
    await store.pair({
      id: "pair-1",
      left: { provider: "youtube", accountId: "default", playlistId: "yt-1" },
      right: { provider: "spotify", accountId: "default", playlistId: "sp-1" },
      enabled: true, createdAt: now, updatedAt: now,
    });
    const youtube = new FakeProvider("youtube", [playlist("yt-1", "youtube")], new Map([["yt-1", [entry("a", "a")]]]));
    const spotify = new FakeProvider("spotify", [playlist("sp-1", "spotify")], new Map([["sp-1", [entry("a", "a")]]]));
    const run = await executeSyncRun(store, { youtube, spotify }, "pair-1");
    expect(run.status).toBe("review-required");
    expect(youtube.replaceCalls).toHaveLength(0);
    expect(spotify.replaceCalls).toHaveLength(0);
    expect((await store.read()).baselines["pair-1"]).toBeUndefined();
  });

  // Pairs are always cross-provider (same-provider pairing is rejected by
  // SyncStateStore.pair). Cross-provider entries have no verified target-native
  // translation yet (see README "The path to Spotify / YouTube sync"), so
  // planBidirectionalSync always returns "review-required" for a real pair
  // rather than writing untranslated source-native identifiers to the other
  // platform. This is the safe outcome the reviewer suggested explicitly
  // ("...or return review-required instead of issuing a remote write"), so a
  // run can never reach a destructive replacePlaylist call today, whatever the
  // diverged baseline looks like.
  it("requires review instead of mirroring a cross-provider pair, even with a diverged baseline, and never mutates either side", async () => {
    const store = await makeStore();
    await store.pair({
      id: "pair-1",
      left: { provider: "youtube", accountId: "default", playlistId: "yt-1" },
      right: { provider: "spotify", accountId: "default", playlistId: "sp-1" },
      enabled: true, createdAt: now, updatedAt: now,
    });
    const oldLeft = [entry("old-a", "a"), entry("old-b", "b")];
    const newLeft = [entry("new-a", "a")];
    const right = [entry("r-a", "a"), entry("r-b", "b")];
    await store.update((state) => {
      state.baselines["pair-1"] = {
        sourceFingerprint: fingerprintPlaylist("youtube", oldLeft),
        targetFingerprint: fingerprintPlaylist("spotify", right),
      };
    });
    const youtube = new FakeProvider("youtube", [playlist("yt-1", "youtube")], new Map([["yt-1", newLeft]]));
    const spotify = new FakeProvider("spotify", [playlist("sp-1", "spotify")], new Map([["sp-1", right]]));
    const run = await executeSyncRun(store, { youtube, spotify }, "pair-1");
    expect(run.status).toBe("review-required");
    expect(run.removals).toEqual([]);
    expect(youtube.replaceCalls).toHaveLength(0);
    expect(spotify.replaceCalls).toHaveLength(0);
    const state = await store.read();
    expect(state.baselines["pair-1"]).toEqual({
      sourceFingerprint: fingerprintPlaylist("youtube", oldLeft),
      targetFingerprint: fingerprintPlaylist("spotify", right),
    });
  });
});

// Destination-mutation failure and its per-removal "unknown" audit outcome are
// exercised directly against applySyncPlan in tests/sync.test.ts (a same-provider
// plan reaching "ready"), since no currently-creatable pair can reach that path
// through executeSyncRun (see the comment above).
