import { rename } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

/** Atomic replacement, not compare-and-swap: callers must exclude competing writers. */
export async function replaceFile(
  source: string, destination: string, beforeAttempt?: () => Promise<void>,
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    if (beforeAttempt) await beforeAttempt();
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      if (process.platform !== "win32" || typeof error !== "object" || error === null
        || !("code" in error) || !["EPERM", "EACCES", "EBUSY"].includes(String(error.code))
        || attempt >= 3) throw error;
      await delay(25 * 2 ** attempt);
    }
  }
}
