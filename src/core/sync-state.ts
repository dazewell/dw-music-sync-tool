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
  status: "running" | "complete" | "partial" | "failed" | "review-required";
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
    id: z.string(), pairId: z.string(), status: z.enum(["running", "complete", "partial", "failed", "review-required"]),
    startedAt: z.iso.datetime(), completedAt: z.iso.datetime().nullable(), message: z.string().nullable(),
    removals: z.array(z.object({
      pairId: z.string().min(1), platform: z.enum(["youtube", "spotify"]), playlistId: z.string().min(1),
      itemIdentity: z.string().min(1), direction: z.enum(["left-to-right", "right-to-left"]),
      timestamp: z.iso.datetime(), outcome: z.enum(["success", "failed"]), error: z.string().nullable(),
    })).default([]),
  })),
}).strict();

const emptyState = (): SyncState => ({ schemaVersion: 1, pairs: [], ignores: [], baselines: {}, runs: [] });

export class SyncStateStore implements SyncRemovalAuditSink {
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly filename: string) {}

  async read(): Promise<SyncState> {
    try {
      const parsed = stateSchema.safeParse(JSON.parse(await fs.readFile(this.filename, "utf8")));
      if (!parsed.success) throw new Error("invalid schema");
      return parsed.data;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return emptyState();
      throw new AppError("SYNC_STATE_INVALID", "The sync state is invalid or unreadable; preserve it for inspection.", 500);
    }
  }

  async update(mutator: (state: SyncState) => void): Promise<SyncState> {
    let result!: SyncState;
    const task = this.queue.then(async () => {
      result = await this.read();
      mutator(result);
      const parsed = stateSchema.safeParse(result);
      if (!parsed.success) throw new AppError("SYNC_STATE_INVALID", "The sync state update is invalid.", 500);
      await fs.mkdir(path.dirname(this.filename), { recursive: true, mode: 0o700 });
      const temporary = `${this.filename}.${randomUUID()}.tmp`;
      const handle = await fs.open(temporary, "wx", 0o600);
      try {
        try { await handle.writeFile(`${JSON.stringify(parsed.data, null, 2)}\n`); await handle.sync(); }
        finally { await handle.close(); }
        await replaceFile(temporary, this.filename);
      } catch (error) {
        try { await fs.unlink(temporary); } catch { /* preserve the original failure */ }
        throw error;
      }
    });
    this.queue = task.then(() => undefined, () => undefined);
    await task;
    return result;
  }

  async pair(pairing: SyncPair): Promise<SyncState> {
    return this.update(state => {
      if (pairing.left.provider === pairing.right.provider || pairing.left.playlistId === pairing.right.playlistId
        || state.pairs.some(item => item.id === pairing.id
          || (item.left.provider === pairing.left.provider && item.left.accountId === pairing.left.accountId && item.left.playlistId === pairing.left.playlistId)
          || (item.right.provider === pairing.right.provider && item.right.accountId === pairing.right.accountId && item.right.playlistId === pairing.right.playlistId))) {
        throw new AppError("SYNC_PAIR_EXISTS", "A playlist is already explicitly paired.", 409);
      }
      state.pairs.push(pairing);
    });
  }

  async ignore(ignore: SyncIgnore): Promise<SyncState> {
    return this.update(state => {
      if (!state.ignores.some(item => item.provider === ignore.provider && item.accountId === ignore.accountId && item.playlistId === ignore.playlistId)) state.ignores.push(ignore);
    });
  }

  async startRun(pairId: string): Promise<SyncRun> {
    const run: SyncRun = { id: randomUUID(), pairId, status: "running", startedAt: new Date().toISOString(), completedAt: null, message: null, removals: [] };
    await this.update(state => { state.runs.push(run); });
    return run;
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
    return this.update(state => {
      const run = state.runs.find(item => item.id === runId);
      if (!run) throw new AppError("SYNC_RUN_NOT_FOUND", "The sync run does not exist.", 404);
      run.status = status; run.message = message; run.completedAt = new Date().toISOString();
    });
  }
}
