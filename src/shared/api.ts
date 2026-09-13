import type { BackupManifest, BackupProgress } from "../core/models.js";

export interface StatusResponse {
  appName: string;
  demo: boolean;
  configured: boolean;
  connected: boolean;
  connectionError: {
    code: "GOOGLE_TOKEN_INVALID" | "GOOGLE_CONFIG_INVALID";
    message: string;
  } | null;
  csrfToken: string;
  backupDirectory: string;
  redirectUri: string;
  coverage: string;
  retention: {
    days: number;
    automatic: true;
    lastCheckedAt: string | null;
    error: string | null;
  };
}

export interface BackupJob {
  id: string;
  state: "running" | "finished" | "failed";
  startedAt: string;
  progress: BackupProgress;
  manifest: BackupManifest | null;
  error: string | null;
}

export interface ApiError {
  error: { code: string; message: string };
}
