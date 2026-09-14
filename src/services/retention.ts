import { pruneExpiredBackups, RETENTION_DAYS } from "../core/retention.js";
import { errorMessage } from "../core/errors.js";
import type { StatusResponse } from "../shared/api.js";

export class RetentionController {
  private pending: Promise<void> | null = null;
  private lastCheck = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private snapshot: StatusResponse["retention"] = {
    days: RETENTION_DAYS,
    automatic: true,
    lastCheckedAt: null,
    error: null,
  };

  constructor(
    private readonly directory: string,
    private readonly onCheck: () => void = () => {},
  ) {}

  start(): void {
    if (this.timer) return;
    void this.check();
    this.timer = setInterval(() => { void this.check(); }, 60_000);
    this.timer.unref();
  }

  status(): StatusResponse["retention"] {
    return { ...this.snapshot };
  }

  check(force = false): Promise<void> {
    if (this.pending) return this.pending;
    if (!force && Date.now() - this.lastCheck < 60_000) return Promise.resolve();
    this.pending = this.performCheck().finally(() => { this.pending = null; });
    return this.pending;
  }

  private async performCheck(): Promise<void> {
    try {
      this.onCheck();
      const result = await pruneExpiredBackups(this.directory);
      const error = result.warnings.length > 0 ? result.warnings.join("\n") : null;
      if (error && error !== this.snapshot.error) console.error(`Backup retention needs attention: ${error}`);
      if (result.deleted.length > 0) console.error(`Removed ${result.deleted.length} expired app-managed backup run(s).`);
      this.snapshot.error = error;
    } catch (error) {
      const message = `Expired backups could not be removed: ${errorMessage(error)}`;
      if (message !== this.snapshot.error) console.error(message);
      this.snapshot.error = message;
    }
    this.lastCheck = Date.now();
    this.snapshot.lastCheckedAt = new Date(this.lastCheck).toISOString();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.pending;
  }
}
