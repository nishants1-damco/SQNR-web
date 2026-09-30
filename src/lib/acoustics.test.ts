import { describe, expect, it } from "vitest";
import { combineViewpointProbes, type AcousticsResult } from "@/lib/acoustics";

const probe = (chirpRt60s: number[], snr = 20): AcousticsResult => {
  const sorted = [...chirpRt60s].sort((a, b) => a - b);
  return {
    rt60_s: sorted[Math.floor(sorted.length / 2)] ?? 0,
    noise_floor_db: -60,
    peak_db: -60 + snr,
    clarity_index: 0,
    brightness: 0.5,
    bands_db: { "125": 0, "250": 0, "500": 0, "1k": 0, "2k": 0, "4k": 0 },
    envelope: [],
    hardness: "mixed",
    ping_snr_db: snr,
    measured_at: "2026-09-30T00:00:00.000Z",
    chirps: chirpRt60s.length,
    rt60_spread_s: Math.max(...chirpRt60s) - Math.min(...chirpRt60s),
    first_reflection_ms: null,
    reflection_distance_m: null,
    chirp_rt60_s: chirpRt60s,
  };
};

describe("combineViewpointProbes", () => {
  it("returns null with no probes and the probe itself with one", () => {
    expect(combineViewpointProbes([])).toBeNull();
    const only = probe([0.5, 0.6, 0.7]);
    expect(combineViewpointProbes([only])).toBe(only);
  });

  it("counts every chirp and takes the median across all of them", () => {
    const combined = combineViewpointProbes([
      probe([0.5, 0.6, 0.7]),
      probe([0.6, 0.6, 0.65]),
      probe([0.55, 0.62, 3.0]),
    ]);
    expect(combined?.chirps).toBe(9);
    expect(combined?.chirp_rt60_s).toHaveLength(9);
    expect(combined?.rt60_s).toBe(0.6);
  });

  it("weights viewpoints equally instead of letting the latest dominate", () => {
    const combined = combineViewpointProbes([
      probe([0.5, 0.5, 0.5]),
      probe([0.5, 0.5, 0.5]),
      probe([0.5, 0.5, 0.5]),
      probe([1.5, 1.5, 1.5]),
    ]);
    expect(combined?.rt60_s).toBe(0.5);
  });

  it("measures spread between viewpoint medians, not single outlier chirps", () => {
    const combined = combineViewpointProbes([probe([0.5, 0.6, 3.0]), probe([0.55, 0.6, 0.65])]);
    expect(combined?.rt60_spread_s).toBe(0);
  });

  it("keeps the cleanest probe's details and recomputes hardness", () => {
    const quiet = probe([0.3, 0.3, 0.3], 15);
    const clean = { ...probe([0.3, 0.3, 0.3], 30), reflection_distance_m: 1.8 };
    const combined = combineViewpointProbes([quiet, clean]);
    expect(combined?.ping_snr_db).toBe(30);
    expect(combined?.reflection_distance_m).toBe(1.8);
    expect(combined?.hardness).toBe("soft");
  });
});
