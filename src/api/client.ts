// The one way the web app talks to the Spatial Capture API (plan §13.2).
//
// Sessions: the access token lives in memory only; the refresh token is an
// HttpOnly cookie scoped to /v1/auth that this code never sees. The client
// refreshes shortly before the access token expires, and once on a 401.
//
// Refresh tokens rotate on every use and the API treats a replayed one as
// theft (it ends the session everywhere). Two refreshes must therefore never
// overlap: within a tab they share one promise, and across tabs they queue on
// a Web Lock, so the second tab refreshes with the cookie the first one got.
import type { AuthSession, ErrorCode, ErrorEnvelope, User } from "@spatial/contracts";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode | "network_error",
    message: string,
    readonly details?: unknown,
    /** Seconds, from the Retry-After header. */
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface Session {
  accessToken: string;
  /** Epoch ms. */
  expiresAt: number;
  user: User;
}

type Listener = (session: Session | null) => void;

export interface RequestOptions {
  body?: unknown;
  query?: Record<string, string | number | undefined | null>;
  signal?: AbortSignal;
  /** Send the access token (default true). */
  auth?: boolean;
  headers?: Record<string, string>;
}

/** Refresh when less than this is left on the access token. */
const REFRESH_MARGIN_MS = 60_000;
const REFRESH_LOCK = "sqnr-auth-refresh";

export class ApiClient {
  private session: Session | null = null;
  private refreshing: Promise<Session | null> | null = null;
  /**
   * False until the first refresh has settled. Until then "no session" only
   * means "not restored yet": a page's first query can run before the auth
   * provider has restored the session from the cookie, and must wait for it.
   */
  private restored = false;
  private readonly listeners = new Set<Listener>();

  constructor(
    /** "" for same-origin (the dev proxy, or the API behind the same Front Door). */
    readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
    private readonly locks: LockManager | null = typeof navigator !== "undefined" &&
    "locks" in navigator
      ? navigator.locks
      : null,
  ) {}

  // ---- session --------------------------------------------------------------

  get currentSession(): Session | null {
    return this.session;
  }

  onSessionChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private setSession(session: Session | null) {
    this.session = session;
    this.restored = true;
    for (const listener of this.listeners) listener(session);
  }

  private fromAuth(body: AuthSession): Session {
    return {
      accessToken: body.accessToken,
      expiresAt: Date.now() + body.expiresIn * 1000,
      user: body.user,
    };
  }

  async signIn(email: string, password: string): Promise<User> {
    const body = await this.send<AuthSession>("POST", "/v1/auth/sign-in", {
      body: { email, password },
      auth: false,
    });
    const session = this.fromAuth(body);
    this.setSession(session);
    return session.user;
  }

  async signUp(email: string, password: string): Promise<User> {
    const body = await this.send<AuthSession>("POST", "/v1/auth/sign-up", {
      body: { email, password },
      auth: false,
    });
    const session = this.fromAuth(body);
    this.setSession(session);
    return session.user;
  }

  async signOut(): Promise<void> {
    try {
      await this.send("POST", "/v1/auth/sign-out", { auth: false });
    } finally {
      this.setSession(null);
    }
  }

  /**
   * A new access token from the refresh cookie, or null when there's no
   * session (signed out, expired, or ended elsewhere). Never runs twice at once.
   */
  refresh(): Promise<Session | null> {
    this.refreshing ??= this.refreshOnce().finally(() => {
      this.refreshing = null;
      this.restored = true;
    });
    return this.refreshing;
  }

  private async refreshOnce(): Promise<Session | null> {
    const run = async () => {
      try {
        const body = await this.send<AuthSession>("POST", "/v1/auth/refresh", { auth: false });
        const session = this.fromAuth(body);
        this.setSession(session);
        return session;
      } catch (err) {
        if (err instanceof ApiError && (err.status === 401 || err.status === 400)) {
          this.setSession(null);
          return null;
        }
        throw err;
      }
    };
    return this.locks ? this.locks.request(REFRESH_LOCK, run) : run();
  }

  private async accessToken(): Promise<string | null> {
    const session = this.session;
    if (session && session.expiresAt - Date.now() > REFRESH_MARGIN_MS) return session.accessToken;
    if (!session && !this.refreshing && this.restored) return null;
    return (await this.refresh())?.accessToken ?? null;
  }

  // ---- requests -------------------------------------------------------------

  url(path: string, query?: RequestOptions["query"]): string {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
    }
    const qs = params.toString();
    return `${this.baseUrl}${path}${qs ? `?${qs}` : ""}`;
  }

  /** A JSON request. With `auth` (the default) a 401 triggers one refresh and a retry. */
  async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    if (options.auth === false) return this.send<T>(method, path, options);
    const token = await this.accessToken();
    if (!token) throw new ApiError(401, "unauthorized", "Sign in to continue");
    try {
      return await this.send<T>(method, path, options, token);
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 401) throw err;
      const renewed = await this.refresh();
      if (!renewed) throw err;
      return this.send<T>(method, path, options, renewed.accessToken);
    }
  }

  /**
   * A raw authorised response, for streams (the analysis event stream). The
   * caller reads and closes the body.
   */
  async stream(path: string, signal?: AbortSignal): Promise<Response> {
    const token = await this.accessToken();
    if (!token) throw new ApiError(401, "unauthorized", "Sign in to continue");
    const open = (bearer: string) =>
      this.fetchImpl(this.url(path), {
        headers: { authorization: `Bearer ${bearer}`, accept: "text/event-stream" },
        ...(signal ? { signal } : {}),
      });
    let res = await open(token);
    if (res.status === 401) {
      const renewed = await this.refresh();
      if (renewed) res = await open(renewed.accessToken);
    }
    if (!res.ok) throw await this.toError(res);
    return res;
  }

  private async send<T>(
    method: string,
    path: string,
    options: RequestOptions,
    token?: string,
  ): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json", ...options.headers };
    if (options.body !== undefined) headers["content-type"] = "application/json";
    if (token) headers["authorization"] = `Bearer ${token}`;
    let res: Response;
    try {
      res = await this.fetchImpl(this.url(path, options.query), {
        method,
        headers,
        // The refresh cookie only travels to /v1/auth.
        credentials: path.startsWith("/v1/auth/") ? "include" : "same-origin",
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (err) {
      if ((err as { name?: string }).name === "AbortError") throw err;
      throw new ApiError(0, "network_error", "Can't reach the server. Check your connection.");
    }
    if (!res.ok) throw await this.toError(res);
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  private async toError(res: Response): Promise<ApiError> {
    let envelope: Partial<ErrorEnvelope> = {};
    try {
      envelope = (await res.json()) as ErrorEnvelope;
    } catch {
      // not JSON (a proxy error page, say)
    }
    const retryAfter = Number(res.headers.get("retry-after"));
    return new ApiError(
      res.status,
      envelope.code ?? (res.status >= 500 ? "internal_error" : "invalid_request"),
      envelope.message ?? `Request failed (${res.status})`,
      envelope.details,
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
    );
  }
}

/** The app's client. `VITE_API_BASE_URL` is empty for a same-origin API. */
export const api = new ApiClient((import.meta.env["VITE_API_BASE_URL"] ?? "").replace(/\/$/, ""));
