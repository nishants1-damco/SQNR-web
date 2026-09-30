// Structured logging helper. Wraps `console.*` (rather than replacing it)
// so `src/lib/error-capture.ts`'s console.error monkey-patch — which records
// the raw Error for SSR crash recovery — keeps working unchanged.
//
// Usage:
//   import { logger } from "@/lib/logger";
//   logger.info("scan.functions", "analysis started", { scanId });
//   logger.error("scan.functions", "analysis failed", error, { scanId });

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function readEnv(name: string): string | undefined {
  // Works in both server (Node/Nitro) and browser (Vite-injected) contexts.
  if (typeof process !== "undefined" && process.env?.[name]) return process.env[name];
  if (typeof import.meta !== "undefined" && (import.meta as { env?: Record<string, string> }).env) {
    return (import.meta as unknown as { env: Record<string, string> }).env[name];
  }
  return undefined;
}

function isProduction(): boolean {
  return readEnv("NODE_ENV") === "production" || readEnv("PROD") === "true";
}

function configuredLevel(): LogLevel {
  const raw = readEnv("LOG_LEVEL")?.toLowerCase();
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") return raw;
  return isProduction() ? "info" : "debug";
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[configuredLevel()];
}

type LogFields = Record<string, unknown>;

/**
 * Best-effort stringification for log fields. `String(err)` on a plain
 * object (e.g. a Supabase/Postgrest error, which is a plain `{ message,
 * details, hint, code }` shape rather than an `Error` instance) yields the
 * useless `"[object Object]"` — this pulls a real message out instead.
 */
export function errString(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    const obj = err as Record<string, unknown>;
    const message = obj["message"];
    if (typeof message === "string" && message) {
      const code = obj["code"];
      const codeSuffix = typeof code === "string" ? ` (${code})` : "";
      return `${message}${codeSuffix}`;
    }
    try {
      return JSON.stringify(err);
    } catch {
      return Object.prototype.toString.call(err);
    }
  }
  return String(err);
}

function formatPrefix(level: LogLevel, scope: string, message: string, fields?: LogFields): string {
  const time = new Date().toISOString();
  if (isProduction()) {
    // JSON lines are easy to ingest into a log pipeline (Cloudflare, Datadog, etc.).
    return JSON.stringify({ time, level, scope, message, ...fields });
  }
  const suffix = fields && Object.keys(fields).length > 0 ? ` ${JSON.stringify(fields)}` : "";
  return `[${time}] [${scope}] ${message}${suffix}`;
}

export const logger = {
  debug(scope: string, message: string, fields?: LogFields): void {
    if (!shouldLog("debug")) return;
    console.debug(formatPrefix("debug", scope, message, fields));
  },
  info(scope: string, message: string, fields?: LogFields): void {
    if (!shouldLog("info")) return;
    console.info(formatPrefix("info", scope, message, fields));
  },
  warn(scope: string, message: string, fields?: LogFields): void {
    if (!shouldLog("warn")) return;
    console.warn(formatPrefix("warn", scope, message, fields));
  },
  /**
   * `error` may be an Error, an SDK error object, or omitted entirely. When
   * it's an Error instance it's passed through as its own console.error
   * argument (not stringified into the JSON) so error-capture.ts can still
   * detect and expand it for SSR crash recovery.
   */
  error(scope: string, message: string, error?: unknown, fields?: LogFields): void {
    if (!shouldLog("error")) return;
    const prefix = formatPrefix("error", scope, message, fields);
    if (error === undefined) {
      console.error(prefix);
    } else {
      console.error(prefix, error);
    }
  },
};
