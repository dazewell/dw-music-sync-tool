import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import { AppError } from "./errors.js";
import type { SyncIgnore, SyncPair, SyncBaseline, SyncRemovalAudit, SyncRemovalAuditSink } from "./sync.js";
import { replaceFile } from "./replace-file.js";

export interface SyncRun {
  id: string;
  pairId: string;
  status: "running" | "complete" | "partial" | "failed" | "review-required" | "interrupted";
  startedAt: string;
  completedAt: string | null;
  message: string | null;
  removals: SyncRemovalAudit[];
}

export interface SyncState {
  schemaVersion: 1;
  pairs: SyncPair[];
  ignores: SyncIgnore[];
  baselines: Record<string, SyncBaseline>;
  runs: SyncRun[];
}

const ref = z.object({ provider: z.enum(["youtube", "spotify"]), accountId: z.string().min(1), playlistId: z.string().min(1) }).strict();
const pair = z.object({
  id: z.string().min(1), left: ref, right: ref, enabled: z.boolean(),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
}).strict();
const stateSchema = z.object({
  schemaVersion: z.literal(1), pairs: z.array(pair),
  ignores: z.array(ref.extend({ reason: z.string(), createdAt: z.iso.datetime() })),
  baselines: z.record(z.string(), z.object({ sourceFingerprint: z.string(), targetFingerprint: z.string() })),
  runs: z.array(z.object({
    id: z.string(), pairId: z.string(), status: z.enum(["running", "complete", "partial", "failed", "review-required", "interrupted"]),
    startedAt: z.iso.datetime(), completedAt: z.iso.datetime().nullable(), message: z.string().nullable(),
    removals: z.array(z.object({
      pairId: z.string().min(1), platform: z.enum(["youtube", "spotify"]), playlistId: z.string().min(1),
      itemIdentity: z.string().min(1), direction: z.enum(["left-to-right", "right-to-left"]),
      timestamp: z.iso.datetime(), outcome: z.enum(["success", "failed", "unknown"]), error: z.string().nullable(),
    })).default([]),
  })),
}).strict();

const emptyState = (): SyncState => ({ schemaVersion: 1, pairs: [], ignores: [], baselines: {}, runs: [] });

export class SyncStateStore implements SyncRemovalAuditSink {
  private queue: Promise<void> = Promise.resolve();
  private readonly activeRuns = new Set<string>();
  constructor(private readonly filename: string) {}

  /**
   * Reads the durable state without recovering interrupted runs. `activeRuns`
   * is only ever populated in the process that actually started a run, so a
   * plain reporting read (a CLI report, `--removals`, or a dashboard GET) must
   * never treat a run started by *another* process as interrupted - doing so
   * would race that process's in-flight run, marking it review-required and
   * destroying its baseline out from under it. Use this for any read that
   * does not hold the runtime lock for the whole operation.
   */
  async peek(): Promise<SyncState> {
    try {
      const parsed = stateSchema.safeParse(JSON.parse(await fs.readFile(this.filename, "utf8")));
      if (!parsed.success) throw new Error("invalid schema");
      return parsed.data;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return emptyState();
      throw new AppError("SYNC_STATE_INVALID", "The sync state is invalid or unreadable; preserve it for inspection.", 500);
    }
  }

  /**
   * Reads the durable state and recovers any run left `running`/`interrupted`
   * that this process did not itself start, marking it `review-required` and
   * dropping its baseline. Only call this from a path that already holds
   * exclusive access to the state directory for the whole operation (a CLI
   * management option or the long-lived web server process), so recovery
   * never races another process's active run. Reporting-only paths must use
   * `peek()` instead.
   */
  async read(): Promise<SyncState> {
    const state = await this.peek();
    let recovered = false;
    for (const run of state.runs) {
      if (this.activeRuns.has(run.id)) continue;
      if (run.status !== "running" && run.status !== "interrupted") continue;
      run.status = "review-required";
      run.completedAt = new Date().toISOString();
      run.message = "A previous synchronization run was interrupted; review and reconcile both playlists before retrying.";
      delete state.baselines[run.pairId];
      recovered = true;
    }
    if (recovered) await this.write(state);
    return state;
  }

  async update(mutator: (state: SyncState) => void): Promise<SyncState> {
    let result!: SyncState;
    const task = this.queue.then(async () => {
      result = await this.read();
      mutator(result);
      const parsed = stateSchema.safeParse(result);
      if (!parsed.success) throw new AppError("SYNC_STATE_INVALID", "The sync state update is invalid.", 500);
      await this.write(parsed.data);
    });
    this.queue = task.then(() => undefined, () => undefined);
    await task;
    return result;
  }

  async pair(pairing: SyncPair): Promise<SyncState> {
    return this.update(state => {
      const sameRef = (left: SyncPair["left"], right: SyncPair["right"]) =>
        left.provider === right.provider && left.accountId === right.accountId && left.playlistId === right.playlistId;
      const isIgnored = (candidate: SyncPair["left"]) =>
        state.ignores.some(item => item.provider === candidate.provider && item.accountId === candidate.accountId && item.playlistId === candidate.playlistId);
      if (pairing.left.provider === pairing.right.provider
        || state.pairs.some(item => item.id === pairing.id
          || sameRef(item.left, pairing.left) || sameRef(item.right, pairing.left)
          || sameRef(item.left, pairing.right) || sameRef(item.right, pairing.right))) {
        throw new AppError("SYNC_PAIR_EXISTS", "A playlist is already explicitly paired.", 409);
      }
      if (isIgnored(pairing.left) || isIgnored(pairing.right)) {
        throw new AppError("SYNC_PAIR_IGNORED", "An ignored playlist cannot be paired; unignore it first if you want it synchronized.", 409);
      }
      state.pairs.push(pairing);
    });
  }

  async ignore(ignore: SyncIgnore): Promise<SyncState> {
    return this.update(state => {
      const matches = (candidate: SyncPair["left"]) =>
        candidate.provider === ignore.provider && candidate.accountId === ignore.accountId && candidate.playlistId === ignore.playlistId;
      // An ignored playlist must never be selected through an existing pair either;
      // disable (not delete) any pair referencing it so the audit trail is preserved.
      for (const existing of state.pairs) {
        if (matches(existing.left) || matches(existing.right)) existing.enabled = false;
      }
      if (!state.ignores.some(item => item.provider === ignore.provider && item.accountId === ignore.accountId && item.playlistId === ignore.playlistId)) state.ignores.push(ignore);
    });
  }

  async startRun(pairId: string): Promise<SyncRun> {
    const run: SyncRun = { id: randomUUID(), pairId, status: "running", startedAt: new Date().toISOString(), completedAt: null, message: null, removals: [] };
    this.activeRuns.add(run.id);
    try {
      await this.update(state => {
        if (state.runs.some(item => item.pairId === pairId && item.status === "running" && this.activeRuns.has(item.id))) {
          throw new AppError("SYNC_RUN_ACTIVE", "A synchronization run for this pair is already active; reconcile it before retrying.", 409);
        }
        state.runs.push(run);
      });
      return run;
    } catch (error) {
      this.activeRuns.delete(run.id);
      throw error;
    }
  }

  async recordRemovalAudits(runId: string, audits: readonly SyncRemovalAudit[]): Promise<void> {
    if (audits.length === 0) return;
    await this.update(state => {
      const run = state.runs.find(item => item.id === runId);
      if (!run) throw new AppError("SYNC_RUN_NOT_FOUND", "The sync run for a removal audit does not exist.", 404);
      for (const audit of audits) {
        run.removals.push(audit);
      }
    });
  }

  async finishRun(runId: string, status: SyncRun["status"], message: string | null): Promise<SyncState> {
    try {
      return await this.update(state => {
        const run = state.runs.find(item => item.id === runId);
        if (!run) throw new AppError("SYNC_RUN_NOT_FOUND", "The sync run does not exist.", 404);
        run.status = status; run.message = message; run.completedAt = new Date().toISOString();
      });
    } finally {
      // Clear the in-process claim even if persistence failed, so a run that could not be
      // durably finished is not permanently stuck as "active": read() can still recover it
      // as review-required, and startRun() will not refuse to start a new run for this pair.
      this.activeRuns.delete(runId);
    }
  }

  private async write(state: SyncState): Promise<void> {
    await fs.mkdir(path.dirname(this.filename), { recursive: true, mode: 0o700 });
    const temporary = `${this.filename}.${randomUUID()}.tmp`;
    const handle = await fs.open(temporary, "wx", 0o600);
    try {
      try { await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`); await handle.sync(); }
      finally { await handle.close(); }
      await replaceFile(temporary, this.filename);
    } catch (error) {
      try { await fs.unlink(temporary); } catch { /* preserve the original failure */ }
      throw error;
    }
  }
}
