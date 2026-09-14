import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config.js";

const mocks = vi.hoisted(() => ({
  createApp: vi.fn(),
  release: vi.fn(),
  delay: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({ access: vi.fn(async () => {}) }));
vi.mock("node:util", () => ({
  parseArgs: () => ({ values: { demo: true }, positionals: ["serve"] }),
}));
vi.mock("node:timers/promises", () => ({ setTimeout: mocks.delay }));
vi.mock("../src/auth/google.js", () => ({ GoogleAuth: class {} }));
vi.mock("../src/core/backup.js", () => ({
  recoverInterruptedBackups: vi.fn(async () => {}),
  runBackup: vi.fn(),
}));
vi.mock("../src/runtime-lock.js", () => ({
  acquireRuntimeLocks: vi.fn(async () => mocks.release),
}));
vi.mock("../src/server/app.js", () => ({ createApp: mocks.createApp }));
vi.mock("../src/services/retention.js", () => ({ RetentionController: class {} }));
vi.mock("../src/config.js", () => ({
  loadConfig: (): AppConfig => ({
    demo: true, port: 8787, baseUrl: "http://127.0.0.1:8787",
    redirectUri: "http://127.0.0.1:8787/auth/google/callback",
    dataDirectory: "synthetic-data", backupDirectory: "synthetic-backups",
    credentialsFile: "unused-client.json", tokenFile: "unused-tokens.json", webDirectory: "synthetic-web",
  }),
}));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

let originalExitCode: typeof process.exitCode;
beforeEach(() => {
  vi.resetModules();
  mocks.createApp.mockReset();
  mocks.release.mockReset();
  mocks.delay.mockReset();
  originalExitCode = process.exitCode;
  vi.spyOn(process, "loadEnvFile").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
});

async function startServer(initiallyBusy = false) {
  const signals = new Map<string, () => void>();
  const ready = deferred();
  const delayed = deferred();
  const resume = deferred();
  const stoppingRetention = deferred();
  const finishRetention = deferred();
  const released = deferred();
  const failed = deferred();
  const order: string[] = [];
  let busy = initiallyBusy;
  let drained!: (error?: Error) => void;
  const server = {
    once: vi.fn((event: string, listener: () => void) => {
      if (event === "listening") queueMicrotask(listener);
      return server;
    }),
    close: vi.fn((callback: (error?: Error) => void) => {
      order.push("close");
      drained = callback;
    }),
  };
  const isBusy = vi.fn(() => {
    order.push("isBusy");
    return busy;
  });
  const stopRetention = vi.fn(async () => {
    order.push("stopRetention");
    stoppingRetention.resolve();
    await finishRetention.promise;
  });
  mocks.createApp.mockReturnValue({ app: { listen: () => server }, isBusy, stopRetention });
  mocks.delay.mockImplementation(() => {
    delayed.resolve();
    return resume.promise;
  });
  mocks.release.mockImplementation(async () => {
    order.push("release");
    released.resolve();
  });
  const originalOn = process.on;
  vi.spyOn(process, "on").mockImplementation((event, listener) => {
    if (event === "SIGINT" || event === "SIGTERM") {
      signals.set(event, listener);
      if (signals.size === 2) ready.resolve();
      return process;
    }
    return originalOn.call(process, event, listener);
  });
  const errorLog = vi.spyOn(console, "error").mockImplementation(() => { failed.resolve(); });
  await import("../src/cli.js");
  await ready.promise;
  return {
    server, isBusy, stopRetention, errorLog, order, delayed, resume, stoppingRetention, finishRetention, released, failed,
    signal: (signal: "SIGINT" | "SIGTERM") => signals.get(signal)!(),
    drain: (error?: Error) => drained(error),
    setBusy: (value: boolean) => { busy = value; },
  };
}

describe("CLI server shutdown", () => {
  it.each([false, true])("drains HTTP before checking reservations and holds locks for detached work (initially busy: %s)", async (initiallyBusy) => {
    const shutdown = await startServer(initiallyBusy);
    shutdown.signal("SIGINT");
    shutdown.signal("SIGTERM");
    expect(shutdown.server.close).toHaveBeenCalledTimes(1);
    expect(shutdown.isBusy).not.toHaveBeenCalled();
    expect(shutdown.stopRetention).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();

    // An already accepted request reserves a backup during drain; its 202 does not finish the job.
    shutdown.setBusy(true);
    shutdown.drain();
    await shutdown.delayed.promise;
    expect(mocks.delay).toHaveBeenCalledWith(250);
    expect(shutdown.stopRetention).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
    shutdown.signal("SIGTERM");
    shutdown.setBusy(false);
    shutdown.resume.resolve();
    await shutdown.stoppingRetention.promise;
    expect(mocks.release).not.toHaveBeenCalled();
    shutdown.finishRetention.resolve();
    await shutdown.released.promise;
    shutdown.signal("SIGINT");
    expect(shutdown.server.close).toHaveBeenCalledTimes(1);
    expect(shutdown.stopRetention).toHaveBeenCalledTimes(1);
    expect(mocks.release).toHaveBeenCalledTimes(1);
    expect(shutdown.order[0]).toBe("close");
    expect(shutdown.order.slice(-2)).toEqual(["stopRetention", "release"]);
    expect(shutdown.errorLog).not.toHaveBeenCalled();
  });

  it("stops an idle server without waiting for a nonexistent reservation", async () => {
    const shutdown = await startServer();
    shutdown.finishRetention.resolve();
    shutdown.signal("SIGTERM");
    shutdown.drain();
    await shutdown.released.promise;
    expect(mocks.delay).not.toHaveBeenCalled();
    expect(shutdown.order).toEqual(["close", "isBusy", "isBusy", "stopRetention", "release"]);
  });

  it.each(["close", "retention"] as const)("reports a %s failure without releasing locks or repeating shutdown", async (stage) => {
    const shutdown = await startServer();
    const error = new Error(`Synthetic ${stage} failure`);
    if (stage === "retention") shutdown.stopRetention.mockRejectedValueOnce(error);
    shutdown.signal("SIGINT");
    shutdown.drain(stage === "close" ? error : undefined);
    await shutdown.failed.promise;
    shutdown.signal("SIGTERM");
    expect(shutdown.errorLog).toHaveBeenCalledExactlyOnceWith(`Shutdown failed: Synthetic ${stage} failure`);
    expect(process.exitCode).toBe(1);
    expect(mocks.release).not.toHaveBeenCalled();
    expect(shutdown.server.close).toHaveBeenCalledTimes(1);
    if (stage === "close") {
      expect(shutdown.isBusy).not.toHaveBeenCalled();
      expect(shutdown.stopRetention).not.toHaveBeenCalled();
    } else {
      expect(shutdown.stopRetention).toHaveBeenCalledTimes(1);
    }
  });
});
