import { describe, expect, it } from "vitest";
import { DemoProvider } from "../src/providers/demo.js";

describe("synthetic provider boundary", () => {
  it("rejects a foreign provider even when its playlist ID matches a demo example", async () => {
    const provider = new DemoProvider();
    const [playlist] = await provider.listPlaylists();
    await expect(provider.getPlaylist({ ...playlist!, provider: "spotify" }))
      .rejects.toMatchObject({ code: "YOUTUBE_PLAYLIST_INVALID", status: 400 });
  });

  it("rejects an empty identifier and keeps unknown examples distinct", async () => {
    const provider = new DemoProvider();
    const [playlist] = await provider.listPlaylists();
    await expect(provider.getPlaylist({ ...playlist!, id: "" }))
      .rejects.toMatchObject({ code: "YOUTUBE_PLAYLIST_INVALID", status: 400 });
    await expect(provider.getPlaylist({ ...playlist!, id: "not-an-example" }))
      .rejects.toMatchObject({ code: "PLAYLIST_NOT_FOUND", status: 404 });
  });

  it("preserves valid synthetic playlists, counts and entry ordering", async () => {
    const provider = new DemoProvider();
    const playlists = await provider.listPlaylists();
    expect(playlists).toHaveLength(4);
    for (const playlist of playlists) {
      const contents = await provider.getPlaylist(playlist);
      expect(contents.playlist).toEqual(playlist);
      expect(contents.entries).toHaveLength(playlist.itemCount!);
      expect(contents.entries.map(entry => entry.position)).toEqual(
        Array.from({ length: playlist.itemCount! }, (_, index) => index),
      );
      expect(contents.entries.every(entry => entry.providerData["synthetic"] === true)).toBe(true);
    }
  });
});
