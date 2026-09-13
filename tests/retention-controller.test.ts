import { afterEach, describe, expect, it, vi } from "vitest";
import { RetentionController } from "../src/services/retention.js";
import { pruneExpiredBackups } from "../src/core/retention.js";

vi.mock("../src/core/retention.js", () => ({
  RETENTION_DAYS: 30,
  pruneExpiredBackups: vi.fn(),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe("rolling retention scheduler", () => {
  it("runs on start, once per minute and stops cleanly", async () => {
    vi.useFakeTimers();
    vi.mocked(pruneExpiredBackups).mockResolvedValue({ deleted: [], warnings: [] });
    const onCheck = vi.fn();
    const controller = new RetentionController("test-only", onCheck);
    controller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(pruneExpiredBackups).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(pruneExpiredBackups).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(pruneExpiredBackups).toHaveBeenCalledTimes(2);
    expect(onCheck).toHaveBeenCalledTimes(2);
    await controller.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(pruneExpiredBackups).toHaveBeenCalledTimes(2);
    expect(controller.status()).toMatchObject({ days: 30, automatic: true, error: null });
  });

  it("serializes concurrent checks and exposes cleanup failures until recovery", async () => {
    let finish!: (value: { deleted: string[]; warnings: string[] }) => void;
    vi.mocked(pruneExpiredBackups).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const controller = new RetentionController("test-only");
    const first = controller.check(true);
    const second = controller.check(true);
    expect(pruneExpiredBackups).toHaveBeenCalledTimes(1);
    finish({ deleted: [], warnings: ["Unexpected user files; cleanup skipped."] });
    await Promise.all([first, second]);
    expect(controller.status().error).toContain("cleanup skipped");
    vi.mocked(pruneExpiredBackups).mockResolvedValue({ deleted: [], warnings: [] });
    await controller.check(true);
    expect(controller.status().error).toBeNull();
    vi.mocked(pruneExpiredBackups).mockRejectedValue(new Error("Permission denied"));
    await controller.check(true);
    expect(controller.status().error).toContain("Permission denied");
    await controller.stop();
  });
});
