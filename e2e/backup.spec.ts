import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test as base, expect } from "@playwright/test";
import { loadConfig } from "../src/config.js";
import { DemoProvider } from "../src/providers/demo.js";
import { createApp } from "../src/server/app.js";

const test = base.extend<{ serverUrl: string }>({
  serverUrl: async ({}, use) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "music-browser-test-"));
    const config = loadConfig({ demo: true }, {
      MUSIC_DATA_DIR: path.join(directory, "data"),
      MUSIC_BACKUP_DIR: path.join(directory, "backups"),
    });
    const unusedAuth = async (): Promise<never> => { throw new Error("Demo must not use Google."); };
    const { app, stopRetention } = createApp({
      config,
      provider: new DemoProvider(),
      auth: { status: unusedAuth, begin: unusedAuth, complete: unusedAuth, disconnect: unusedAuth },
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
