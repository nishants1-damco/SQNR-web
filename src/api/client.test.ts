import { describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError } from "./client";

const user = {
  id: "00000000-0000-4000-8000-000000000001",
  email: "a@example.com",
  emailVerified: false,
  displayName: null,
  createdAt: "2026-01-01T00:00:00Z",
};

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const session = (token: string, expiresIn = 900) => ({
  accessToken: token,
  tokenType: "Bearer",
  expiresIn,
  user,
});

/** A fake API: `routes` answers by "METHOD /path"; every call is recorded. */
function fakeApi(routes: Record<string, (init: RequestInit) => Response | Promise<Response>>) {
  const calls: { key: string; init: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input), "http://app.test");
    const key = `${init.method ?? "GET"} ${url.pathname}`;
    calls.push({ key, init });
    const route = routes[key];
    if (!route) return json(404, { code: "not_found", message: `no route ${key}` });
    return route(init);
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

const bearer = (init: RequestInit) =>
  (init.headers as Record<string, string> | undefined)?.["authorization"];

describe("ApiClient", () => {
  it("signs in, sends the token, and keeps the refresh cookie on /v1/auth only", async () => {
    const { fetchImpl, calls } = fakeApi({
      "POST /v1/auth/sign-in": () => json(200, session("t1")),
      "GET /v1/me": (init) => json(200, { user, token: bearer(init) }),
    });
    const client = new ApiClient("", fetchImpl, null);
    await client.signIn("a@example.com", "pw");
    const me = await client.request<{ token: string }>("GET", "/v1/me");
    expect(me.token).toBe("Bearer t1");
    expect(calls[0]?.init.credentials).toBe("include");
    expect(calls[1]?.init.credentials).toBe("same-origin");
  });

  it("refreshes once for concurrent requests, and retries a 401 after refreshing", async () => {
    let refreshes = 0;
    const { fetchImpl } = fakeApi({
      "POST /v1/auth/refresh": async () => {
        refreshes++;
        await new Promise((r) => setTimeout(r, 10));
        return json(200, session(`fresh-${refreshes}`));
      },
      "GET /v1/scans": (init) =>
        bearer(init) === "Bearer stale"
          ? json(401, { code: "unauthorized", message: "expired" })
          : json(200, { ok: bearer(init) }),
    });
    const client = new ApiClient("", fetchImpl, null);
    // No session yet: the first requests wait on one refresh.
    const first = client.refresh();
    const results = await Promise.all([
      client.request<{ ok: string }>("GET", "/v1/scans"),
      client.request<{ ok: string }>("GET", "/v1/scans"),
      first,
    ]);
    expect(refreshes).toBe(1);
    expect(results[0].ok).toBe("Bearer fresh-1");
    expect(results[1].ok).toBe("Bearer fresh-1");
  });

  it("makes a request sent before the session is restored wait for the restore", async () => {
    const { fetchImpl, calls } = fakeApi({
      "POST /v1/auth/refresh": () => json(200, session("restored")),
      "GET /v1/scans/x": (init) => json(200, { token: bearer(init) }),
    });
    const client = new ApiClient("", fetchImpl, null);
    // The page's query runs first; the auth provider's restore hasn't started.
    const res = await client.request<{ token: string }>("GET", "/v1/scans/x");
    expect(res.token).toBe("Bearer restored");
    expect(calls.map((c) => c.key)).toEqual(["POST /v1/auth/refresh", "GET /v1/scans/x"]);
  });

  it("refreshes a token that is about to expire before using it", async () => {
    const { fetchImpl } = fakeApi({
      "POST /v1/auth/sign-in": () => json(200, session("short", 30)),
      "POST /v1/auth/refresh": () => json(200, session("renewed")),
      "GET /v1/me": (init) => json(200, { token: bearer(init) }),
    });
    const client = new ApiClient("", fetchImpl, null);
    await client.signIn("a@example.com", "pw");
    expect((await client.request<{ token: string }>("GET", "/v1/me")).token).toBe("Bearer renewed");
  });

  it("ends the session when the refresh token is gone, and says so", async () => {
    const { fetchImpl } = fakeApi({
      "POST /v1/auth/refresh": () => json(401, { code: "unauthorized", message: "no session" }),
    });
    const client = new ApiClient("", fetchImpl, null);
    const changes: unknown[] = [];
    client.onSessionChange((s) => changes.push(s));
    expect(await client.refresh()).toBeNull();
    expect(changes).toEqual([null]);
    await expect(client.request("GET", "/v1/scans")).rejects.toMatchObject({ status: 401 });
  });

  it("serialises refreshes across tabs on a Web Lock", async () => {
    const order: string[] = [];
    const locks = {
      request: vi.fn(async (_name: string, callback: () => Promise<unknown>) => {
        order.push("lock");
        return callback();
      }),
    } as unknown as LockManager;
    const { fetchImpl } = fakeApi({
      "POST /v1/auth/refresh": () => {
        order.push("refresh");
        return json(200, session("t"));
      },
    });
    await new ApiClient("", fetchImpl, locks).refresh();
    expect(order).toEqual(["lock", "refresh"]);
  });

  it("turns the error envelope into an ApiError with Retry-After", async () => {
    const { fetchImpl } = fakeApi({
      "POST /v1/auth/sign-in": () =>
        json(429, { code: "rate_limited", message: "Too many attempts" }, { "retry-after": "42" }),
    });
    const client = new ApiClient("", fetchImpl, null);
    const err = await client.signIn("a@example.com", "pw").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 429, code: "rate_limited", retryAfter: 42 });
  });

  it("reports an unreachable server as a network error", async () => {
    const client = new ApiClient(
      "",
      (() => Promise.reject(new TypeError("Failed to fetch"))) as unknown as typeof fetch,
      null,
    );
    await expect(client.request("GET", "/v1/me", { auth: false })).rejects.toMatchObject({
      code: "network_error",
    });
  });

  it("builds query strings without empty values", () => {
    const client = new ApiClient("https://api.example.com", fetch, null);
    expect(client.url("/v1/scans", { q: "hall", status: undefined, limit: 30, cursor: "" })).toBe(
      "https://api.example.com/v1/scans?q=hall&limit=30",
    );
  });
});
