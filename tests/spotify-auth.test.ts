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

  it("uses a rotated refresh token in-process on the next refresh, instead of retrying with the invalidated original", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, { access_token: "token-1", expires_in: 1, refresh_token: "rotated-token" }))
      .mockResolvedValueOnce(jsonResponse(200, { access_token: "token-2", expires_in: 3600 }));
    const auth = new SpotifyAuth({ ...options, fetch: fetchMock as unknown as typeof fetch });
    await expect(auth.getAccessToken()).resolves.toBe("token-1");
    await expect(auth.getAccessToken()).resolves.toBe("token-2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondBody = new URLSearchParams((fetchMock.mock.calls[1]![1] as RequestInit).body as string);
    expect(secondBody.get("refresh_token")).toBe("rotated-token");
  });

  it("hands a rotated refresh token to the onRefreshTokenRotated callback for durable persistence", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { access_token: "token-1", expires_in: 3600, refresh_token: "rotated-token" }));
    const onRefreshTokenRotated = vi.fn(async () => {});
    const auth = new SpotifyAuth({ ...options, fetch: fetchMock as unknown as typeof fetch, onRefreshTokenRotated });
    await auth.getAccessToken();
    expect(onRefreshTokenRotated).toHaveBeenCalledWith("rotated-token");
  });

  it("falls back to a console warning when no rotation callback is configured", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { access_token: "token-1", expires_in: 3600, refresh_token: "rotated-token" }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const auth = new SpotifyAuth({ ...options, fetch: fetchMock as unknown as typeof fetch });
    await auth.getAccessToken();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("rotated refresh token"));
  });
});
