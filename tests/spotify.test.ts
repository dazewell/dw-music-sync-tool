import { afterEach, describe, expect, it, vi } from "vitest";
import { SpotifyProvider } from "../src/providers/spotify.js";
import { AppError } from "../src/core/errors.js";
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
      json({ snapshot_id: "snap-2" }),
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

  it("chunks a delete of more than 100 current tracks from the end backward and carries the returned snapshot id forward", async () => {
    const trackCount = 150;
    const items = Array.from({ length: trackCount }, (_, index) => trackItem(`spotify:track:old-${index}`, `Old ${index}`, index));
    const { provider, fetcher } = fixture([
      json({ snapshot_id: "snap-1" }),
      json({ items, next: null }),
      json({ snapshot_id: "snap-2" }),
      json({ snapshot_id: "snap-3" }),
      json({}),
    ]);
    await provider.replacePlaylist(playlist, [entry("spotify:track:new", "new")]);
    const methods = fetcher.mock.calls.map(([, init]) => (init as RequestInit | undefined)?.method ?? "GET");
    // Two GETs to read the playlist, two chunked DELETEs (50 + 100), then one POST insert.
    expect(methods).toEqual(["GET", "GET", "DELETE", "DELETE", "POST"]);
    const firstDeleteBody = JSON.parse((fetcher.mock.calls[2]![1] as RequestInit).body as string);
    const secondDeleteBody = JSON.parse((fetcher.mock.calls[3]![1] as RequestInit).body as string);
    // The first batch removed must be the *last* 50 tracks (positions 100-149): removing the
    // highest positions first means every remaining batch's already-computed positions stay
    // accurate, since only tracks after it in the list have been removed so far.
    expect(firstDeleteBody.tracks).toHaveLength(50);
    expect(firstDeleteBody.tracks[0]).toMatchObject({ positions: [100] });
    expect(firstDeleteBody.snapshot_id).toBe("snap-1");
    expect(secondDeleteBody.tracks).toHaveLength(100);
    expect(secondDeleteBody.tracks[0]).toMatchObject({ positions: [0] });
    // The second batch must use the snapshot returned by the first, not the original read.
    expect(secondDeleteBody.snapshot_id).toBe("snap-2");
  });

  it("fails closed instead of silently keeping a stale snapshot when a delete response omits snapshot_id", async () => {
    const { provider, fetcher } = fixture([
      json({ snapshot_id: "snap-1" }),
      json({ items: [trackItem("spotify:track:old", "Old")], next: null }),
      json({ error: "unexpected shape" }),
    ]);
    await expect(provider.replacePlaylist(playlist, [entry("spotify:track:new", "new")]))
      .rejects.toMatchObject({ code: "SPOTIFY_RESPONSE_INVALID" });
    // No insert should be attempted after an unconfirmed destructive result.
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("rejects an unavailable entry with a dangling uri instead of writing it as playable", async () => {
    const { provider, fetcher } = fixture([]);
    const unavailable = entry("spotify:track:ghost", "ghost", "unavailable");
    await expect(provider.replacePlaylist(playlist, [unavailable])).rejects.toMatchObject({ code: "SPOTIFY_ENTRY_UNSUPPORTED" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("refuses to delete a current entry that has a dangling uri but is marked unavailable", async () => {
    const { provider, fetcher } = fixture([
      json({ snapshot_id: "snap-1" }),
      // track.id is null (so getPlaylist marks this "unavailable") but track.uri is still present -
      // exactly the case the current-entries preflight must reject before any DELETE is issued.
      json({
        items: [{
          added_at: "2026-01-01T00:00:00Z", is_local: false,
          track: { type: "track", id: null, uri: "spotify:track:ghost", name: "Ghost" },
        }],
        next: null,
      }),
    ]);
    await expect(provider.replacePlaylist(playlist, [entry("spotify:track:new", "new")]))
      .rejects.toMatchObject({ code: "SPOTIFY_ENTRY_UNSUPPORTED" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rejects an empty playlist id instead of issuing a request to a malformed URL", async () => {
    const { provider, fetcher } = fixture([]);
    await expect(provider.replacePlaylist({ ...playlist, id: "" }, [entry("spotify:track:new", "new")]))
      .rejects.toMatchObject({ code: "SPOTIFY_PLAYLIST_INVALID" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("surfaces a partial failure explicitly when the insert fails after the delete succeeded", async () => {
    const { provider, fetcher } = fixture([
      json({ snapshot_id: "snap-1" }),
      json({ items: [trackItem("spotify:track:old", "Old")], next: null }),
      json({ snapshot_id: "snap-2" }),
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

describe("SpotifyProvider.listPlaylists", () => {
  it("accepts a null description instead of rejecting the page as invalid", async () => {
    const { provider, fetcher } = fixture([
      json({
        items: [{
          id: "playlist-2", name: "Untouched Playlist", description: null,
          owner: { id: "user-1" }, public: true, tracks: { total: 0 },
        }],
        next: null,
      }),
    ]);
    const playlists = await provider.listPlaylists();
    expect(playlists).toEqual([{
      provider: "spotify", id: "playlist-2", title: "Untouched Playlist", description: "",
      url: "https://open.spotify.com/playlist/playlist-2", owner: "user-1", itemCount: 0, visibility: "public",
    }]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("fails closed instead of defaulting a missing owner id to an unverified placeholder", async () => {
    const { provider, fetcher } = fixture([
      json({
        items: [{ id: "playlist-3", name: "Ownerless Playlist", tracks: { total: 0 } }],
        next: null,
      }),
    ]);
    await expect(provider.listPlaylists()).rejects.toMatchObject({ code: "SPOTIFY_RESPONSE_INVALID" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("SpotifyProvider.getAuthenticatedAccountId", () => {
  it("returns the id of the account the refresh token is actually authenticated as", async () => {
    const { provider, fetcher } = fixture([json({ id: "authenticated-user" })]);
    await expect(provider.getAuthenticatedAccountId()).resolves.toBe("authenticated-user");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]![0])).toBe("https://api.spotify.com/v1/me");
  });

  it("fails closed when Spotify does not return an authenticated account id", async () => {
    const { provider } = fixture([json({})]);
    await expect(provider.getAuthenticatedAccountId()).rejects.toMatchObject({ code: "SPOTIFY_RESPONSE_INVALID" });
  });
});

describe("SpotifyProvider request auth failures", () => {
  it("preserves a specific AppError thrown by the token supplier instead of masking it", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const supplier = vi.fn(async () => {
      throw new AppError("SPOTIFY_AUTH_REJECTED", "Spotify's refresh token was rejected; reconnect Spotify.", 401);
    });
    const provider = new SpotifyProvider(supplier, { fetch: fetcher });
    await expect(provider.listPlaylists()).rejects.toMatchObject({ code: "SPOTIFY_AUTH_REJECTED" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("falls back to a generic auth error for a non-AppError token supplier failure", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const supplier = vi.fn(async () => {
      throw new Error("network blip");
    });
    const provider = new SpotifyProvider(supplier, { fetch: fetcher });
    await expect(provider.listPlaylists()).rejects.toMatchObject({ code: "SPOTIFY_AUTH_FAILED" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
