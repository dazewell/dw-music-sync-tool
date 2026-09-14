import { describe, expect, it, vi } from "vitest";
import type { Playlist } from "../src/core/models.js";
import { SpotifyProvider } from "../src/providers/spotify.js";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

const playlist: Playlist = {
  provider: "spotify", id: "sp-1", title: "Mix", description: "", url: "",
  owner: "someone", itemCount: 1, visibility: "private",
};

describe("SpotifyProvider", () => {
  it("refuses a continuation URL outside the Spotify Web API instead of sending the token there", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      expect(String(url)).toContain("https://api.spotify.com/v1/");
      return jsonResponse({ items: [], next: "https://attacker.example.com/v1/me/playlists?limit=50" });
    });
    const provider = new SpotifyProvider(async () => "token", { fetch: fetchMock as unknown as typeof fetch });
    await expect(provider.listPlaylists()).rejects.toMatchObject({ code: "SPOTIFY_RESPONSE_INVALID" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("observes the current snapshot and refuses to write when it changed since the plan was made", async () => {
    let snapshot = "snapshot-1";
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      if (href.includes("fields=snapshot_id")) return jsonResponse({ snapshot_id: snapshot });
      if (href.includes("/items") && (init?.method ?? "GET") === "GET") {
        return jsonResponse({
          items: [{ added_at: null, track: { id: "t1", uri: "spotify:track:t1", name: "Song", artists: [{ name: "Artist" }] } }],
          next: null,
        });
      }
      return jsonResponse({ snapshot_id: snapshot });
    });
    const provider = new SpotifyProvider(async () => "token", { fetch: fetchMock as unknown as typeof fetch });
    const observed = await provider.getPlaylist(playlist);
    expect(observed.playlist.snapshotId).toBe("snapshot-1");

    snapshot = "snapshot-2";
    await expect(provider.replacePlaylist(observed.playlist, observed.entries, "snapshot-1"))
      .rejects.toMatchObject({ code: "SPOTIFY_STALE_PLAYLIST" });
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "DELETE")).toBe(false);
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "POST")).toBe(false);
  });

  it("replaces the destination contents when the observed snapshot still matches", async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      if (href.includes("fields=snapshot_id")) return jsonResponse({ snapshot_id: "snapshot-1" });
      if (href.includes("/items") && (init?.method ?? "GET") === "GET") {
        return jsonResponse({
          items: [{ added_at: null, track: { id: "t1", uri: "spotify:track:t1", name: "Song", artists: [{ name: "Artist" }] } }],
          next: null,
        });
      }
      return jsonResponse({ snapshot_id: "snapshot-2" });
    });
    const provider = new SpotifyProvider(async () => "token", { fetch: fetchMock as unknown as typeof fetch });
    const observed = await provider.getPlaylist(playlist);
    await provider.replacePlaylist(observed.playlist, observed.entries, "snapshot-1");
    const methods = fetchMock.mock.calls.map(([, init]) => (init as RequestInit | undefined)?.method ?? "GET");
    expect(methods).toContain("DELETE");
    expect(methods).toContain("POST");
  });
});
