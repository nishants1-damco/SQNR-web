// Ported from the original src/lib/verification-and-capture.test.ts ("frame quality").
import { describe, expect, it } from "vitest";
import { assessFrame, laplacianVariance, SHARPNESS_MIN } from "@/lib/frame-quality";

describe("frame quality", () => {
  const W = 40;
  const H = 30;
  const checkerboard = Array.from({ length: W * H }, (_, i) =>
    ((i % W) + Math.floor(i / W)) % 2 ? 255 : 0,
  );
  const flat = new Array<number>(W * H).fill(128);

  it("scores sharp detail high and a flat frame zero", () => {
    expect(laplacianVariance(checkerboard, W, H)).toBeGreaterThan(SHARPNESS_MIN * 100);
    expect(laplacianVariance(flat, W, H)).toBe(0);
  });

  it("flags blurry, dark and swinging frames as weak", () => {
    const good = { sharpness: 300, brightness: 120, deviation: 40, motionEnergy: 0.2 };
    expect(assessFrame(good)).toEqual({ weak: false, blurry: false, dark: false });
    expect(assessFrame({ ...good, sharpness: 5 })).toMatchObject({ weak: true, blurry: true });
    expect(assessFrame({ ...good, brightness: 20 })).toMatchObject({ weak: true, dark: true });
    expect(assessFrame({ ...good, motionEnergy: 1.4 }).weak).toBe(true);
  });
});
