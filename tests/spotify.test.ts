import { afterEach, describe, expect, it, vi } from "vitest";
import { SpotifyProvider } from "../src/providers/spotify.js";
import type { Playlist, PlaylistEntry } from "../src/core/models.js";

const playlist: Playlist = {
  provider: "spotify",
  id: "playlist-1",
  title: "My Playlist",
  description: "",
  owner: "user-1",
  itemCount: 2,
  visibility: "private",
  url: "https://open.spotify.com/playlist/playlist-1",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function trackItem(uri: string, name = "Track", position = 0) {
  return {
    added_at: "2026-01-01T00:00:00Z",
    is_local: false,
    track: {
      type: "track", id: uri.split(":").pop(), uri, name,
      artists: [{ name: "Artist" }], album: { name: "Album" },
      external_urls: { spotify: `https://open.spotify.com/track/${uri}` },
      duration_ms: 1000 + position,
    },
  };
}

function fixture(responses: Response[]) {
  const fetcher = vi.fn<typeof fetch>();
  for (const response of responses) fetcher.mockResolvedValueOnce(response);
  const supplier = vi.fn(async () => "secret-access-token");
  return { provider: new SpotifyProvider(supplier, { fetch: fetcher }), fetcher, supplier };
}

function entry(uri: string, mediaId: string, availability: PlaylistEntry["availability"] = "available"): PlaylistEntry {
  return {
    id: uri, position: 0, mediaId, title: "Track", artist: "Artist", album: "Album",
    url: `https://open.spotify.com/track/${uri}`, availability, addedAt: null,
    providerData: { uri },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SpotifyProvider.getPlaylist", () => {
  it("reads the fresh snapshot id and preserves unsupported episodes and local files", async () => {
    const { provider, fetcher } = fixture([
      json({ snapshot_id: "snap-1" }),
      json({
        items: [
          trackItem("spotify:track:aaa", "Song A"),
          { added_at: "2026-01-02T00:00:00Z", is_local: true, track: { type: "track", name: "local-file.mp3" } },
          { added_at: "2026-01-03T00:00:00Z", is_local: false, track: { type: "episode", name: "A Podcast Episode" } },
        ],
        next: null,
      }),
    ]);

    const contents = await provider.getPlaylist(playlist);
    expect(contents.playlist.snapshotId).toBe("snap-1");
    expect(contents.entries).toHaveLength(3);
    expect(contents.entries[0]).toMatchObject({ availability: "available", mediaId: "aaa" });
    expect(contents.entries[1]).toMatchObject({ availability: "unavailable", mediaId: null, title: "local-file.mp3" });
    expect(contents.entries[2]).toMatchObject({ availability: "unavailable", mediaId: null, title: "A Podcast Episode" });
    expect(contents.warnings.join(" ")).toContain("Unavailable Spotify items were preserved.");
    expect(String(fetcher.mock.calls[0]![0])).toContain("fields=snapshot_id");
  });

  it("fails closed on an invalid item page instead of dropping tracks silently", async () => {
    const { provider } = fixture([
      json({ snapshot_id: "snap-1" }),
      json({ items: [{ track: { type: "track", name: "Bad", artists: "not-an-array" } }], next: null }),
    ]);
    await expect(provider.getPlaylist(playlist)).rejects.toMatchObject({ code: "SPOTIFY_RESPONSE_INVALID" });
  });
});

describe("SpotifyProvider.replacePlaylist", () => {
  it("sends bearer auth and JSON content-type only when a body is present", async () => {
    const { provider, fetcher } = fixture([
      json({ snapshot_id: "snap-1" }),
      json({ items: [trackItem("spotify:track:old", "Old")], next: null }),
      json({ snapshot_id: "snap-2" }),
      json({}),
    ]);
    await provider.replacePlaylist(playlist, [entry("spotify:track:new", "new")]);
    const deleteCall = fetcher.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "DELETE")!;
    const postCall = fetcher.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "POST")!;
    for (const call of [deleteCall, postCall]) {
      const headers = (call[1] as RequestInit).headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer secret-access-token");
      expect(headers["Content-Type"]).toBe("application/json");
    }
  });

  it("validates every target-native URI before issuing any destructive request", async () => {
    const { provider, fetcher } = fixture([]);
    const entries = [entry("spotify:track:ok", "ok"), { ...entry("spotify:track:ok", "ok"), providerData: {} }];
    await expect(provider.replacePlaylist(playlist, entries)).rejects.toMatchObject({ code: "SPOTIFY_ENTRY_UNSUPPORTED" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects a YouTube-shaped entry without a spotify:track URI before any write", async () => {
    const { provider, fetcher } = fixture([]);
    const youtubeShaped: PlaylistEntry = { ...entry("video-id", "video-id"), providerData: {} };
    await expect(provider.replacePlaylist(playlist, [youtubeShaped])).rejects.toMatchObject({ code: "SPOTIFY_ENTRY_UNSUPPORTED" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects an empty Spotify track identifier before any write", async () => {
    const { provider, fetcher } = fixture([]);
    await expect(provider.replacePlaylist(playlist, [entry("spotify:track:", "empty")]))
      .rejects.toMatchObject({ code: "SPOTIFY_ENTRY_UNSUPPORTED" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("compares the freshly reread snapshot id, not a caller-supplied or stale one", async () => {
    const { provider, fetcher } = fixture([
      json({ snapshot_id: "snap-current" }),
      json({ items: [trackItem("spotify:track:old", "Old")], next: null }),
    ]);
    await expect(provider.replacePlaylist(playlist, [entry("spotify:track:new", "new")], "snap-stale"))
      .rejects.toMatchObject({ code: "SPOTIFY_STALE_PLAYLIST" });
    // Only the fresh read happened; no destructive DELETE/POST was issued after the mismatch.
    expect(fetcher.mock.calls.every(([, init]) => (init as RequestInit | undefined)?.method === undefined)).toBe(true);
  });

  it("deletes the freshly observed current tracks before inserting the new ones", async () => {
    const { provider, fetcher } = fixture([
      json({ snapshot_id: "snap-1" }),
      json({ items: [trackItem("spotify:track:old", "Old")], next: null }),
      json({}),
      json({}),
    ]);
    await provider.replacePlaylist(playlist, [entry("spotify:track:new", "new")]);
    const methods = fetcher.mock.calls.map(([, init]) => (init as RequestInit | undefined)?.method ?? "GET");
    expect(methods).toEqual(["GET", "GET", "DELETE", "POST"]);
    const deleteBody = JSON.parse((fetcher.mock.calls[2]![1] as RequestInit).body as string);
    expect(deleteBody).toMatchObject({ tracks: [{ uri: "spotify:track:old", positions: [0] }], snapshot_id: "snap-1" });
    const postBody = JSON.parse((fetcher.mock.calls[3]![1] as RequestInit).body as string);
    expect(postBody).toMatchObject({ uris: ["spotify:track:new"] });
  });

  it("surfaces a partial failure explicitly when the insert fails after the delete succeeded", async () => {
    const { provider, fetcher } = fixture([
      json({ snapshot_id: "snap-1" }),
      json({ items: [trackItem("spotify:track:old", "Old")], next: null }),
      json({}),
      json({ error: "server error" }, 500),
    ]);
    await expect(provider.replacePlaylist(playlist, [entry("spotify:track:new", "new")]))
      .rejects.toMatchObject({ code: "SPOTIFY_REQUEST_FAILED" });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("refuses a continuation URL outside the Spotify Web API instead of sending the token there", async () => {
    const { provider, fetcher } = fixture([
      json({ items: [], next: "https://attacker.example.com/v1/me/playlists?limit=50" }),
    ]);
    await expect(provider.listPlaylists()).rejects.toMatchObject({ code: "SPOTIFY_RESPONSE_INVALID" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
