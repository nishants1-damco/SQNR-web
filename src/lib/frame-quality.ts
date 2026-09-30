// Per-frame capture quality: is a frame sharp enough and bright enough to
// reconstruct from? Computed on the phone while capturing (so a weak frame is
// re-shot before the sweep moves on) and stored with the frame, so the space
// page's capture check and the server's frame selection can use it too.
//
// Pure module: safe in the browser and in tests.

/** Width of the grayscale thumbnail sharpness is measured on. */
export const SHARPNESS_SAMPLE_WIDTH = 160;

/**
 * Below this Laplacian variance (on the 160 px thumbnail) a frame counts as
 * blurry. Deliberately conservative until real captures calibrate it: sharp
 * indoor frames typically score in the hundreds, motion-blurred ones in the
 * low tens. Every frame stores its score, so the threshold can be tuned.
 */
export const SHARPNESS_MIN = 30;

/** Mean luminance (0-255) below which a frame is too dark to read detail. */
export const DARK_MEAN = 40;

/** Luminance spread below this is a flat, low-contrast frame. */
const LOW_CONTRAST_DEVIATION = 12;

/** Same cut-off the capture loop uses for "the phone was still swinging". */
const MOVING_MOTION_ENERGY = 0.9;

/**
 * Tilt range (DeviceOrientation `beta`, degrees) for the downward view taken
 * at each corner: upright portrait is ~90°, camera pointing at the floor ~0°.
 * 35-70° looks down across the floor at low furniture and under tables.
 */
export const LOW_VIEW_PITCH = { min: 35, max: 70 } as const;

/** Luminance of RGBA pixel data as a grayscale array. */
export function toGray(rgba: ArrayLike<number>): Float32Array {
  const gray = new Float32Array(rgba.length / 4);
  for (let i = 0; i < gray.length; i++) {
    gray[i] =
      0.2126 * (rgba[i * 4] ?? 0) +
      0.7152 * (rgba[i * 4 + 1] ?? 0) +
      0.0722 * (rgba[i * 4 + 2] ?? 0);
  }
  return gray;
}

/**
 * Variance of the 4-neighbour Laplacian: the standard focus measure. Edges
 * produce large second derivatives; blur smears them out and the variance
 * collapses.
 */
export function laplacianVariance(gray: ArrayLike<number>, width: number, height: number): number {
  if (width < 3 || height < 3) return 0;
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const lap =
        (gray[i - 1] ?? 0) +
        (gray[i + 1] ?? 0) +
        (gray[i - width] ?? 0) +
        (gray[i + width] ?? 0) -
        4 * (gray[i] ?? 0);
      sum += lap;
      sumSq += lap * lap;
      n++;
    }
  }
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

export interface FrameQuality {
  /** Worth re-shooting: blurry, dark, flat or taken mid-swing. */
  weak: boolean;
  blurry: boolean;
  dark: boolean;
}

export function assessFrame(m: {
  sharpness: number;
  brightness: number;
  deviation: number;
  motionEnergy?: number | null;
}): FrameQuality {
  const blurry = m.sharpness < SHARPNESS_MIN;
  const dark = m.brightness < DARK_MEAN;
  const weak =
    blurry ||
    dark ||
    m.deviation < LOW_CONTRAST_DEVIATION ||
    (m.motionEnergy ?? 0) > MOVING_MOTION_ENERGY;
  return { weak, blurry, dark };
}
