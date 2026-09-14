import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Playlist, PlaylistContents, PlaylistEntry, ProviderId } from "../src/core/models.js";
import {
  applySyncPlan,
  compareFingerprints,
  fingerprintPlaylist,
  normalizePlaylistName,
  planBidirectionalSync,
  proposePlaylistPairs,
} from "../src/core/sync.js";
import { SyncStateStore } from "../src/core/sync-state.js";

function playlist(id: string, title: string, provider: ProviderId = "youtube"): Playlist {
  return {
    provider, id, title, description: "", url: "", owner: "",
    itemCount: null, visibility: "unknown",
  };
}

function entry(id: string, mediaId: string | null): PlaylistEntry {
  return {
    id, mediaId, position: 0, title: "Song", artist: null, album: null,
    url: null, availability: mediaId ? "available" : "unavailable",
    addedAt: null, providerData: {},
  };
}

describe("playlist names and pairing", () => {
  it("normalizes compatibility characters, case, and Unicode whitespace without discarding accents", () => {
    expect(normalizePlaylistName(" \tＦＯＯ\u00a0  Café\n")).toBe("foo café");
    expect(normalizePlaylistName("Cafe\u0301")).toBe("café");
    expect(normalizePlaylistName("Café")).not.toBe(normalizePlaylistName("Cafe"));
  });

  it("proposes only unambiguous cross-platform pairs and returns duplicates separately", () => {
    const sources = [
      playlist("one", "  Chill "), playlist("two", "ROCK"), playlist("three", "Rock"),
      playlist("four", "Jazz"), playlist("five", "Only Source"), playlist("blank", " "),
      playlist("same", "Same Platform"),
    ];
    const targets = [
      playlist("a", "ＣＨＩＬＬ", "spotify"), playlist("b", "rock", "spotify"),
      playlist("c", "jazz", "spotify"), playlist("d", " Jazz ", "spotify"),
      playlist("e", "Only Target", "spotify"), playlist("empty", "", "spotify"),
      playlist("same-too", "Same Platform"),
    ];
    const result = proposePlaylistPairs(sources, targets);
    expect(result.candidates).toEqual([{
      normalizedName: "chill", source: sources[0], target: targets[0],
    }]);
    expect(result.ambiguities).toEqual([
      { normalizedName: "rock", sources: [sources[1], sources[2]], targets: [targets[1]] },
      { normalizedName: "jazz", sources: [sources[3]], targets: [targets[2], targets[3]] },
    ]);
    expect(sources).toHaveLength(7);
    expect(targets).toHaveLength(7);
  });

  it("validates complete references in either pair orientation", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "music-sync-pair-"));
    try {
      const store = new SyncStateStore(path.join(directory, "sync-state.json"));
      const pairing = {
        id: "pair-1",
        left: { provider: "youtube" as const, accountId: "yt-account", playlistId: "same-id" },
        right: { provider: "spotify" as const, accountId: "sp-account", playlistId: "same-id" },
        enabled: true, createdAt: "2026-09-13T20:00:00.000Z", updatedAt: "2026-09-13T20:00:00.000Z",
      };
      await store.pair(pairing);
      await expect(store.pair({
        ...pairing,
        id: "pair-reversed",
        left: pairing.right,
        right: pairing.left,
      })).rejects.toMatchObject({ code: "SYNC_PAIR_EXISTS" });
      await expect(store.pair({
        ...pairing,
        id: "pair-different-account",
        left: { ...pairing.left, accountId: "other-account" },
      })).rejects.toMatchObject({ code: "SYNC_PAIR_EXISTS" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects pairing an ignored playlist, and disables an existing pair when either side is ignored", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "music-sync-ignore-"));
    try {
      const store = new SyncStateStore(path.join(directory, "sync-state.json"));
      const left = { provider: "youtube" as const, accountId: "acct", playlistId: "yt-1" };
      const right = { provider: "spotify" as const, accountId: "acct", playlistId: "sp-1" };
      await store.ignore({ ...left, reason: "Duplicate", createdAt: "2026-09-13T20:00:00.000Z" });
      await expect(store.pair({
        id: "pair-1", left, right, enabled: true,
        createdAt: "2026-09-13T20:00:00.000Z", updatedAt: "2026-09-13T20:00:00.000Z",
      })).rejects.toMatchObject({ code: "SYNC_PAIR_IGNORED" });

      const otherRight = { provider: "spotify" as const, accountId: "acct", playlistId: "sp-2" };
      await store.pair({
        id: "pair-2", left: { ...left, playlistId: "yt-2" }, right: otherRight, enabled: true,
        createdAt: "2026-09-13T20:00:00.000Z", updatedAt: "2026-09-13T20:00:00.000Z",
      });
      await store.ignore({ ...otherRight, reason: "", createdAt: "2026-09-13T20:00:00.000Z" });
      const state = await store.read();
      expect(state.pairs.find((item) => item.id === "pair-2")?.enabled).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("re-enables a pair that ignore() disabled, once unignore() is called for the same playlist", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "music-sync-unignore-"));
    try {
      const store = new SyncStateStore(path.join(directory, "sync-state.json"));
      const left = { provider: "youtube" as const, accountId: "acct", playlistId: "yt-1" };
      const right = { provider: "spotify" as const, accountId: "acct", playlistId: "sp-1" };
      await store.pair({
        id: "pair-1", left, right, enabled: true,
        createdAt: "2026-09-13T20:00:00.000Z", updatedAt: "2026-09-13T20:00:00.000Z",
      });
      await store.ignore({ ...left, reason: "Duplicate", createdAt: "2026-09-13T20:00:00.000Z" });
      expect((await store.read()).pairs.find((item) => item.id === "pair-1")?.enabled).toBe(false);

      const state = await store.unignore(left);
      expect(state.ignores).toHaveLength(0);
      expect(state.pairs.find((item) => item.id === "pair-1")?.enabled).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps a pair disabled after unignore() when the other side is still separately ignored", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "music-sync-unignore-both-"));
    try {
      const store = new SyncStateStore(path.join(directory, "sync-state.json"));
      const left = { provider: "youtube" as const, accountId: "acct", playlistId: "yt-1" };
      const right = { provider: "spotify" as const, accountId: "acct", playlistId: "sp-1" };
      await store.pair({
        id: "pair-1", left, right, enabled: true,
        createdAt: "2026-09-13T20:00:00.000Z", updatedAt: "2026-09-13T20:00:00.000Z",
      });
      await store.ignore({ ...left, reason: "", createdAt: "2026-09-13T20:00:00.000Z" });
      await store.ignore({ ...right, reason: "", createdAt: "2026-09-13T20:00:00.000Z" });

      const state = await store.unignore(left);
      expect(state.pairs.find((item) => item.id === "pair-1")?.enabled).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects unignoring a playlist that is not currently ignored", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "music-sync-unignore-missing-"));
    try {
      const store = new SyncStateStore(path.join(directory, "sync-state.json"));
      await expect(store.unignore({ provider: "youtube", accountId: "acct", playlistId: "yt-1" }))
        .rejects.toMatchObject({ code: "SYNC_IGNORE_NOT_FOUND" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("stable ordered fingerprints", () => {
  const entries = [entry("instance-1", "media-a"), entry("gone", null), entry("instance-2", "media-a")];

  it("ignores timestamps, cosmetic metadata, availability labels, and item instance IDs for known media", () => {
    const cosmeticChanges = entries.map((item, index) => ({
      ...item,
      id: item.mediaId ? `new-instance-${index}` : item.id,
      title: "Renamed", artist: "Different", album: "Reissue", position: index + 10,
      url: "https://example.test/new-url", addedAt: "2026-01-01T00:00:00Z",
      availability: "unknown" as const, providerData: { changed: true },
    }));
    expect(fingerprintPlaylist("youtube", entries)).toMatch(/^[a-f0-9]{64}$/);
    expect(fingerprintPlaylist("youtube", entries)).toBe(fingerprintPlaylist("youtube", cosmeticChanges));
  });

  it("detects identity, duplicate-count, sequence, missing-item identity, and namespace changes", () => {
    const original = fingerprintPlaylist("youtube", entries);
    expect(original).not.toBe(fingerprintPlaylist("youtube", [entries[1]!, entries[0]!, entries[2]!]));
    expect(original).not.toBe(fingerprintPlaylist("youtube", entries.slice(0, 2)));
    expect(original).not.toBe(fingerprintPlaylist("youtube", [entry("instance-1", "other"), ...entries.slice(1)]));
    expect(original).not.toBe(fingerprintPlaylist("youtube", [entries[0]!, entry("different-missing", null), entries[2]!]));
    expect(original).not.toBe(fingerprintPlaylist("spotify", entries));
    expect(fingerprintPlaylist("youtube", [])).toBe(fingerprintPlaylist("youtube", []));
    expect(fingerprintPlaylist("youtube", [entry("x", null)]))
      .not.toBe(fingerprintPlaylist("youtube", [entry("x", "x")]));
  });
});

describe("common sync baseline comparison", () => {
  const baseline = { sourceFingerprint: "source-original", targetFingerprint: "target-original" };

  it.each([
    ["source-original", "target-original", "unchanged"],
    ["source-new", "target-original", "source-changed"],
    ["source-original", "target-new", "target-changed"],
    ["source-new", "target-new", "conflict"],
    ["same-new-value", "same-new-value", "conflict"],
  ] as const)("compares %s and %s as %s", (source, target, expected) => {
    expect(compareFingerprints(source, target, baseline)).toBe(expected);
  });

  describe("removal audit persistence", () => {
    it("retains one inspectable audit record per mirrored removal", async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "music-sync-audit-"));
      try {
        const store = new SyncStateStore(path.join(directory, "sync-state.json"));
        const run = await store.startRun("pair-1");
        await store.recordRemovalAudits(run.id, [{
          pairId: "pair-1", platform: "spotify", playlistId: "target",
          itemIdentity: "media:removed-track", direction: "left-to-right",
          timestamp: "2026-09-13T20:00:00.000Z", outcome: "success", error: null,
        }]);
        const state = await store.read();
        expect(state.runs[0]?.removals).toEqual([{
          pairId: "pair-1", platform: "spotify", playlistId: "target",
          itemIdentity: "media:removed-track", direction: "left-to-right",
          timestamp: "2026-09-13T20:00:00.000Z", outcome: "success", error: null,
        }]);
        expect(JSON.parse(await readFile(path.join(directory, "sync-state.json"), "utf8")).runs[0].removals).toHaveLength(1);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });

    it("records failed removal outcomes when destination mutation fails", async () => {
      const left: PlaylistContents = {
        playlist: playlist("left", "left", "youtube"),
        entries: [entry("a", "a")],
        warnings: [],
      };
      const right: PlaylistContents = {
        playlist: playlist("right", "right", "youtube"),
        entries: [entry("a", "a"), entry("b", "b")],
        warnings: [],
      };
      const plan = planBidirectionalSync(left, right, {
        sourceFingerprint: fingerprintPlaylist("youtube", [entry("old", "a"), entry("old-b", "b")]),
        targetFingerprint: fingerprintPlaylist("youtube", right.entries),
      });
      const audits: Array<{ outcome: string; itemIdentity: string; error: string | null }> = [];
      const provider = {
        id: "spotify" as const, coverage: "", listPlaylists: async () => [], getPlaylist: async () => right,
        replacePlaylist: async () => { throw new Error("mutation rejected"); },
      };
      await expect(applySyncPlan(plan, provider, {
        runId: "run-1", pairId: "pair-1",
        sink: { recordRemovalAudits: async (_runId, records) => audits.push(...records.map(record => ({ outcome: record.outcome, itemIdentity: record.itemIdentity, error: record.error }))) },
      })).rejects.toThrow("mutation rejected");
      expect(audits).toEqual([{ outcome: "unknown", itemIdentity: "media:b", error: "The destination mutation failed." }]);
    });
  });

  describe("bidirectional sync planning", () => {
    function contents(provider: ProviderId, ids: string[]): import("../src/core/models.js").PlaylistContents {
      return {
        playlist: playlist(`${provider}-playlist`, provider, provider),
        entries: ids.map((id, position) => ({ ...entry(`${provider}-${position}`, id), position })),
        warnings: [],
      };
    }

    it("mirrors the changed side, including removals and order", () => {
      const left = contents("youtube", ["a", "c"]);
      const right = contents("youtube", ["a", "b", "c"]);
      const baseline = {
        sourceFingerprint: fingerprintPlaylist("youtube", contents("youtube", ["a", "b", "c"]).entries),
        targetFingerprint: fingerprintPlaylist("youtube", right.entries),
      };
      const plan = planBidirectionalSync(left, right, baseline);
      expect(plan.status).toBe("ready");
      expect(plan.direction).toBe("left-to-right");
      expect(plan.entries.map(item => item.mediaId)).toEqual(["a", "c"]);
      expect(plan.removals).toBe(1);
    });

    it("requires review instead of a ready plan when the changed side has an unwritable entry", () => {
      const changed = contents("youtube", ["a", "c"]);
      // Give it a valid provider-agnostic identity (artist+title) so it doesn't hit the earlier
      // "ambiguous/incomplete identity" branch; mediaId===null still makes it unwritable, which
      // both providers' replacePlaylist() would otherwise reject at write time.
      changed.entries[1] = { ...changed.entries[1]!, mediaId: null, availability: "unavailable", artist: "Someone", title: "A Song" };
      const right = contents("youtube", ["a", "b", "c"]);
      const baseline = {
        sourceFingerprint: fingerprintPlaylist("youtube", contents("youtube", ["a", "b", "c"]).entries),
        targetFingerprint: fingerprintPlaylist("youtube", right.entries),
      };
      const plan = planBidirectionalSync(changed, right, baseline);
      expect(plan.status).toBe("review-required");
      expect(plan.reason).toMatch(/unavailable/i);
    });


    it("returns verified fingerprints in fixed pair-left and pair-right order", async () => {
      const left = contents("youtube", ["a"]);
      const right = contents("youtube", ["a", "b"]);
      const baseline = {
        sourceFingerprint: fingerprintPlaylist("youtube", left.entries),
        targetFingerprint: fingerprintPlaylist("youtube", contents("youtube", ["a"]).entries),
      };
      const plan = planBidirectionalSync(left, right, baseline);
      expect(plan.direction).toBe("right-to-left");
      const result = await applySyncPlan(plan, {
        id: "youtube", coverage: "",
        listPlaylists: async () => [],
        getPlaylist: async (playlist) => ({ playlist, entries: right.entries, warnings: [] }),
        replacePlaylist: async (_playlist, entries) => {
          right.entries = entries.map((item, position) => ({ ...item, position }));
        },
      });
      expect(result).toEqual({
        sourceFingerprint: fingerprintPlaylist("youtube", right.entries),
        targetFingerprint: fingerprintPlaylist("youtube", right.entries),
      });
    });

    it("requires review instead of treating provider-scoped IDs as cross-provider matches", () => {
      const left = contents("youtube", ["a", "c"]);
      const right = contents("spotify", ["a", "b", "c"]);
      const baseline = {
        sourceFingerprint: fingerprintPlaylist("youtube", contents("youtube", ["a", "b", "c"]).entries),
        targetFingerprint: fingerprintPlaylist("spotify", right.entries),
      };
      const plan = planBidirectionalSync(left, right, baseline);
      expect(plan.status).toBe("review-required");
      expect(plan.reason).toMatch(/cross-provider item mapping/i);
    });

    it("requires review for both-sided changes and ambiguous identities", () => {
      const left = contents("youtube", ["a", "b"]);
      const right = contents("spotify", ["a", "c"]);
      const baseline = { sourceFingerprint: "old", targetFingerprint: "old" };
      expect(planBidirectionalSync(left, right, baseline).status).toBe("review-required");
      const duplicate = contents("youtube", ["a", "a"]);
      expect(planBidirectionalSync(duplicate, right, {
        sourceFingerprint: fingerprintPlaylist("youtube", ["a"].map((id) => ({ ...entry("x", id), position: 0 }))),
        targetFingerprint: fingerprintPlaylist("spotify", right.entries),
      }).status).toBe("review-required");
    });
  });

  it("requires an acknowledged common baseline, even when current values match", () => {
    expect(compareFingerprints("same", "same", null)).toBe("uninitialized");
    expect(compareFingerprints("source", "target", undefined)).toBe("uninitialized");
  });

  it("retires persisted running runs and their baseline before a retry can reuse it", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "music-sync-recovery-"));
    try {
      const store = new SyncStateStore(path.join(directory, "sync-state.json"));
      await store.update((state) => {
        state.baselines["pair-1"] = { sourceFingerprint: "left", targetFingerprint: "right" };
      });
      const run = await store.startRun("pair-1");
      const recovered = await new SyncStateStore(path.join(directory, "sync-state.json")).read();
      expect(recovered.baselines["pair-1"]).toBeUndefined();
      expect(recovered.runs.find(item => item.id === run.id)).toMatchObject({
        status: "review-required",
        message: expect.stringMatching(/interrupted/i),
      });
      expect(recovered.runs.find(item => item.id === run.id)?.completedAt).not.toBeNull();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("never recovers a running run through a plain reporting peek, only through read()", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "music-sync-peek-"));
    try {
      const filename = path.join(directory, "sync-state.json");
      const owner = new SyncStateStore(filename);
      await owner.update((state) => {
        state.baselines["pair-1"] = { sourceFingerprint: "left", targetFingerprint: "right" };
      });
      const run = await owner.startRun("pair-1");

      // A second process (e.g. a CLI report, or the dashboard) reading concurrently must
      // not treat this owning process's in-flight run as interrupted and destroy its baseline.
      const reporter = new SyncStateStore(filename);
      const peeked = await reporter.peek();
      expect(peeked.runs.find(item => item.id === run.id)?.status).toBe("running");
      expect(peeked.baselines["pair-1"]).toEqual({ sourceFingerprint: "left", targetFingerprint: "right" });

      // Only a path that actually holds exclusive access for the whole operation recovers it.
      const recovered = await reporter.read();
      expect(recovered.runs.find(item => item.id === run.id)?.status).toBe("review-required");
      expect(recovered.baselines["pair-1"]).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("claims a run as active before persisting it", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "music-sync-start-race-"));
    try {
      const store = new SyncStateStore(path.join(directory, "sync-state.json"));
      await store.update((state) => {
        state.baselines["pair-1"] = { sourceFingerprint: "left", targetFingerprint: "right" };
      });
      const update = store.update.bind(store);
      vi.spyOn(store, "update").mockImplementationOnce(async (mutator) => {
        const state = await update(mutator);
        const concurrentRead = await store.read();
        expect(concurrentRead.runs.at(-1)?.status).toBe("running");
        expect(concurrentRead.baselines["pair-1"]).toEqual({ sourceFingerprint: "left", targetFingerprint: "right" });
        return state;
      });

      const run = await store.startRun("pair-1");
      expect((await store.peek()).runs.find(item => item.id === run.id)?.status).toBe("running");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
