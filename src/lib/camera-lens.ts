/**
 * Lens description for the capture sweep.
 *
 * The app opens the plain rear camera and then asks the live track what it
 * actually got. Choosing a specific module by device id was tried and removed:
 * mobile Safari only names the individual cameras after permission is granted
 * and commonly refuses the request anyway, handing back the standard camera.
 *
 * Safari never reports focal length, so the horizontal field of view is
 * estimated from the camera label plus any zoom the track reports. That
 * estimate is what the reconstruction uses to turn an object's horizontal
 * position in the image into a bearing.
 */

export interface LensChoice {
  /** Device label as reported by the browser (may be empty before permission). */
  label: string;
  deviceId: string | null;
  /** True when the browser handed back the 0.5x ultra-wide module. */
  ultraWide: boolean;
  /** Estimated horizontal field of view in degrees. */
  fovDeg: number;
  /** Where the FOV number came from, stored with the frame for provenance. */
  fovSource: "ultra-wide-estimate" | "wide-estimate" | "zoom-adjusted" | "default";
}

export const ULTRA_WIDE_FOV_DEG = 103;
export const WIDE_FOV_DEG = 68;
export const TELEPHOTO_FOV_DEG = 34;

const isUltraWide = (label: string) => /ultra\s*wide|0\.5/i.test(label);
const isTelephoto = (label: string) => /telephoto|tele\b/i.test(label);

/** Estimated horizontal FOV for a camera label, before zoom is considered. */
export function estimateFovForLabel(label: string): number {
  if (isUltraWide(label)) return ULTRA_WIDE_FOV_DEG;
  if (isTelephoto(label)) return TELEPHOTO_FOV_DEG;
  return WIDE_FOV_DEG;
}

/**
 * Refines the lens description from the live track: labels are only populated
 * after permission is granted, and some devices report a zoom factor that
 * narrows the effective field of view.
 */
export function describeLensFromTrack(track: MediaStreamTrack | undefined): LensChoice | null {
  if (!track) return null;
  const settings = track.getSettings() as MediaTrackSettings & { zoom?: number };
  const label = track.label || "";
  const ultra = isUltraWide(label);
  let fov = estimateFovForLabel(label);
  let source: LensChoice["fovSource"] = ultra ? "ultra-wide-estimate" : "wide-estimate";

  const zoom = typeof settings.zoom === "number" && settings.zoom > 0 ? settings.zoom : null;
  if (zoom && Math.abs(zoom - 1) > 0.05) {
    // Zoom crops the sensor: halve-angle scales with 1/zoom.
    const half = Math.atan(Math.tan((fov * Math.PI) / 360) / zoom);
    fov = Math.round(((half * 360) / Math.PI) * 10) / 10;
    source = "zoom-adjusted";
  }

  return {
    label: label || "rear camera",
    deviceId: settings.deviceId ?? null,
    ultraWide: ultra,
    fovDeg: fov,
    fovSource: label ? source : "default",
  };
}
