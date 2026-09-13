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
