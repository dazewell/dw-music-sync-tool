import { afterEach, describe, expect, it, vi } from "vitest";
import { YouTubeProvider } from "../src/providers/youtube.js";
import type { Playlist } from "../src/core/models.js";

const playlist: Playlist = {
  provider: "youtube",
  id: "owned-list",
  title: "Owned music",
  description: "",
  owner: "Playlist curator",
  itemCount: 1,
  visibility: "private",
  url: "https://www.youtube.com/playlist?list=owned-list",
};

function apiPlaylist(id = "owned-list", itemCount = 1) {
  return {
    id,
    snippet: { title: "Owned music", description: "", channelTitle: "Playlist curator" },
    contentDetails: { itemCount },
    status: { privacyStatus: "private" },
  };
}

function apiItem(position = 0, videoId = `video-${position}`, title = `Track ${position}`) {
  return {
    id: `item-${position}`,
    snippet: {
      title,
      position,
      playlistId: "owned-list",
      publishedAt: "2026-01-01T00:00:00Z",
      channelTitle: "Playlist curator",
      resourceId: { kind: "youtube#video", videoId },
    },
    contentDetails: { videoId },
    status: { privacyStatus: "public" },
  };
}

function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

function fixture(responses: Response[]) {
  const fetcher = vi.fn<typeof fetch>();
  for (const response of responses) fetcher.mockResolvedValueOnce(response);
  const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);
  const supplier = vi.fn(async () => "secret-access-token");
  return {
    provider: new YouTubeProvider(supplier, { fetch: fetcher, sleep }),
    fetcher,
    sleep,
    supplier,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("YouTubeProvider official read-only coverage", () => {
  it("paginates owned playlists and all 120 entries, preserving order, duplicates and unavailable entries", async () => {
    const playlists = Array.from({ length: 52 }, (_, index) =>
      apiPlaylist(index === 0 ? "owned-list" : `list-${index}`, index === 0 ? 120 : 0));
    const entries = Array.from({ length: 120 }, (_, position) =>
      apiItem(position, position === 41 ? "video-40" : `video-${position}`,
        position === 90 ? "Deleted video" : position === 95 ? "Private video" : `Track ${position}`));
    const { provider, fetcher } = fixture([
      json({ items: playlists.slice(0, 50), nextPageToken: "lists-next", pageInfo: { totalResults: 52 } }),
      json({ items: playlists.slice(50), pageInfo: { totalResults: 52 } }),
      json({ items: entries.slice(0, 50).reverse(), nextPageToken: "items-50", pageInfo: { totalResults: 120 } }),
      json({ items: entries.slice(50, 100), nextPageToken: "items-100", pageInfo: { totalResults: 120 } }),
      json({ items: entries.slice(100), pageInfo: { totalResults: 120 } }),
    ]);

    const listed = await provider.listPlaylists();
    expect(listed).toHaveLength(52);
    const contents = await provider.getPlaylist(listed[0]!);
    expect(contents.entries).toHaveLength(120);
    expect(contents.entries.map((item) => item.position)).toEqual(Array.from({ length: 120 }, (_, i) => i));
    expect(contents.entries[40]?.mediaId).toBe("video-40");
    expect(contents.entries[41]?.mediaId).toBe("video-40");
    expect(contents.entries[40]?.id).not.toBe(contents.entries[41]?.id);
    expect(contents.entries[90]).toMatchObject({ title: "Deleted video", availability: "unavailable" });
    expect(contents.entries[95]).toMatchObject({ title: "Private video", availability: "unavailable" });
    expect(contents.entries[0]).toMatchObject({ availability: "unknown", artist: null, album: null });
    expect(contents.warnings.join(" ")).toContain("placeholders");
    expect(provider.coverage).toContain("not a complete YouTube Music library");
    expect(provider.coverage).toContain("including non-music videos");
    expect(provider.coverage).toContain("mixes, audio uploads, liked Music");
    expect(provider.coverage).toContain("incomplete metadata");
    expect(provider.id).toBe("youtube");
    expect(fetcher).toHaveBeenCalledTimes(5);
    for (const [input, init] of fetcher.mock.calls) {
      const url = new URL(String(input));
      expect(url.origin).toBe("https://www.googleapis.com");
      expect(url.searchParams.get("part")).toBe("snippet,contentDetails,status");
      expect(url.searchParams.get("maxResults")).toBe("50");
      expect(init?.method).toBe("GET");
      expect(init?.headers).toMatchObject({ Authorization: "Bearer secret-access-token" });
      expect(init?.redirect).toBe("error");
      expect(url.toString()).not.toContain("secret-access-token");
    }
    expect(new URL(String(fetcher.mock.calls[0]?.[0])).searchParams.get("mine")).toBe("true");
    expect(new URL(String(fetcher.mock.calls[1]?.[0])).searchParams.get("pageToken")).toBe("lists-next");
    expect(new URL(String(fetcher.mock.calls[3]?.[0])).searchParams.get("pageToken")).toBe("items-50");
  });

  it("uses the stable channel ID as the playlist owner instead of the mutable channel title, when present", async () => {
    const { provider } = fixture([json({
      items: [{
        ...apiPlaylist(),
        snippet: { title: "Owned music", description: "", channelId: "UC-stable-id", channelTitle: "Playlist curator" },
      }],
    })]);
    const [listed] = await provider.listPlaylists();
    expect(listed?.owner).toBe("UC-stable-id");
  });

  it("falls back to the channel title as owner when the API omits channelId", async () => {
    const { provider } = fixture([json({ items: [apiPlaylist()] })]);
    const [listed] = await provider.listPlaylists();
    expect(listed?.owner).toBe("Playlist curator");
  });

  it("keeps owner channel names only in provider metadata, never as recording artist", async () => {
    const item = apiItem();
    const { provider } = fixture([json({
      items: [{
        ...item,
        snippet: { ...item.snippet, videoOwnerChannelTitle: "Uploader channel", injectedToken: "hidden-secret" },
        status: { privacyStatus: "private" },
        access_token: "hidden-secret",
      }],
    })]);
    const result = await provider.getPlaylist(playlist);
    expect(result.entries[0]?.artist).toBeNull();
    expect(result.entries[0]?.availability).toBe("unknown");
    expect(result.warnings).toEqual([]);
    expect(JSON.stringify(result.entries[0]?.providerData)).not.toContain("hidden-secret");
    expect(result.entries[0]?.providerData).toMatchObject({
      id: "item-0",
      snippet: { channelTitle: "Playlist curator", videoOwnerChannelTitle: "Uploader channel" },
      status: { privacyStatus: "private" },
    });
  });

  it("retains placeholders without video IDs and exposes missing metadata", async () => {
    const item = apiItem();
    const { provider } = fixture([json({ items: [{
      ...item,
      snippet: { ...item.snippet, title: "Deleted video", resourceId: { kind: "youtube#video" } },
      contentDetails: {},
    }] })]);
    const result = await provider.getPlaylist(playlist);
    expect(result.entries[0]).toMatchObject({ id: "item-0", mediaId: null, url: null, availability: "unavailable" });
    expect(result.warnings.join(" ")).toContain("no video ID");
  });

  it("fails rather than claiming completeness when totals change during pagination", async () => {
    const { provider } = fixture([
      json({ items: [apiItem()], nextPageToken: "next", pageInfo: { totalResults: 3 } }),
      json({ items: [apiItem(1)], pageInfo: { totalResults: 2 } }),
    ]);
    await expect(provider.getPlaylist({ ...playlist, itemCount: 2 })).rejects.toMatchObject({
      code: "YOUTUBE_PLAYLIST_CHANGED", status: 409,
    });
  });

  it.each([
    { itemCount: 2, totalResults: 1 },
    { itemCount: 1, totalResults: 2 },
    { itemCount: null, totalResults: 2 },
  ])("rejects known item-count or page-total mismatches %#", async ({ itemCount, totalResults }) => {
    const { provider } = fixture([json({ items: [apiItem()], pageInfo: { totalResults } })]);
    await expect(provider.getPlaylist({ ...playlist, itemCount })).rejects.toMatchObject({
      code: "YOUTUBE_PLAYLIST_CHANGED", status: 409,
    });
  });

  it.each([
    [apiItem(), { ...apiItem(1), id: "item-0" }],
    [apiItem(), { ...apiItem(1), snippet: { ...apiItem(1).snippet, position: 0 } }],
  ])("rejects repeated occurrence IDs or positions even when counts agree %#", async (first, second) => {
    const { provider } = fixture([json({ items: [first, second], pageInfo: { totalResults: 2 } })]);
    await expect(provider.getPlaylist({ ...playlist, itemCount: 2 })).rejects.toMatchObject({
      code: "YOUTUBE_PLAYLIST_CHANGED", status: 409,
    });
  });

  it("allows unknown counts and preserves repeated videos with distinct occurrences", async () => {
    const { provider } = fixture([json({ items: [apiItem(0, "same-video"), apiItem(1, "same-video")] })]);
    const result = await provider.getPlaylist({ ...playlist, itemCount: null });
    expect(result.entries.map((entry) => entry.id)).toEqual(["item-0", "item-1"]);
    expect(result.entries.map((entry) => entry.mediaId)).toEqual(["same-video", "same-video"]);
    expect(result.warnings).toEqual([]);
  });

  it.each([
    { positions: [0, 2], itemCount: 2 },
    { positions: [1, 2], itemCount: 2 },
    { positions: [2], itemCount: 1 },
    { positions: [0, 3, 2], itemCount: null },
  ])("rejects position gaps or a missing zero position despite matching totals: $positions", async ({ positions, itemCount }) => {
    const { provider } = fixture([json({
      items: positions.map(position => apiItem(position)),
      pageInfo: { totalResults: positions.length },
    })]);
    await expect(provider.getPlaylist({ ...playlist, itemCount })).rejects.toMatchObject({
      code: "YOUTUBE_PLAYLIST_CHANGED", status: 409, message: expect.stringContaining("positions"),
    });
  });

  it("checks contiguity across pages rather than renumbering missing occurrences", async () => {
    const { provider } = fixture([
      json({ items: [apiItem(0)], nextPageToken: "second", pageInfo: { totalResults: 2 } }),
      json({ items: [apiItem(2)], pageInfo: { totalResults: 2 } }),
    ]);
    await expect(provider.getPlaylist({ ...playlist, itemCount: 2 })).rejects.toMatchObject({
      code: "YOUTUBE_PLAYLIST_CHANGED", status: 409,
    });
  });

  it("accepts an empty playlist with no positions", async () => {
    const { provider } = fixture([json({ items: [], pageInfo: { totalResults: 0 } })]);
    expect((await provider.getPlaylist({ ...playlist, itemCount: 0 })).entries).toEqual([]);
  });

  it("accepts genuinely empty pages only when items is an array", async () => {
    const { provider } = fixture([json({ items: [], pageInfo: { totalResults: 0 } })]);
    expect(await provider.listPlaylists()).toEqual([]);
  });

  it.each([
    {},
    { items: null },
    { items: {}, nextPageToken: "next" },
    { items: [], nextPageToken: "" },
    { items: [apiPlaylist()], pageInfo: { totalResults: "1" } },
    { items: [{ id: "x", snippet: { title: "missing fields" } }] },
    { items: [{ ...apiPlaylist(), contentDetails: { itemCount: -1 } }] },
  ])("rejects malformed successful playlist payload %#", async (body) => {
    const { provider } = fixture([json(body)]);
    await expect(provider.listPlaylists()).rejects.toMatchObject({ code: "YOUTUBE_RESPONSE_INVALID" });
  });

  it.each([
    {},
    { items: [{ ...apiItem(), snippet: { title: "missing fields" } }] },
    { items: [{ ...apiItem(), id: "" }] },
    { items: [{ ...apiItem(), snippet: { ...apiItem().snippet, position: -1 } }] },
  ])("rejects malformed successful item payload %#", async (body) => {
    const { provider } = fixture([json(body)]);
    await expect(provider.getPlaylist(playlist)).rejects.toMatchObject({ code: "YOUTUBE_RESPONSE_INVALID" });
  });

  it("rejects non-JSON successful responses without exposing their body", async () => {
    const { provider } = fixture([new Response("secret fetch body", { status: 200 })]);
    await expect(provider.listPlaylists()).rejects.toMatchObject({ code: "YOUTUBE_RESPONSE_INVALID" });
  });

  it("detects repeated continuation tokens", async () => {
    const { provider, fetcher } = fixture([
      json({ items: [apiItem()], nextPageToken: "loop" }),
      json({ items: [apiItem(1)], nextPageToken: "loop" }),
    ]);
    await expect(provider.getPlaylist(playlist)).rejects.toMatchObject({ code: "YOUTUBE_PAGINATION_LOOP" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rejects mismatched playlist IDs and wrong providers", async () => {
    const { provider, fetcher } = fixture([json({ items: [{
      ...apiItem(),
      snippet: { ...apiItem().snippet, playlistId: "another-list" },
    }] })]);
    await expect(provider.getPlaylist({ ...playlist, provider: "spotify" })).rejects.toMatchObject({ code: "YOUTUBE_PLAYLIST_INVALID" });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(provider.getPlaylist(playlist)).rejects.toMatchObject({ code: "YOUTUBE_RESPONSE_INVALID" });
  });

  it("discovers all 104 playlists when YouTube reports 106 but ends pagination", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const playlists = Array.from({ length: 104 }, (_, index) => apiPlaylist(`list-${index}`, 0));
    const { provider, fetcher } = fixture([
      json({ items: playlists.slice(0, 50), nextPageToken: "page-2", pageInfo: { totalResults: 106 } }),
      json({ items: playlists.slice(50, 100), nextPageToken: "page-3", pageInfo: { totalResults: 106 } }),
      json({ items: playlists.slice(100), pageInfo: { totalResults: 106 } }),
    ]);
    const result = await provider.listPlaylists();
    expect(result.map((item) => item.id)).toEqual(playlists.map((item) => item.id));
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(new URL(String(fetcher.mock.calls[1]?.[0])).searchParams.get("pageToken")).toBe("page-2");
    expect(new URL(String(fetcher.mock.calls[2]?.[0])).searchParams.get("pageToken")).toBe("page-3");
    expect(warning).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(
      "104 distinct playlists; pageInfo.totalResults reported 106",
    ));
  });

  it("follows continuation tokens even when discovery totals undercount or change", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { provider, fetcher } = fixture([
      json({ items: [apiPlaylist("first")], nextPageToken: "next", pageInfo: { totalResults: 1 } }),
      json({ items: [apiPlaylist("second")], pageInfo: { totalResults: 3 } }),
    ]);
    expect((await provider.listPlaylists()).map((item) => item.id)).toEqual(["first", "second"]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(warning).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("reported 1, 3"));
  });

  it("accepts an empty final discovery result despite a nonzero reported total", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { provider } = fixture([json({ items: [], pageInfo: { totalResults: 2 } })]);
    expect(await provider.listPlaylists()).toEqual([]);
    expect(warning).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("0 distinct playlists"));
  });

  it("still refuses duplicate playlist IDs across pages even when the total agrees", async () => {
    const { provider } = fixture([
      json({ items: [apiPlaylist()], nextPageToken: "next", pageInfo: { totalResults: 2 } }),
      json({ items: [apiPlaylist()], pageInfo: { totalResults: 2 } }),
    ]);
    await expect(provider.listPlaylists()).rejects.toMatchObject({ code: "YOUTUBE_PLAYLISTS_CHANGED" });
  });

  it("still rejects repeated discovery continuation tokens", async () => {
    const { provider, fetcher } = fixture([
      json({ items: [apiPlaylist("first")], nextPageToken: "loop", pageInfo: { totalResults: 100 } }),
      json({ items: [apiPlaylist("second")], nextPageToken: "loop", pageInfo: { totalResults: 100 } }),
    ]);
    await expect(provider.listPlaylists()).rejects.toMatchObject({ code: "YOUTUBE_PAGINATION_LOOP" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe("YouTubeProvider failures and retry policy", () => {
  it("fails quota 403 terminally and redacts API messages", async () => {
    const { provider, fetcher, sleep } = fixture([json({
      error: { message: "secret-google-client-config", errors: [{ reason: "quotaExceeded", message: "secret-access-token" }] },
    }, 403)]);
    await expect(provider.listPlaylists()).rejects.toMatchObject({
      code: "YOUTUBE_QUOTA",
      message: expect.stringContaining("quota is exhausted"),
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it.each([
    [401, "YOUTUBE_UNAUTHORIZED"],
    [403, "YOUTUBE_FORBIDDEN"],
    [404, "YOUTUBE_NOT_FOUND"],
    [400, "YOUTUBE_REQUEST_FAILED"],
  ])("reports HTTP %i safely without retrying", async (httpStatus, code) => {
    const { provider, fetcher } = fixture([json({ error: { message: "secret-google-client-config" } }, httpStatus as number)]);
    const error = await provider.listPlaylists().catch((value: unknown) => value);
    expect(error).toMatchObject({ code });
    expect(String(error)).not.toContain("secret");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("retries 429/5xx with bounded Retry-After and exponential fallback", async () => {
    const { provider, sleep, fetcher } = fixture([
      json({ error: "limited" }, 429, { "Retry-After": "30" }),
      json({ error: "busy" }, 503),
      json({ error: "busy" }, 500, { "Retry-After": "2" }),
      json({ items: [] }),
    ]);
    expect(await provider.listPlaylists()).toEqual([]);
    expect(sleep.mock.calls).toEqual([[30_000], [2000], [2000]]);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it.each(["rateLimitExceeded", "userRateLimitExceeded"])("retries transient 403 reason %s with Retry-After", async (reason) => {
    const { provider, sleep, fetcher } = fixture([
      json({ error: { message: "private response details", errors: [{ reason }] } }, 403, { "Retry-After": "2" }),
      json({ items: [] }),
    ]);
    expect(await provider.listPlaylists()).toEqual([]);
    expect(sleep.mock.calls).toEqual([[2000]]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each(["rateLimitExceeded", "userRateLimitExceeded"])("bounds retries for repeated transient 403 reason %s", async (reason) => {
    const { provider, sleep, fetcher } = fixture(Array.from({ length: 4 }, () =>
      json({ error: { message: "private response details", errors: [{ reason }] } }, 403)));
    const error = await provider.listPlaylists().catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "YOUTUBE_RETRY_EXHAUSTED" });
    expect(String(error)).not.toContain("private response details");
    expect(sleep.mock.calls).toEqual([[1000], [2000], [4000]]);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("does not retry quota exhaustion even when transient rate-limit reasons are also present", async () => {
    const { provider, sleep, fetcher } = fixture([json({
      error: { errors: [{ reason: "userRateLimitExceeded" }, { reason: "quotaExceeded" }] },
    }, 403)]);
    await expect(provider.listPlaylists()).rejects.toMatchObject({ code: "YOUTUBE_QUOTA" });
    expect(sleep).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("never retries a transient 403 earlier than an over-budget Retry-After", async () => {
    const { provider, sleep, fetcher } = fixture([json({
      error: { errors: [{ reason: "rateLimitExceeded" }] },
    }, 403, { "Retry-After": "31" })]);
    await expect(provider.listPlaylists()).rejects.toMatchObject({ code: "YOUTUBE_RETRY_LATER" });
    expect(sleep).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["0", 0],
    ["1", 1000],
    ["29.5", 29_500],
    ["30", 30_000],
    ["Thu, 01 Jan 2026 00:00:05 GMT", 5000],
    ["Thu, 01 Jan 2026 00:00:30 GMT", 30_000],
  ])("honors a within-budget Retry-After exactly: %s", async (retryAfter, delay) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const { provider, sleep, fetcher } = fixture([
      json({}, 429, { "Retry-After": retryAfter }),
      json({ items: [] }),
    ]);
    await provider.listPlaylists();
    expect(sleep.mock.calls).toEqual([[delay]]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([
    [429, "31"],
    [503, "30.001"],
    [429, "999999"],
    [503, "9".repeat(400)],
    [429, "Thu, 01 Jan 2026 00:00:31 GMT"],
    [503, "Thu, 31 Dec 2099 23:59:59 GMT"],
  ])("stops without an early retry for HTTP %i Retry-After beyond budget: %s", async (status, retryAfter) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const { provider, sleep, fetcher } = fixture([
      json({ error: { message: "secret-response-body" } }, status, { "Retry-After": retryAfter }),
      json({ items: [] }),
    ]);
    const error = await provider.listPlaylists().catch((value: unknown) => value);
    expect(error).toMatchObject({
      code: "YOUTUBE_RETRY_LATER",
      status: 503,
      message: "YouTube requested a retry delay longer than this backup's 30-second wait limit. No early retry was sent. Wait for YouTube's rate limit to clear, then retry the backup later.",
    });
    expect(String(error)).not.toContain("secret");
    expect(sleep).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("stops after three retries", async () => {
    const { provider, sleep, fetcher } = fixture(Array.from({ length: 4 }, () => json({ error: "secret" }, 503)));
    await expect(provider.listPlaylists()).rejects.toMatchObject({ code: "YOUTUBE_RETRY_EXHAUSTED" });
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("redacts exceptions from retry scheduling", async () => {
    const { provider, sleep } = fixture([json({}, 429)]);
    sleep.mockRejectedValue(new Error("secret scheduling details"));
    const error = await provider.listPlaylists().catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "YOUTUBE_RETRY_FAILED" });
    expect(String(error)).not.toContain("secret");
  });

  it("redacts supplier and fetch exceptions", async () => {
    const tokenFailure = new YouTubeProvider(async () => { throw new Error("secret-refresh-token"); });
    await expect(tokenFailure.listPlaylists()).rejects.toMatchObject({ code: "YOUTUBE_AUTH_FAILED" });
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("Bearer secret-access-token"));
    const provider = new YouTubeProvider(async () => "token", { fetch: fetcher });
    const error = await provider.listPlaylists().catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "YOUTUBE_NETWORK" });
    expect(String(error)).not.toContain("secret");
  });

  it("bounds a hung request and aborts its fetch signal", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Promise<Response>(() => {}));
    const provider = new YouTubeProvider(async () => "token", { fetch: fetcher });
    const assertion = expect(provider.listPlaylists()).rejects.toMatchObject({ code: "YOUTUBE_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(20_001);
    await assertion;
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });
});


describe("YouTubeProvider.replacePlaylist write-scope safety", () => {
  const target: Playlist = { ...playlist, itemCount: 1 };
  const newEntry = {
    id: "new", position: 0, mediaId: "new-video", title: "New", artist: null, album: null,
    url: null, availability: "available" as const, addedAt: null, providerData: {},
  };

  it("fails closed without attempting any request when no write-scope credential is configured", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const provider = new YouTubeProvider(async () => "read-token", { fetch: fetcher });
    await expect(provider.replacePlaylist(target, [newEntry])).rejects.toMatchObject({ code: "YOUTUBE_WRITE_NOT_AUTHORIZED" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("still rejects unavailable entries before any write is attempted", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const provider = new YouTubeProvider(async () => "read-token", { fetch: fetcher, writeAccessToken: async () => "write-token" });
    const unavailable = { ...newEntry, mediaId: null, availability: "unavailable" as const };
    await expect(provider.replacePlaylist(target, [unavailable])).rejects.toMatchObject({ code: "YOUTUBE_ENTRY_UNSUPPORTED" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects an unavailable entry that still retains a video ID, instead of writing a private/deleted placeholder", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const provider = new YouTubeProvider(async () => "read-token", { fetch: fetcher, writeAccessToken: async () => "write-token" });
    const staleUnavailable = { ...newEntry, mediaId: "stale-video", availability: "unavailable" as const };
    await expect(provider.replacePlaylist(target, [staleUnavailable])).rejects.toMatchObject({ code: "YOUTUBE_ENTRY_UNSUPPORTED" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("includes part=snippet on every insert and authenticates mutations with the write-scope token", async () => {
    const fetcher = vi.fn<typeof fetch>();
    fetcher.mockResolvedValueOnce(json({ items: [apiItem(0, "old-video")], pageInfo: { totalResults: 1 } }));
    fetcher.mockResolvedValueOnce(json({ id: "inserted-1" }));
    fetcher.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const writeSupplier = vi.fn(async () => "write-token");
    const provider = new YouTubeProvider(async () => "read-token", { fetch: fetcher, writeAccessToken: writeSupplier });
    await provider.replacePlaylist(target, [newEntry]);

    const [insertUrl, insertInit] = fetcher.mock.calls[1]!;
    expect(new URL(insertUrl as string | URL).searchParams.get("part")).toBe("snippet");
    expect((insertInit as RequestInit).headers).toMatchObject({ Authorization: "Bearer write-token", "Content-Type": "application/json" });
    expect(JSON.parse((insertInit as RequestInit).body as string)).toMatchObject({
      snippet: { playlistId: "owned-list", resourceId: { kind: "youtube#video", videoId: "new-video" } },
    });

    const [deleteUrl, deleteInit] = fetcher.mock.calls[2]!;
    expect((deleteInit as RequestInit).method).toBe("DELETE");
    expect((deleteInit as RequestInit).headers).toMatchObject({ Authorization: "Bearer write-token" });
    expect(new URL(deleteUrl as string | URL).searchParams.get("id")).toBe("item-0");
    expect(writeSupplier).toHaveBeenCalled();
  });

  it("inserts new entries before deleting previous ones, so a failed insert leaves the playlist intact", async () => {
    const fetcher = vi.fn<typeof fetch>();
    fetcher.mockResolvedValueOnce(json({ items: [apiItem(0, "old-video")], pageInfo: { totalResults: 1 } }));
    fetcher.mockResolvedValueOnce(json({ error: "insert failed" }, 500));
    const provider = new YouTubeProvider(async () => "read-token", {
      fetch: fetcher, writeAccessToken: async () => "write-token", sleep: vi.fn(async () => {}),
    });
    const error = await provider.replacePlaylist(target, [newEntry]).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "YOUTUBE_MUTATION_FAILED" });
    // Only the fresh read and the failed insert happened; no DELETE of the previous items was ever issued.
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "DELETE")).toBe(false);
  });

  it("does not automatically retry a rate-limited or 5xx insert", async () => {
    const fetcher = vi.fn<typeof fetch>();
    fetcher.mockResolvedValueOnce(json({ items: [apiItem(0, "old-video")], pageInfo: { totalResults: 1 } }));
    fetcher.mockResolvedValueOnce(json({ error: "rate limited" }, 429));
    const sleep = vi.fn(async () => {});
    const provider = new YouTubeProvider(async () => "read-token", { fetch: fetcher, writeAccessToken: async () => "write-token", sleep });
    const error = await provider.replacePlaylist(target, [newEntry]).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "YOUTUBE_MUTATION_FAILED" });
    expect(sleep).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not automatically retry a rate-limited or 5xx delete", async () => {
    const fetcher = vi.fn<typeof fetch>();
    fetcher.mockResolvedValueOnce(json({ items: [apiItem(0, "old-video")], pageInfo: { totalResults: 1 } }));
    fetcher.mockResolvedValueOnce(json({ id: "inserted-1" }));
    fetcher.mockResolvedValueOnce(json({ error: "busy" }, 503));
    const sleep = vi.fn(async () => {});
    const provider = new YouTubeProvider(async () => "read-token", { fetch: fetcher, writeAccessToken: async () => "write-token", sleep });
    const error = await provider.replacePlaylist(target, [newEntry]).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "YOUTUBE_MUTATION_FAILED" });
    expect(sleep).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("rejects an unconfirmed insert response instead of silently assuming success", async () => {
    const fetcher = vi.fn<typeof fetch>();
    fetcher.mockResolvedValueOnce(json({ items: [apiItem(0, "old-video")], pageInfo: { totalResults: 1 } }));
    fetcher.mockResolvedValueOnce(json({ notAnId: true }));
    const provider = new YouTubeProvider(async () => "read-token", { fetch: fetcher, writeAccessToken: async () => "write-token" });
    const error = await provider.replacePlaylist(target, [newEntry]).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "YOUTUBE_INSERT_UNCONFIRMED" });
    expect(fetcher.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "DELETE")).toBe(false);
  });

  it("still retries transient failures for ordinary reads (listPlaylists/getPlaylist)", async () => {
    const { provider, sleep, fetcher } = fixture([
      json({ error: "busy" }, 503),
      json({ items: [] }),
    ]);
    expect(await provider.listPlaylists()).toEqual([]);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
