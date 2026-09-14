import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { test as base, expect } from "@playwright/test";
import { loadConfig } from "../src/config.js";
import { DemoProvider } from "../src/providers/demo.js";
import { createApp } from "../src/server/app.js";
import { AppError } from "../src/core/errors.js";

interface SyntheticAuth {
  configured: boolean;
  connected: boolean;
  error: AppError | null;
  beginCalls: number;
  completeCalls: number;
}

const test = base.extend<{ serverUrl: string; demoMode: boolean; auth: SyntheticAuth }>({
  demoMode: [true, { option: true }],
  auth: async ({}, use) => {
    await use({ configured: true, connected: false, error: null, beginCalls: 0, completeCalls: 0 });
  },
  serverUrl: async ({ demoMode, auth }, use) => {
    const directory = await mkdtemp(path.join(process.cwd(), "music-browser-test-"));
    const config = loadConfig({ demo: demoMode }, {
      MUSIC_DATA_DIR: path.join(directory, "data"),
      MUSIC_BACKUP_DIR: path.join(directory, "backups"),
    });
    const requireRealMode = () => {
      if (demoMode) throw new Error("Demo must not use Google.");
    };
    const { app, stopRetention } = createApp({
      config,
      provider: new DemoProvider(),
      auth: {
        status: async () => {
          requireRealMode();
          if (auth.error) throw auth.error;
          return { configured: auth.configured, connected: auth.connected };
        },
        begin: async () => {
          requireRealMode();
          auth.beginCalls += 1;
          if (!auth.configured) throw new AppError("GOOGLE_CONFIG_INVALID", "Supply a valid Desktop app client.", 400);
          return {
            url: `${config.baseUrl}/auth/google/callback?state=synthetic-state&code=synthetic-code`,
            state: "synthetic-state", codeVerifier: "synthetic-verifier",
          };
        },
        complete: async (code, verifier) => {
          requireRealMode();
          expect(code).toBe("synthetic-code");
          expect(verifier).toBe("synthetic-verifier");
          auth.completeCalls += 1;
          auth.connected = true;
          auth.error = null;
        },
        disconnect: async () => {
          requireRealMode();
          auth.connected = false;
        },
      },
    });
    const server = app.listen(0, "127.0.0.1");
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Test listener has no port.");
      config.port = address.port;
      config.baseUrl = `http://127.0.0.1:${address.port}`;
      config.redirectUri = `${config.baseUrl}/auth/google/callback`;
      await use(config.baseUrl);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await stopRetention();
      await rm(directory, { recursive: true, force: true });
    }
  },
});

test.describe("recoverable local authorization", () => {
  test.use({ demoMode: false });

  test("malformed tokens preserve an actionable error and allow a CSRF-protected reconnect", async ({ page, serverUrl, auth }) => {
    auth.error = new AppError("GOOGLE_TOKEN_INVALID", "The local Google token file is malformed. Reconnect Google.", 401);
    const inventoryReads: string[] = [];
    page.on("request", (request) => {
      if (request.url().endsWith("/api/playlists")) inventoryReads.push(request.url());
    });
    await page.goto(`${serverUrl}/?authError=Previous%20authorization%20was%20denied.`);
    await expect(page.locator("#connection-error")).toContainText("token file is malformed");
    await expect(page.locator("#notice")).toContainText("Previous authorization was denied");
    await page.getByRole("button", { name: "Dismiss", exact: true }).click();
    await expect(page.locator("#connection-error")).toBeVisible();
    await expect(page.getByRole("button", { name: "Connect Google", exact: true })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Back up all", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Refresh library", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Recheck connection", exact: true }).click();
    await expect(page.getByRole("button", { name: "Connect Google", exact: true })).toBeEnabled();
    await expect(page.locator("#connection-error")).toBeVisible();
    expect(inventoryReads).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
    const connecting = page.waitForRequest((request) => request.url().endsWith("/api/auth/connect"));
    await page.getByRole("button", { name: "Connect Google", exact: true }).click();
    expect((await connecting).headers()["x-csrf-token"]).toBeTruthy();
    await expect(page.locator("#connection-state")).toHaveText("YouTube connected · read-only");
    await expect(page.locator("#connection-error")).toBeHidden();
    await expect(page.locator("#playlist-rows tr")).toHaveCount(4);
    expect(auth.beginCalls).toBe(1);
    expect(auth.completeCalls).toBe(1);
  });

  for (const invalid of [false, true]) {
    test(`${invalid ? "invalid" : "missing"} Desktop configuration can be repaired and rechecked without reloading`, async ({ page, serverUrl, auth }) => {
      auth.configured = false;
      if (invalid) auth.error = new AppError("GOOGLE_CONFIG_INVALID", "Replace the invalid OAuth client file with a Desktop app JSON.", 400);
      const inventoryReads: string[] = [];
      page.on("request", (request) => {
        if (request.url().endsWith("/api/playlists")) inventoryReads.push(request.url());
      });
      await page.goto(serverUrl);
      await expect(page.locator("#setup-steps")).toBeVisible();
      await expect(page.locator("#setup-steps")).toContainText("Recheck connection");
      await expect(page.getByRole("button", { name: "Connect Google", exact: true })).toBeDisabled();
      await expect(page.getByRole("button", { name: "Back up all", exact: true })).toBeDisabled();
      if (invalid) await expect(page.locator("#connection-error")).toContainText("Desktop app JSON");
      await expect(page.getByRole("button", { name: "Recheck connection", exact: true })).toBeEnabled();
      expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
      await page.evaluate(() => { document.body.dataset.testPage = "original"; });
      auth.error = null;
      auth.configured = true;
      await page.getByRole("button", { name: "Recheck connection", exact: true }).click();
      await expect(page.locator("#connection-error")).toBeHidden();
      await expect(page.locator("#setup-steps")).toBeHidden();
      await expect(page.getByRole("button", { name: "Connect Google", exact: true })).toBeEnabled();
      await expect(page.getByRole("button", { name: "Refresh library", exact: true })).toBeDisabled();
      expect(await page.locator("body").getAttribute("data-test-page")).toBe("original");
      expect(inventoryReads).toEqual([]);
      await page.getByRole("button", { name: "Connect Google", exact: true }).click();
      await expect(page.locator("#playlist-rows tr")).toHaveCount(4);
      expect(auth.completeCalls).toBe(1);
    });
  }

  test("unsafe pending credentials stay an explicit failed status with a working retry", async ({ page, serverUrl, auth }) => {
    auth.error = new AppError("GOOGLE_PENDING_CLEANUP_FAILED", "Inspect unsafe pending credential files before retrying.", 500);
    await page.goto(serverUrl);
    await expect(page.locator("#connection-error")).toContainText("Inspect unsafe pending credential files");
    await expect(page.getByRole("button", { name: "Connect Google", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Back up all", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Recheck connection", exact: true })).toBeEnabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
    auth.error = null;
    await page.getByRole("button", { name: "Recheck connection", exact: true }).click();
    await expect(page.locator("#connection-error")).toBeHidden();
    await expect(page.getByRole("button", { name: "Connect Google", exact: true })).toBeEnabled();
    expect(auth.beginCalls).toBe(0);
  });

  test("a failed status recheck clears stale authorization and never loads playlists implicitly on retry", async ({ page, serverUrl, auth }) => {
    auth.connected = true;
    const inventoryReads: string[] = [];
    page.on("request", (request) => {
      if (request.url().endsWith("/api/playlists")) inventoryReads.push(request.url());
    });
    await page.goto(serverUrl);
    await expect(page.locator("#playlist-rows tr")).toHaveCount(4);
    auth.error = new AppError("GOOGLE_PENDING_CLEANUP_FAILED", "Inspect unsafe pending credential files before retrying.", 500);
    await page.getByRole("button", { name: "Recheck cleanup", exact: true }).click();
    await expect(page.locator("#connection-error")).toContainText("Inspect unsafe pending credential files");
    await expect(page.locator("#playlist-rows tr")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Back up all", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Refresh library", exact: true })).toBeDisabled();
    auth.error = null;
    await page.getByRole("button", { name: "Recheck connection", exact: true }).click();
    await expect(page.locator("#connection-error")).toBeHidden();
    await expect(page.getByRole("button", { name: "Refresh library", exact: true })).toBeEnabled();
    expect(inventoryReads).toHaveLength(1);
    await page.getByRole("button", { name: "Refresh library", exact: true }).click();
    await expect(page.locator("#playlist-rows tr")).toHaveCount(4);
    expect(inventoryReads).toHaveLength(2);
  });
});

test("bulk backup ignores the view filter and offers real local downloads", async ({ page, serverUrl }, testInfo) => {
  const exceptions: string[] = [];
  page.on("pageerror", (error) => exceptions.push(error.message));
  await page.goto(serverUrl);
  await expect(page.getByRole("button", { name: "Back up all", exact: true })).toBeEnabled();
  await expect(page.locator("#demo-notice")).toBeVisible();
  await expect(page.locator("#retention-notice")).toContainText("automatically removed 30 days");
  await expect(page.locator("#playlist-rows tr")).toHaveCount(4);
  await page.getByLabel("Find a playlist").fill("Late shift");
  await expect(page.locator("#playlist-rows tr")).toHaveCount(1);
  await page.getByRole("button", { name: "Back up all", exact: true }).click();
  await expect(page.locator("#job-title")).toHaveText("Backup complete", { timeout: 10_000 });
  await expect(page.locator("#job-totals")).toHaveText("4 saved · 0 failed · 18 entries");
  await page.getByLabel("Find a playlist").fill("");
  await expect(page.locator(".history-entry")).toHaveCount(1);
  await expect(page.locator(".history-expiry")).toContainText("Expires");
  const screenshots = process.env["MUSIC_SCREENSHOT_DIR"];
  if (screenshots) {
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({ path: path.join(screenshots, `studio-${testInfo.project.name}.png`), fullPage: true });
  }
  await page.locator(".history-entry summary").click();
  await expect(page.getByRole("link", { name: /^Download JSON for/ })).toHaveCount(4);
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("link", { name: "Download JSON for Late shift", exact: true }).click(),
  ]);
  const downloadPath = await download.path();
  expect(downloadPath).not.toBeNull();
  const contents = JSON.parse(await readFile(downloadPath!, "utf8"));
  expect(contents.schemaVersion).toBe(1);
  expect(contents.entries).toHaveLength(6);
  expect(contents.entries[0].providerData.synthetic).toBe(true);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflow).toBe(false);
  expect(exceptions).toEqual([]);
});

test("empty setup is actionable and cannot start an unauthorized backup", async ({ page, serverUrl }, testInfo) => {
  await page.route("**/api/status", async (route) => {
    const response = await route.fetch();
    const status = await response.json();
    await route.fulfill({ response, json: { ...status, demo: false, configured: false, connected: false } });
  });
  await page.goto(serverUrl);
  await expect(page.getByRole("heading", { name: "Set up your local YouTube connection" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Back up all", exact: true })).toBeDisabled();
  await expect(page.locator("#setup-steps")).toContainText("Desktop app");
  await expect(page.locator("#redirect-uri")).toContainText("127.0.0.1");
  const screenshots = process.env["MUSIC_SCREENSHOT_DIR"];
  if (screenshots) {
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({ path: path.join(screenshots, `setup-${testInfo.project.name}.png`), fullPage: true });
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
});

test("API errors stay explicit and refreshing the inventory recovers", async ({ page, serverUrl }) => {
  let failing = true;
  await page.route("**/api/playlists", async (route) => {
    if (failing) {
      await route.fulfill({ status: 429, json: { error: { code: "YOUTUBE_QUOTA", message: "YouTube quota exhausted. Retry after reset." } } });
    } else {
      await route.continue();
    }
  });
  await page.goto(serverUrl);
  await expect(page.locator("#library-feedback")).toContainText("YouTube quota exhausted");
  await expect(page.locator("#playlist-rows tr")).toHaveCount(0);
  failing = false;
  await page.getByRole("button", { name: "Refresh library", exact: true }).click();
  await expect(page.locator("#playlist-rows tr")).toHaveCount(4);
  await expect(page.locator("#library-feedback")).toBeHidden();
});

test("removal audit records are visible with platform, identity, direction and outcome", async ({ page, serverUrl }) => {
  const removals = [
    {
      runId: "run-1", runStatus: "partial", pairId: "pair-1", platform: "youtube", playlistId: "yt-2",
      itemIdentity: "isrc:USTEST0000001", direction: "right-to-left", sourcePlatform: "spotify",
      timestamp: "2026-09-12T18:30:00.000Z", outcome: "failed", error: "YouTube Music rejected the removal.",
    },
    {
      runId: "run-1", runStatus: "partial", pairId: "pair-1", platform: "spotify", playlistId: "sp-1",
      itemIdentity: "media:spotify-track-abc", direction: "left-to-right", sourcePlatform: "youtube",
      timestamp: "2026-09-12T18:00:00.000Z", outcome: "success", error: null,
    },
  ];
  await page.route("**/api/sync", async (route) => {
    await route.fulfill({ json: { pairs: [], ignores: [], runs: [], removals } });
  });
  await page.route("**/api/sync/removals*", async (route) => {
    await route.fulfill({ json: { removals } });
  });
  await page.goto(serverUrl);
  await page.getByText("Removal audit records", { exact: true }).click();
  await expect(page.locator("#removal-feedback")).toContainText("2 recorded removals");
  const rows = page.locator("#removal-rows tr");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("YouTube Music");
  await expect(rows.nth(0)).toContainText("isrc:USTEST0000001");
  await expect(rows.nth(0)).toContainText("Spotify → YouTube Music");
  await expect(rows.nth(0)).toContainText("Failed");
  await expect(rows.nth(0)).toContainText("YouTube Music rejected the removal.");
  await expect(rows.nth(1)).toContainText("Spotify");
  await expect(rows.nth(1)).toContainText("YouTube Music → Spotify");
  await expect(rows.nth(1)).toContainText("Removed");
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
});

test("an unpaired library cannot trigger a mirror and reports unconfigured sync explicitly", async ({ page, serverUrl }) => {
  await page.goto(serverUrl);
  await expect(page.locator("#sync-feedback")).toContainText("not configured");
  await expect(page.getByRole("button", { name: "Sync Pair", exact: true })).toBeDisabled();
  await expect(page.getByLabel("Pair to synchronize")).toBeDisabled();
  await expect(page.locator("#sync-pairs")).toContainText("No pairs have been confirmed.");
  await page.getByText("Removal audit records", { exact: true }).click();
  await expect(page.locator("#removal-feedback")).toContainText("require a configured synchronization service");
  await expect(page.getByRole("button", { name: "Refresh Removal Records", exact: true })).toBeDisabled();
  await expect(page.locator("#removal-table-wrap")).toBeHidden();
});

test("explicit pairs stay selectable and drive the manual mirror trigger", async ({ page, serverUrl }) => {
  const pair = {
    id: "pair-1",
    left: { provider: "youtube", accountId: "account-1", playlistId: "yt-1" },
    right: { provider: "spotify", accountId: "account-1", playlistId: "sp-1" },
    enabled: true, createdAt: "2026-09-12T17:00:00.000Z", updatedAt: "2026-09-12T17:00:00.000Z",
  };
  const state = {
    pairs: [pair],
    ignores: [{ provider: "spotify", accountId: "account-1", playlistId: "sp-9", reason: "Ambiguous name", createdAt: "2026-09-12T17:00:00.000Z" }],
    runs: [{ id: "run-1", pairId: "pair-1", status: "partial", startedAt: "2026-09-12T18:00:00.000Z", completedAt: "2026-09-12T18:31:00.000Z", message: "One mirrored removal failed." }],
    removals: [],
  };
  await page.route("**/api/sync", async (route) => { await route.fulfill({ json: state }); });
  await page.route("**/api/sync/discover/youtube", async (route) => {
    await route.fulfill({ json: { playlists: [{ provider: "youtube", id: "yt-1", title: "Road Trip", description: "", url: "https://example.test/yt-1", owner: "My Channel", itemCount: 5, visibility: "private" }] } });
  });
  await page.route("**/api/sync/discover/spotify", async (route) => {
    await route.fulfill({ json: { playlists: [{ provider: "spotify", id: "sp-1", title: "Road Trip", description: "", url: "https://example.test/sp-1", owner: "Me", itemCount: 5, visibility: "private" }] } });
  });
  const triggered: unknown[] = [];
  await page.route("**/api/sync/run", async (route) => {
    triggered.push(route.request().postDataJSON());
    await route.fulfill({ json: { run: { ...state.runs[0], status: "complete", message: "Mirrored verified changes." } } });
  });
  await page.goto(serverUrl);
  await expect(page.locator("#sync-pairs")).toContainText('YouTube Music "Road Trip" ↔ Spotify "Road Trip"');
  await expect(page.locator("#sync-pairs .badge")).toHaveText("Active");
  await expect(page.locator("#sync-ignored")).toContainText('Spotify "sp-9"');
  await expect(page.locator("#sync-ignored .badge")).toHaveText("Ignored");
  await page.getByText("Recent sync runs", { exact: true }).click();
  await expect(page.locator("#sync-logs")).toContainText("One mirrored removal failed.");
  await expect(page.getByLabel("Pair to synchronize")).toHaveValue("pair-1");
  await page.getByRole("button", { name: "Sync Pair", exact: true }).click();
  await expect(page.locator("#notice")).toContainText("Synchronization completed.");
  expect(triggered).toEqual([{ pairId: "pair-1" }]);
});
test("Sync all pairs runs every enabled pair sequentially and reports partial failures without stopping", async ({ page, serverUrl }) => {
  const pairA = {
    id: "pair-1",
    left: { provider: "youtube", accountId: "account-1", playlistId: "yt-1" },
    right: { provider: "spotify", accountId: "account-1", playlistId: "sp-1" },
    enabled: true, createdAt: "2026-09-12T17:00:00.000Z", updatedAt: "2026-09-12T17:00:00.000Z",
  };
  const pairB = {
    id: "pair-2",
    left: { provider: "youtube", accountId: "account-1", playlistId: "yt-2" },
    right: { provider: "spotify", accountId: "account-1", playlistId: "sp-2" },
    enabled: true, createdAt: "2026-09-12T17:00:00.000Z", updatedAt: "2026-09-12T17:00:00.000Z",
  };
  const state = { pairs: [pairA, pairB], ignores: [], runs: [], removals: [] };
  await page.route("**/api/sync", async (route) => { await route.fulfill({ json: state }); });
  await page.route("**/api/sync/discover/youtube", async (route) => {
    await route.fulfill({ json: { playlists: [
      { provider: "youtube", id: "yt-1", title: "Road Trip", description: "", url: "https://example.test/yt-1", owner: "My Channel", itemCount: 5, visibility: "private" },
      { provider: "youtube", id: "yt-2", title: "Gym", description: "", url: "https://example.test/yt-2", owner: "My Channel", itemCount: 3, visibility: "private" },
    ] } });
  });
  await page.route("**/api/sync/discover/spotify", async (route) => {
    await route.fulfill({ json: { playlists: [
      { provider: "spotify", id: "sp-1", title: "Road Trip", description: "", url: "https://example.test/sp-1", owner: "Me", itemCount: 5, visibility: "private" },
      { provider: "spotify", id: "sp-2", title: "Gym", description: "", url: "https://example.test/sp-2", owner: "Me", itemCount: 3, visibility: "private" },
    ] } });
  });
  const triggered: unknown[] = [];
  await page.route("**/api/sync/run", async (route) => {
    const body = route.request().postDataJSON() as { pairId: string };
    triggered.push(body);
    if (body.pairId === "pair-1") {
      await route.fulfill({ json: { run: { id: "run-1", pairId: "pair-1", status: "complete", startedAt: "2026-09-14T00:00:00.000Z", completedAt: "2026-09-14T00:01:00.000Z", message: null } } });
    } else {
      await route.fulfill({ status: 404, json: { error: { code: "SYNC_PLAYLIST_NOT_FOUND", message: "The paired youtube playlist was not found in a fresh discovery." } } });
    }
  });
  await page.goto(serverUrl);
  await expect(page.getByRole("button", { name: "Sync all pairs", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Sync all pairs", exact: true }).click();
  await expect(page.locator("#notice")).toContainText("Synchronized 1 of 2 pairs. 1 failed");
  expect(triggered).toEqual([{ pairId: "pair-1" }, { pairId: "pair-2" }]);
});
test("the playlist pickers offer real titles to choose, and auto-pair by name creates exact matches while skipping ambiguous titles", async ({ page, serverUrl }) => {
  const state = { pairs: [], ignores: [], runs: [], removals: [] };
  const youtubePlaylists = [
    { provider: "youtube", id: "yt-road", title: "Road Trip", description: "", url: "https://example.test/yt-road", owner: "My Channel", itemCount: 5, visibility: "private" },
    { provider: "youtube", id: "yt-gym-a", title: "Gym", description: "", url: "https://example.test/yt-gym-a", owner: "My Channel", itemCount: 5, visibility: "private" },
    { provider: "youtube", id: "yt-gym-b", title: "Gym", description: "", url: "https://example.test/yt-gym-b", owner: "My Channel", itemCount: 5, visibility: "private" },
    { provider: "youtube", id: "yt-solo", title: "Only On YouTube", description: "", url: "https://example.test/yt-solo", owner: "My Channel", itemCount: 5, visibility: "private" },
  ];
  const spotifyPlaylists = [
    { provider: "spotify", id: "sp-road", title: "Road Trip", description: "", url: "https://example.test/sp-road", owner: "Me", itemCount: 5, visibility: "private" },
    { provider: "spotify", id: "sp-gym-a", title: "Gym", description: "", url: "https://example.test/sp-gym-a", owner: "Me", itemCount: 5, visibility: "private" },
  ];
  const created: unknown[] = [];
  await page.route("**/api/sync", async (route) => { await route.fulfill({ json: state }); });
  await page.route("**/api/sync/discover/youtube", async (route) => { await route.fulfill({ json: { playlists: youtubePlaylists } }); });
  await page.route("**/api/sync/discover/spotify", async (route) => { await route.fulfill({ json: { playlists: spotifyPlaylists } }); });
  await page.route("**/api/sync/pairs", async (route) => {
    if (route.request().method() !== "POST") { await route.fallback(); return; }
    const body = route.request().postDataJSON();
    created.push(body);
    const pair = { id: `pair-${created.length}`, ...body, enabled: true, createdAt: "2026-09-14T00:00:00.000Z", updatedAt: "2026-09-14T00:00:00.000Z" };
    state.pairs = [...state.pairs, pair] as never;
    await route.fulfill({ status: 201, json: state });
  });
  await page.goto(serverUrl);
  const form = page.locator("#pair-form");
  const firstPlaylistSelect = form.getByLabel("First playlist", { exact: true });
  await expect(async () => {
    expect(await firstPlaylistSelect.locator("option").allTextContents())
      .toEqual(["Choose a playlist…", "Road Trip (5)", "Gym (5)"]);
  }).toPass();
  await page.getByRole("button", { name: "Auto-pair by name", exact: true }).click();
  await expect(page.locator("#notice")).toContainText("Auto-paired 1 playlist by matching name.");
  await expect(page.locator("#notice")).toContainText('Skipped 1 ambiguous title: Gym.');
  expect(created).toEqual([{
    left: { provider: "youtube", accountId: "My Channel", playlistId: "yt-road" },
    right: { provider: "spotify", accountId: "Me", playlistId: "sp-road" },
  }]);
});
test("ignoring a playlist submits the ignore form and reflects it in the ignored list", async ({ page, serverUrl }) => {
  const initialState = {
    pairs: [],
    ignores: [],
    runs: [],
    removals: [],
  };
  let ignored: unknown[] = [];
  await page.route("**/api/sync", async (route) => { await route.fulfill({ json: initialState }); });
  await page.route("**/api/sync/discover/spotify", async (route) => {
    await route.fulfill({ json: { playlists: [{ provider: "spotify", id: "sp-42", title: "Duplicate mix", description: "", url: "https://example.test/sp-42", owner: "acct-1", itemCount: 8, visibility: "private" }] } });
  });
  await page.route("**/api/sync/ignored", async (route) => {
    if (route.request().method() !== "POST") { await route.fallback(); return; }
    ignored.push(route.request().postDataJSON());
    await route.fulfill({
      status: 201,
      json: {
        ...initialState,
        ignores: [{ provider: "spotify", accountId: "acct-1", playlistId: "sp-42", reason: "Duplicate mix", createdAt: "2026-09-13T00:00:00.000Z" }],
      },
    });
  });
  await page.goto(serverUrl);
  const form = page.locator("#ignore-form");
  await form.getByLabel("Platform", { exact: true }).selectOption("spotify");
  await form.getByLabel("Playlist", { exact: true }).selectOption("sp-42");
  await form.getByLabel("Reason (optional)").fill("Duplicate mix");
  await form.getByRole("button", { name: "Ignore playlist", exact: true }).click();
  await expect(page.locator("#sync-ignored")).toContainText('Spotify "Duplicate mix"');
  await expect(page.locator("#sync-ignored")).toContainText("Duplicate mix");
  expect(ignored).toEqual([{ provider: "spotify", accountId: "acct-1", playlistId: "sp-42", reason: "Duplicate mix" }]);
});
test("removing a pair updates the removal audit list immediately without a manual refresh", async ({ page, serverUrl }) => {
  const pair = {
    id: "pair-1",
    left: { provider: "youtube", accountId: "account-1", playlistId: "yt-1" },
    right: { provider: "spotify", accountId: "account-1", playlistId: "sp-1" },
    enabled: true, createdAt: "2026-09-12T17:00:00.000Z", updatedAt: "2026-09-12T17:00:00.000Z",
  };
  const removal = {
    runId: "run-1", runStatus: "complete", pairId: "pair-1", platform: "spotify", playlistId: "sp-1",
    itemIdentity: "media:spotify-track-abc", direction: "left-to-right", sourcePlatform: "youtube",
    timestamp: "2026-09-12T18:00:00.000Z", outcome: "success", error: null,
  };
  let deleted = false;
  await page.route("**/api/sync", async (route) => {
    await route.fulfill({ json: { pairs: deleted ? [] : [pair], ignores: [], runs: [], removals: [removal] } });
  });
  const removalRequests: string[] = [];
  await page.route("**/api/sync/removals*", async (route) => {
    removalRequests.push(route.request().url());
    await route.fulfill({ json: { removals: [removal] } });
  });
  await page.route("**/api/sync/pairs/pair-1", async (route) => {
    deleted = true;
    await route.fulfill({ json: { pairs: [], ignores: [], runs: [], removals: [] } });
  });
  await page.goto(serverUrl);
  await page.getByText("Removal audit records", { exact: true }).click();
  await expect(page.locator("#removal-rows tr")).toHaveCount(1);
  const requestsBeforeRemoval = removalRequests.length;
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(page.locator("#sync-pairs")).toContainText("No pairs have been confirmed.");
  await expect(page.locator("#removal-rows tr")).toHaveCount(0);
  expect(removalRequests.length).toBe(requestsBeforeRemoval);
});

test("a persisted failed sync run is worded distinctly from a run that never started", async ({ page, serverUrl }) => {
  const pair = {
    id: "pair-1",
    left: { provider: "youtube", accountId: "account-1", playlistId: "yt-1" },
    right: { provider: "spotify", accountId: "account-1", playlistId: "sp-1" },
    enabled: true, createdAt: "2026-09-12T17:00:00.000Z", updatedAt: "2026-09-12T17:00:00.000Z",
  };
  const state = { pairs: [pair], ignores: [], runs: [], removals: [] };
  await page.route("**/api/sync", async (route) => { await route.fulfill({ json: state }); });
  await page.route("**/api/sync/removals*", async (route) => { await route.fulfill({ json: { removals: [] } }); });
  let runCall = 0;
  await page.route("**/api/sync/run", async (route) => {
    runCall += 1;
    if (runCall === 1) {
      await route.fulfill({
        status: 409,
        json: { error: { code: "SYNC_BUSY", message: "Another sync run is already in progress." } },
      });
    } else {
      await route.fulfill({
        status: 502,
        json: { error: { code: "YOUTUBE_MUSIC_UNAVAILABLE", message: "YouTube Music rejected the mirrored write." } },
      });
    }
  });
  await page.goto(serverUrl);
  await page.getByRole("button", { name: "Sync Pair", exact: true }).click();
  await expect(page.locator("#notice")).toContainText("Synchronization did not start.");
  await expect(page.locator("#notice")).not.toContainText("recorded");
  await page.getByRole("button", { name: "Sync Pair", exact: true }).click();
  await expect(page.locator("#notice")).toContainText("Synchronization failed.");
  await expect(page.locator("#notice")).toContainText("recorded");
});

test("removal filters submit platform, playlist, identity, direction and outcome as query parameters", async ({ page, serverUrl }) => {
  const pair = {
    id: "pair-1",
    left: { provider: "youtube", accountId: "account-1", playlistId: "yt-1" },
    right: { provider: "spotify", accountId: "account-1", playlistId: "sp-1" },
    enabled: true, createdAt: "2026-09-12T17:00:00.000Z", updatedAt: "2026-09-12T17:00:00.000Z",
  };
  await page.route("**/api/sync", async (route) => {
    await route.fulfill({ json: { pairs: [pair], ignores: [], runs: [], removals: [] } });
  });
  const removalRequests: string[] = [];
  await page.route("**/api/sync/removals*", async (route) => {
    removalRequests.push(route.request().url());
    await route.fulfill({ json: { removals: [] } });
  });
  await page.goto(serverUrl);
  await page.getByText("Removal audit records", { exact: true }).click();
  await page.locator("#removal-filter-platform").selectOption("spotify");
  await page.locator("#removal-filter-playlist").fill("sp-1");
  await page.locator("#removal-filter-identity").fill("track-abc");
  await page.locator("#removal-filter-direction").selectOption("left-to-right");
  await page.locator("#removal-filter-outcome").selectOption("success");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect.poll(() => removalRequests.at(-1)).toContain("platform=spotify");
  const lastUrl = new URL(removalRequests.at(-1)!);
  expect(lastUrl.searchParams.get("playlistId")).toBe("sp-1");
  expect(lastUrl.searchParams.get("itemIdentity")).toBe("track-abc");
  expect(lastUrl.searchParams.get("direction")).toBe("left-to-right");
  expect(lastUrl.searchParams.get("outcome")).toBe("success");
  await page.getByRole("button", { name: "Clear filters", exact: true }).click();
  await expect.poll(() => removalRequests.at(-1)).not.toContain("platform=");
});


test("cleanup warnings remain visible and an explicit recheck recovers", async ({ page, serverUrl }) => {
  let cleanupFailed = true;
  let rechecked = false;
  await page.route("**/api/status", async (route) => {
    const response = await route.fetch();
    const status = await response.json();
    await route.fulfill({
      response,
      json: {
        ...status,
        retention: { ...status.retention, error: cleanupFailed ? "Unexpected user files in expired backup." : null },
      },
    });
  });
  await page.route("**/api/retention/check", async (route) => {
    expect(route.request().method()).toBe("POST");
    expect(route.request().headers()["x-csrf-token"]).toBeTruthy();
    rechecked = true;
    cleanupFailed = false;
    await route.continue();
  });
  await page.goto(serverUrl);
  await expect(page.locator("#retention-warning")).toContainText("Unexpected user files");
  await expect(page.locator("#retention-warning")).toContainText("Check local file permissions");
  await page.getByRole("button", { name: "Recheck cleanup", exact: true }).click();
  await expect(page.locator("#retention-warning")).toBeHidden();
  expect(rechecked).toBe(true);
});
