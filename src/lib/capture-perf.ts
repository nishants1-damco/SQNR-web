// Client-side capture timings. Emits `performance.mark()` at named phases
// so they can be inspected with `performance.getEntriesByType('mark')` from
// devtools or a debug overlay.
//
// Deliberately does not upload anything on its own — that would require
// consent and a separate telemetry channel. The point is to make phase
// timings measurable, not to fire-and-forget them.

/**
 * Record a phase transition. `phase` is a short verb, e.g. "camera_ready",
 * "first_shot", "station_1_complete", "submit_start".
 */
export function markPhase(phase: string, detail?: Record<string, unknown>): void {
  if (typeof performance === "undefined" || typeof performance.mark !== "function") return;
  try {
    performance.mark(`sqnr:${phase}`, detail ? { detail } : undefined);
  } catch {
    // Some browsers reject long names or duplicate marks — ignore.
  }
}
