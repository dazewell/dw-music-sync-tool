import { describe, expect, it, vi } from "vitest";
import { SpotifyAuth } from "../src/auth/spotify.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("SpotifyAuth", () => {
  const options = { clientId: "client-id", clientSecret: "client-secret", refreshToken: "refresh-token" };

  it("exchanges the configured refresh token for an access token and caches it until near expiry", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { access_token: "token-1", expires_in: 3600 }));
    const auth = new SpotifyAuth({ ...options, fetch: fetchMock as unknown as typeof fetch });
    await expect(auth.getAccessToken()).resolves.toBe("token-1");
    await expect(auth.getAccessToken()).resolves.toBe("token-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://accounts.spotify.com/api/token");
    expect((init as RequestInit).headers).toMatchObject({ Authorization: expect.stringMatching(/^Basic /) });
  });

  it("fails closed with an actionable error when Spotify rejects the refresh token", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(400, { error: "invalid_grant" }));
    const auth = new SpotifyAuth({ ...options, fetch: fetchMock as unknown as typeof fetch });
    await expect(auth.getAccessToken()).rejects.toMatchObject({ code: "SPOTIFY_AUTH_REJECTED" });
  });

  it("rejects an invalid token response instead of returning an unusable value", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { expires_in: 3600 }));
    const auth = new SpotifyAuth({ ...options, fetch: fetchMock as unknown as typeof fetch });
    await expect(auth.getAccessToken()).rejects.toMatchObject({ code: "SPOTIFY_AUTH_INVALID" });
  });

  it("reports network failures without silently retrying", async () => {
    const fetchMock = vi.fn(async () => { throw new Error("network down"); });
    const auth = new SpotifyAuth({ ...options, fetch: fetchMock as unknown as typeof fetch });
    await expect(auth.getAccessToken()).rejects.toMatchObject({ code: "SPOTIFY_AUTH_NETWORK" });
  });
});
