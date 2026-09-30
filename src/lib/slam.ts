/**
 * Lightweight inertial odometry ("SLAM-like" dead reckoning) for handheld capture.
 *
 * The compass tells us where the phone is *pointing*; it says nothing about
 * where the phone *is*. Without that, every frame is assumed to be shot from
 * the room center and the reconstruction has no way to keep scale consistent
 * between the first frame and the last.
 *
 * This tracker integrates the accelerometer (rotated into a world frame using
 * the compass heading) to estimate a translation delta from the first frame,
 * with zero-velocity updates (ZUPT) whenever the phone is still, which is what
 * keeps double-integration drift bounded over a 30-60 s room walk.
 *
 * Frame convention: +x east, +y north, +z up — the same local CRS used by the
 * spatial layers and the renderers.
 */

export interface Pose {
  /** Meters east of the first frame. */
  x: number;
  /** Meters north of the first frame. */
  y: number;
  /** Meters above the first frame. */
  z: number;
  /** Compass heading in degrees at the time of the sample. */
  heading: number | null;
  pitch: number | null;
  roll: number | null;
  /** Path length walked since the origin frame. */
  travelled_m: number;
  /** Rough 1-sigma position uncertainty in meters. */
  drift_m: number;
  /** Instantaneous motion energy — high means the frame is likely blurred. */
  motion_energy: number;
  /** Seconds since the origin frame. */
  t_s: number;
  /** Cadence-filtered steps since tracking began. */
  steps: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
const rad = (d: number) => (d * Math.PI) / 180;

export class MotionTracker {
  private started = false;
  private t0 = 0;
  private last = 0;
  private lastZupt = 0;
  private vel = [0, 0, 0];
  private pos = [0, 0, 0];
  private bias = [0, 0, 0];
  private travelled = 0;
  private energy = 0;
  private heading: number | null = null;
  private pitch: number | null = null;
  private roll: number | null = null;
  private stillSince = 0;
  private steps = 0;
  private lastStepAt = 0;
  private stepArmed = true;
  private onUpdate: ((p: Pose) => void) | undefined;

  private orientationHandler = (e: DeviceOrientationEvent) => {
    const webkit = (e as DeviceOrientationEvent & { webkitCompassHeading?: number })
      .webkitCompassHeading;
    if (typeof webkit === "number") this.heading = webkit;
    else if (typeof e.alpha === "number") this.heading = (360 - e.alpha) % 360;
    if (typeof e.beta === "number") this.pitch = e.beta;
    if (typeof e.gamma === "number") this.roll = e.gamma;
  };

  private motionHandler = (e: DeviceMotionEvent) => {
    const now = performance.now();
    if (!this.last) {
      this.last = now;
      this.t0 = now;
      this.lastZupt = now;
      this.stillSince = now;
      return;
    }
    const dt = clamp((now - this.last) / 1000, 0.001, 0.12);
    this.last = now;

    const rot = e.rotationRate;
    const rotMag = Math.abs(rot?.alpha ?? 0) + Math.abs(rot?.beta ?? 0) + Math.abs(rot?.gamma ?? 0);

    // Prefer gravity-compensated acceleration; fall back to a crude high-pass
    // of the raw signal when the device only reports accelerationIncludingGravity.
    const a = e.acceleration;
    const g = e.accelerationIncludingGravity;
    let ax = a?.x ?? null;
    let ay = a?.y ?? null;
    let az = a?.z ?? null;
    if (ax == null && ay == null && az == null && g) {
      const mag = Math.hypot(g.x ?? 0, g.y ?? 0, g.z ?? 0) || 1;
      const s = 9.81 / mag;
      ax = (g.x ?? 0) - (g.x ?? 0) * s;
      ay = (g.y ?? 0) - (g.y ?? 0) * s;
      az = (g.z ?? 0) - (g.z ?? 0) * s;
    }
    const dx = (ax ?? 0) - (this.bias[0] ?? 0);
    const dy = (ay ?? 0) - (this.bias[1] ?? 0);
    const dz = (az ?? 0) - (this.bias[2] ?? 0);
    const accMag = Math.hypot(dx, dy, dz);
    this.energy = Math.round((rotMag / 60 + accMag / 2) * 100) / 100;

    // A conservative peak detector. Steps are only a scale cross-check, never
    // the sole distance source, so false positives are more harmful than misses.
    if (accMag < 0.55) this.stepArmed = true;
    if (this.stepArmed && accMag > 1.05 && now - this.lastStepAt > 320) {
      this.steps += 1;
      this.lastStepAt = now;
      this.stepArmed = false;
    }

    // Device axes -> world. Camera looks along -z, phone's right is +x.
    const h = rad(this.heading ?? 0);
    const fwd = -dz;
    const right = dx;
    const east = right * Math.cos(h) + fwd * Math.sin(h);
    const north = fwd * Math.cos(h) - right * Math.sin(h);
    const up = dy;

    const still = accMag < 0.18 && rotMag < 12;
    if (still) {
      if (!this.stillSince) this.stillSince = now;
      // Zero-velocity update: the walk pauses at every capture station, so we
      // reset the velocity and slowly learn the accelerometer bias there.
      if (now - this.stillSince > 250) {
        this.vel = [0, 0, 0];
        this.lastZupt = now;
        const k = 0.02;
        this.bias = [
          (this.bias[0] ?? 0) + k * (ax ?? 0),
          (this.bias[1] ?? 0) + k * (ay ?? 0),
          (this.bias[2] ?? 0) + k * (az ?? 0),
        ];
      }
    } else {
      this.stillSince = 0;
      const damp = 0.985;
      const vx = clamp(((this.vel[0] ?? 0) + east * dt) * damp, -2.5, 2.5);
      const vy = clamp(((this.vel[1] ?? 0) + north * dt) * damp, -2.5, 2.5);
      const vz = clamp(((this.vel[2] ?? 0) + up * dt) * damp, -1.5, 1.5);
      this.vel = [vx, vy, vz];
      const sx = vx * dt;
      const sy = vy * dt;
      const sz = vz * dt;
      this.pos = [(this.pos[0] ?? 0) + sx, (this.pos[1] ?? 0) + sy, (this.pos[2] ?? 0) + sz];
      this.travelled += Math.hypot(sx, sy, sz);
    }

    this.onUpdate?.(this.pose());
  };

  async start(onUpdate?: (p: Pose) => void) {
    if (this.started) return;
    this.onUpdate = onUpdate;
    type Req = { requestPermission?: () => Promise<"granted" | "denied"> };
    const DOE = DeviceOrientationEvent as unknown as Req | undefined;
    const DME = DeviceMotionEvent as unknown as Req | undefined;
    try {
      if (DOE && typeof DOE.requestPermission === "function") await DOE.requestPermission();
    } catch {
      /* ignore */
    }
    try {
      if (DME && typeof DME.requestPermission === "function") await DME.requestPermission();
    } catch {
      /* ignore */
    }
    window.addEventListener("deviceorientation", this.orientationHandler, true);
    window.addEventListener("devicemotion", this.motionHandler, true);
    this.started = true;
  }

  stop() {
    if (!this.started) return;
    window.removeEventListener("deviceorientation", this.orientationHandler, true);
    window.removeEventListener("devicemotion", this.motionHandler, true);
    this.started = false;
  }

  /** Anchors the origin on the first captured frame. */
  resetOrigin() {
    this.pos = [0, 0, 0];
    this.vel = [0, 0, 0];
    this.travelled = 0;
    this.t0 = performance.now();
    this.lastZupt = this.t0;
    this.steps = 0;
    this.lastStepAt = 0;
  }

  /** True once the phone has been held still long enough to trust a ZUPT. */
  isStill() {
    return this.stillSince > 0 && performance.now() - this.stillSince > 400;
  }

  /**
   * Snapshot used as one end of a walked leg. Taken while the phone is still,
   * so the velocity has just been zeroed and the position is as clean as
   * dead reckoning gets.
   */
  anchor() {
    const p = this.pose();
    return { x: p.x, y: p.y, travelled_m: p.travelled_m, t_s: p.t_s, steps: p.steps };
  }

  pose(): Pose {
    const now = performance.now();
    const sinceZupt = Math.max(0, (now - (this.lastZupt || now)) / 1000);
    return {
      x: Math.round((this.pos[0] ?? 0) * 1000) / 1000,
      y: Math.round((this.pos[1] ?? 0) * 1000) / 1000,
      z: Math.round((this.pos[2] ?? 0) * 1000) / 1000,
      heading: this.heading,
      pitch: this.pitch,
      roll: this.roll,
      travelled_m: Math.round(this.travelled * 100) / 100,
      // Dead-reckoning error grows roughly with t^1.5 between ZUPTs; this is a
      // deliberately pessimistic, cheap proxy used only for weighting.
      drift_m: Math.round(0.12 * Math.pow(sinceZupt, 1.5) * 100) / 100,
      motion_energy: this.energy,
      t_s: Math.round((now - this.t0) / 10) / 100,
      steps: this.steps,
    };
  }
}

/** Compact summary of a capture path, used to constrain the reconstruction. */
export function summarisePoses(poses: (Pose | null | undefined)[]) {
  const pts = poses.filter((p): p is Pose => !!p);
  if (pts.length === 0) return null;
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const spanX = Math.max(...xs) - Math.min(...xs);
  const spanY = Math.max(...ys) - Math.min(...ys);
  return {
    frames: pts.length,
    span_east_m: Math.round(spanX * 100) / 100,
    span_north_m: Math.round(spanY * 100) / 100,
    travelled_m: Math.round(Math.max(...pts.map((p) => p.travelled_m)) * 100) / 100,
    mean_drift_m: Math.round((pts.reduce((s, p) => s + p.drift_m, 0) / pts.length) * 100) / 100,
  };
}
