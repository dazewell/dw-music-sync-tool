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
      left: { provider: "youtube", accountId: "acct", playlistId: "yt-1" },
      right: { provider: "spotify", accountId: "acct", playlistId: "sp-1" },
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
      left: { provider: "youtube", accountId: "acct", playlistId: "yt-1" },
      right: { provider: "spotify", accountId: "acct", playlistId: "sp-1" },
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

  it("records an uninitialized pair as review-required without mutating either side", async () => {
    const store = await makeStore();
    await store.pair({
      id: "pair-1",
      left: { provider: "youtube", accountId: "acct", playlistId: "yt-1" },
      right: { provider: "spotify", accountId: "acct", playlistId: "sp-1" },
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

  it("mirrors additions and removals through the real target provider and persists a new baseline plus removal audit", async () => {
    const store = await makeStore();
    await store.pair({
      id: "pair-1",
      left: { provider: "youtube", accountId: "acct", playlistId: "yt-1" },
      right: { provider: "spotify", accountId: "acct", playlistId: "sp-1" },
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
    expect(run.status).toBe("complete");
    expect(spotify.replaceCalls).toHaveLength(1);
    expect(spotify.replaceCalls[0]?.entries.map((item) => item.mediaId)).toEqual(["a"]);
    expect(youtube.replaceCalls).toHaveLength(0);
    const state = await store.read();
    expect(state.baselines["pair-1"]).toBeDefined();
    expect(run.removals).toEqual([expect.objectContaining({ itemIdentity: "media:b", outcome: "success", direction: "left-to-right" })]);
  });

  it("stores a left/right oriented baseline after a right-to-left run so the next run is unchanged", async () => {
    const store = await makeStore();
    await store.pair({
      id: "pair-1",
      left: { provider: "youtube", accountId: "acct", playlistId: "yt-1" },
      right: { provider: "spotify", accountId: "acct", playlistId: "sp-1" },
      enabled: true, createdAt: now, updatedAt: now,
    });
    const left = [entry("l-a", "a"), entry("l-b", "b")];
    const oldRight = [entry("r-a", "a"), entry("r-b", "b")];
    const newRight = [entry("r-a", "a")];
    await store.update((state) => {
      state.baselines["pair-1"] = {
        sourceFingerprint: fingerprintPlaylist("youtube", left),
        targetFingerprint: fingerprintPlaylist("spotify", oldRight),
      };
    });
    const youtube = new FakeProvider("youtube", [playlist("yt-1", "youtube")], new Map([["yt-1", left]]));
    const spotify = new FakeProvider("spotify", [playlist("sp-1", "spotify")], new Map([["sp-1", newRight]]));
    const first = await executeSyncRun(store, { youtube, spotify }, "pair-1");
    expect(first.status).toBe("complete");
    expect(youtube.replaceCalls).toHaveLength(1);
    expect(spotify.replaceCalls).toHaveLength(0);
    const second = await executeSyncRun(store, { youtube, spotify }, "pair-1");
    expect(second.status).toBe("complete");
    expect(second.message).toMatch(/no changes were needed/);
    expect(youtube.replaceCalls).toHaveLength(1);
  });

  it("records a failed run and a failed removal audit when the destination mutation is rejected", async () => {
    const store = await makeStore();
    await store.pair({
      id: "pair-1",
      left: { provider: "youtube", accountId: "acct", playlistId: "yt-1" },
      right: { provider: "spotify", accountId: "acct", playlistId: "sp-1" },
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
    const spotify = new FakeProvider("spotify", [playlist("sp-1", "spotify")], new Map([["sp-1", right]]), () => {
      throw new Error("Spotify rejected the mutation");
    });
    await expect(executeSyncRun(store, { youtube, spotify }, "pair-1")).rejects.toThrow("Spotify rejected the mutation");
    const state = await store.read();
    expect(state.runs[0]?.status).toBe("failed");
    expect(state.baselines["pair-1"]).toEqual({
      sourceFingerprint: fingerprintPlaylist("youtube", oldLeft),
      targetFingerprint: fingerprintPlaylist("spotify", right),
    });
    expect(state.runs[0]?.removals.some((removal) => removal.outcome === "failed" && removal.itemIdentity === "media:b")).toBe(true);
  });
});
