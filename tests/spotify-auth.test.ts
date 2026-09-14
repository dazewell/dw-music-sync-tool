import { afterEach, describe, expect, it, vi } from "vitest";
import { SpotifyAuth } from "../src/auth/spotify.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

afterEach(() => {
  vi.useRealTimers();
});

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

  it("propagates a persistence failure for a rotated refresh token instead of reporting success", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { access_token: "token-1", expires_in: 3600, refresh_token: "rotated-token" }));
    const onRefreshTokenRotated = vi.fn(async () => { throw new Error("disk full"); });
    const auth = new SpotifyAuth({ ...options, fetch: fetchMock as unknown as typeof fetch, onRefreshTokenRotated });
    await expect(auth.getAccessToken()).rejects.toMatchObject({ code: "SPOTIFY_AUTH_ROTATION_PERSIST_FAILED" });
  });

  it("does not permanently block future rotations after a persistence failure", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, { access_token: "token-1", expires_in: 3600, refresh_token: "rotated-1" }));
    const onRefreshTokenRotated = vi.fn(async () => { throw new Error("disk full"); });
    const auth = new SpotifyAuth({ ...options, fetch: fetchMock as unknown as typeof fetch, onRefreshTokenRotated });
    await expect(auth.getAccessToken()).rejects.toMatchObject({ code: "SPOTIFY_AUTH_ROTATION_PERSIST_FAILED" });
    // A later, unrelated rotation attempt must still run (and can still succeed), instead of the
    // internal serialization queue staying rejected forever after the first failure.
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { access_token: "token-2", expires_in: 3600, refresh_token: "rotated-2" }));
    onRefreshTokenRotated.mockResolvedValueOnce(undefined);
    (auth as unknown as { cached: unknown }).cached = null;
    await expect(auth.getAccessToken()).resolves.toBe("token-2");
    expect(onRefreshTokenRotated).toHaveBeenCalledTimes(2);
  });

  it("reports a timeout, not an invalid response, when the body stalls after headers arrive", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      const response = new Response("{}", { status: 200 });
      // A real fetch's AbortSignal also governs body consumption, so a response that stalls
      // while streaming its body still gets aborted; response.json() must reject, not just hang.
      response.json = () => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
      return Promise.resolve(response);
    });
    const auth = new SpotifyAuth({ ...options, requestTimeoutMs: 20, fetch: fetchMock as unknown as typeof fetch });
    const assertion = expect(auth.getAccessToken()).rejects.toMatchObject({ code: "SPOTIFY_AUTH_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(21);
    await assertion;
  });
});
