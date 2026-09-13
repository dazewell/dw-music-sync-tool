import { describe, expect, it } from "vitest";
import type { Playlist, PlaylistEntry, ProviderId } from "../src/core/models.js";
import {
  compareFingerprints,
  fingerprintPlaylist,
  normalizePlaylistName,
  proposePlaylistPairs,
} from "../src/core/sync.js";

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

  it("requires an acknowledged common baseline, even when current values match", () => {
    expect(compareFingerprints("same", "same", null)).toBe("uninitialized");
    expect(compareFingerprints("source", "target", undefined)).toBe("uninitialized");
  });
});
