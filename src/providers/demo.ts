import type { Playlist, PlaylistContents, PlaylistEntry, PlaylistProvider } from "../core/models.js";
import { AppError } from "../core/errors.js";

const examples = [
  { id: "demo-late-shift", title: "Late shift", count: 6, description: "Synthetic tracks for a focused evening." },
  { id: "demo-morning", title: "Morning rotation", count: 4, description: "Synthetic tracks for the start of the day." },
  { id: "demo-road", title: "Long way home", count: 8, description: "Synthetic road-trip playlist, including a duplicate." },
  { id: "demo-empty", title: "Next discoveries", count: 0, description: "An empty synthetic playlist." },
];

export class DemoProvider implements PlaylistProvider {
  readonly id = "youtube" as const;
  readonly coverage = "Demo only: synthetic playlists and metadata. No Google account or external API is used.";

  async listPlaylists(): Promise<Playlist[]> {
    return examples.map((item) => ({
      provider: this.id,
      id: item.id,
      title: item.title,
      description: item.description,
      url: `https://music.youtube.com/playlist?list=${item.id}`,
      owner: "Demo library (synthetic)",
      itemCount: item.count,
      visibility: "private",
    }));
  }

  async getPlaylist(playlist: Playlist): Promise<PlaylistContents> {
    const example = examples.find((item) => item.id === playlist.id);
    if (!example) throw new AppError("PLAYLIST_NOT_FOUND", "The demo playlist does not exist.", 404);
    const entries: PlaylistEntry[] = Array.from({ length: example.count }, (_, position) => {
      const missing = playlist.id === "demo-road" && position === 4;
      const track = playlist.id === "demo-road" && position === 7 ? 0 : position;
      const mediaId = missing ? null : `${playlist.id}-track-${track}`;
      return {
        id: `${playlist.id}-entry-${position}`,
        position,
        mediaId,
        title: missing ? "Unavailable video" : ["Night windows", "Open water", "Parallel lines", "Daybreak"][track % 4] ?? "Demo track",
        artist: missing ? null : ["The Demo Ensemble", "Sample Signals"][track % 2] ?? "Demo artist",
        album: null,
        url: mediaId ? `https://music.youtube.com/watch?v=${mediaId}` : null,
        availability: missing ? "unavailable" : "unknown",
        addedAt: "2026-01-01T00:00:00.000Z",
        providerData: { synthetic: true },
      };
    });
    return {
      playlist,
      entries,
      warnings: [
        "Synthetic demonstration data; media URLs are placeholders, not playable music.",
        ...(entries.some((entry) => entry.availability === "unavailable")
          ? ["One synthetic unavailable entry is retained in its original position."]
          : []),
      ],
    };
  }
}
