// Client-generated capture identifier. Used for:
//
//   - Idempotency: retried "submit capture" calls with the same id don't
//     create duplicate scans.
//   - Consent linkage: the `capture_consents` row references the same id.
//   - Perf/observability: client-emitted timings can be joined to
//     server-side `scan_analyses` metrics.
//
// Generated once per capture session and thrown away on submit. Persisted
// through the same IndexedDB store as `capture-draft` so a reload before
// submit keeps the id stable.
const CAPTURE_ID_KEY = "sqnr:capture-id";

/** RFC4122 v4 using the Web Crypto API. */
function newCaptureId(): string {
  const g: { crypto?: Crypto } = globalThis as unknown as { crypto?: Crypto };
  const c = g.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  // Fallback for very old browsers — good enough for test/edge cases.
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === "function") c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Read the current capture id from sessionStorage, or create one. */
export function getOrCreateCaptureId(): string {
  if (typeof window === "undefined") return newCaptureId();
  const existing = window.sessionStorage.getItem(CAPTURE_ID_KEY);
  if (existing) return existing;
  const fresh = newCaptureId();
  window.sessionStorage.setItem(CAPTURE_ID_KEY, fresh);
  return fresh;
}

/** Discard the current id — call this after a successful submit. */
export function clearCaptureId(): void {
  if (typeof window === "undefined") return;
  window.sessionStorage.removeItem(CAPTURE_ID_KEY);
}
