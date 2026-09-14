import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const baseEnv = { MUSIC_DATA_DIR: "D:/tmp/data", MUSIC_BACKUP_DIR: "D:/tmp/backups" };

describe("loadConfig Spotify configuration", () => {
  it("leaves Spotify unconfigured when no SPOTIFY_* variables are set", () => {
    const config = loadConfig({}, { ...baseEnv });
    expect(config.spotify).toBeNull();
  });

  it("configures Spotify only when all three variables are set", () => {
    const config = loadConfig({}, {
      ...baseEnv,
      SPOTIFY_CLIENT_ID: "client-id",
      SPOTIFY_CLIENT_SECRET: "client-secret",
      SPOTIFY_REFRESH_TOKEN: "refresh-token",
    });
    expect(config.spotify).toEqual({ clientId: "client-id", clientSecret: "client-secret", refreshToken: "refresh-token" });
  });

  it("rejects a partial Spotify configuration instead of silently disabling it", () => {
    expect(() => loadConfig({}, { ...baseEnv, SPOTIFY_CLIENT_ID: "client-id" }))
      .toThrow(/SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET and SPOTIFY_REFRESH_TOKEN must all be set together/);
  });

  it("never configures Spotify in demo mode even when the variables are set", () => {
    const config = loadConfig({ demo: true }, {
      ...baseEnv,
      SPOTIFY_CLIENT_ID: "client-id",
      SPOTIFY_CLIENT_SECRET: "client-secret",
      SPOTIFY_REFRESH_TOKEN: "refresh-token",
    });
    expect(config.spotify).toBeNull();
  });
});
