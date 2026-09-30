import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/api/client";
import { runAnalysis } from "@/api/analysis";
import { spaces } from "@/api/spaces";
import { type DepthUpload, type FrameUpload, uploadToScan } from "@/api/uploads";
import { useAuth } from "@/lib/useAuth";
import {
  combineViewpointProbes,
  createProbeSession,
  inspectAudioEnvironment,
  type AcousticsResult,
  type AudioEnvironment,
  type ProbeSession,
  type WallRange,
} from "@/lib/acoustics";
import { shellFromRanges } from "@spatial/domain/wall-ranges";
import { makeLeg, stationPositions, type WalkLeg } from "@spatial/domain/walk-legs";
import { stationConditioning } from "@spatial/domain/graph-solve";

import type { DepthMetrics } from "@/lib/depth-import";

import { MotionTracker, summarisePoses, type Pose } from "@/lib/slam";
import { describeLensFromTrack, type LensChoice } from "@/lib/camera-lens";

import { logger } from "@/lib/logger";

import {
  saveCaptureDraft,
  loadCaptureDraft,
  clearCaptureDraft,
  type CaptureDraft,
} from "@/lib/capture-draft";
import { getOrCreateCaptureId, clearCaptureId } from "@/lib/capture-id";
import { markPhase } from "@/lib/capture-perf";
import { computeQualitySignals } from "@spatial/domain/quality-signals";
import {
  assessFrame,
  laplacianVariance,
  LOW_VIEW_PITCH,
  SHARPNESS_SAMPLE_WIDTH,
  toGray,
} from "@/lib/frame-quality";
import {
  assessStations,
  stationFrameFromPhoto,
  stationLabel,
  type StationFrame,
  type StationHealth,
} from "@spatial/domain/station-health";
import { isAnalysisStale } from "@spatial/domain/analysis-deadline";
import {
  CaptureConsent,
  CONSENT_VERSION,
  hasLocalConsent,
  persistLocalConsent,
} from "@/components/CaptureConsent";
import { QualityBar } from "@/components/QualityBar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { BrandMark } from "@/components/BrandMark";
import { LeaveGuardDialog } from "@/components/LeaveGuardDialog";
import { useLeaveGuard } from "@/hooks/useLeaveGuard";
import { StationHealthMap } from "@/components/StationHealthMap";
import { toast } from "sonner";
import { Camera, Mic, Boxes, Check, Compass } from "lucide-react";

/**
 * `?reshoot=<scanId>&station=<n>` opens the capture for one viewpoint of a
 * saved scan: its frames are replaced and the reconstruction re-run.
 */
interface CaptureSearch {
  reshoot?: string;
  station?: number;
}

/** How long the first reconstruction may hold the progress bar before the
 * user is sent to the catalog while it finishes in the background. */
const RECON_HANDOFF_MS = 5 * 60 * 1000;

export const Route = createFileRoute("/capture")({
  validateSearch: (search: Record<string, unknown>): CaptureSearch => {
    const reshoot = typeof search["reshoot"] === "string" ? search["reshoot"] : undefined;
    const station = Number(search["station"]);
    return reshoot && Number.isInteger(station) && station >= 0 ? { reshoot, station } : {};
  },
  head: () => ({
    meta: [
      { title: "Capture a space · SQNR" },
      {
        name: "description",
        content:
          "Walk a room with your phone: directional photo capture, a sonic ping for acoustics, and optional LiDAR import.",
      },
      { property: "og:title", content: "Capture a space" },
      {
        property: "og:description",
        content:
          "Directional photo capture, sonic acoustic probe and optional LiDAR import, straight from your phone.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: CapturePage,
});

interface Shot {
  blob: Blob;
  url: string;
  heading: number | null;
  pitch: number | null;
  roll: number | null;
  /** Inertial pose relative to the first frame (SLAM-style dead reckoning). */
  pose: Pose | null;
  /** Estimated horizontal field of view of the lens that took this frame. */
  fov_deg: number | null;
  lens: string | null;
  ultra_wide: boolean;
  /** Which explicit standing position this frame was shot from. */
  station: number;
  /** Low contrast or shot while the phone was still moving. */
  weak: boolean;
  /** Luminance spread of the frame; higher is more detail. */
  deviation: number;
  /** Laplacian variance on a 160 px thumbnail; higher is sharper. */
  sharpness: number;
  /** Mean luminance, 0-255. */
  brightness: number;
  /** "low" for the downward view taken at each corner. */
  view: "level" | "low";
  /** Which viewpoint sweep produced it, so a redone sweep can replace it. */
  attempt: number;
  at: string;
}

// 12 stations, every 30°: denser overlap between frames gives the stitcher
// enough common features to keep walls and portals from being missed.
const TARGETS = [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330];

// Manual mode keeps the 12-target ring above; automatic capture uses the five
// explicit viewpoints below.

/**
 * Explicit capture stations. Taps are the source of truth: station 0 is the
 * center, subsequent stations are corners, and no frames are taken in transit.
 */
const BIN_DEG = 22.5;

/**
 * Stored frame size. Sharper frames find more (and smaller) objects, at the
 * cost of upload size and image tokens (~3.7k per 1920x1440 frame vs ~1.6k at
 * 1280x960).
 */
const FRAME_MAX_EDGE = 1920;
const FRAME_JPEG_QUALITY = 0.88;

/** How long a corner waits for the downward view before moving on without it. */
const TILT_TIMEOUT_MS = 8000;
const BIN_COUNT = 16;

interface StationPlan {
  hint: string;
  /** Frames expected from this viewpoint. */
  arcBins: number;
  /** Deliberate rightward sweep from the first frame to the last. */
  sweepDeg: number;
}

const STATION_PLAN: StationPlan[] = [
  { hint: "Turn a full circle where you stand", arcBins: 16, sweepDeg: 360 },
  {
    hint: "Walk to a corner. Look slightly behind along the left wall, then pan 120° right",
    arcBins: 4,
    sweepDeg: 120,
  },
  { hint: "Next corner. Left wall through the room to the right wall", arcBins: 4, sweepDeg: 120 },
  { hint: "Third corner. Left wall through the room to the right wall", arcBins: 4, sweepDeg: 120 },
  { hint: "Last corner. Left wall through the room to the right wall", arcBins: 4, sweepDeg: 120 },
];

/** Corners the average room needs; the user may keep adding more. */
const TYPICAL_STATIONS = STATION_PLAN.length;
/** Center plus one corner is the least the solver can work with. */
const MIN_STATIONS = 2;

const stationHint = (i: number) => STATION_PLAN[i]?.hint ?? "Next corner. Left wall to right wall";
const stationArc = (i: number) => STATION_PLAN[i]?.arcBins ?? 4;
const stationSweepDeg = (i: number) => STATION_PLAN[i]?.sweepDeg ?? 120;

const headingBin = (h: number) => Math.floor((((h % 360) + 360) % 360) / BIN_DEG) % BIN_COUNT;

function angleDiff(a: number, b: number) {
  const d = Math.abs(((a - b + 540) % 360) - 180);
  return d;
}

function measureImageData(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
): { usable: boolean; deviation: number; mean: number } {
  const sampleWidth = Math.min(32, width);
  const sampleHeight = Math.min(24, height);
  if (sampleWidth < 2 || sampleHeight < 2) return { usable: false, deviation: 0, mean: 0 };
  const pixels = ctx.getImageData(0, 0, sampleWidth, sampleHeight).data;
  let sum = 0;
  let sumSq = 0;
  let min = 255;
  let max = 0;
  const count = pixels.length / 4;
  for (let i = 0; i < pixels.length; i += 4) {
    const luminance =
      0.2126 * (pixels[i] ?? 0) + 0.7152 * (pixels[i + 1] ?? 0) + 0.0722 * (pixels[i + 2] ?? 0);
    sum += luminance;
    sumSq += luminance * luminance;
    min = Math.min(min, luminance);
    max = Math.max(max, luminance);
  }
  const mean = sum / count;
  const deviation = Math.sqrt(Math.max(0, sumSq / count - mean * mean));
  const usable = !(deviation < 2 && (mean > 248 || mean < 7 || max - min < 3));
  return { usable, deviation, mean };
}

/** Focus measure of a frame, on a small grayscale thumbnail (see frame-quality.ts). */
function measureSharpness(source: HTMLCanvasElement): number {
  const width = Math.min(SHARPNESS_SAMPLE_WIDTH, source.width);
  const height = Math.max(3, Math.round((source.height / source.width) * width));
  const thumb = document.createElement("canvas");
  thumb.width = width;
  thumb.height = height;
  const ctx = thumb.getContext("2d", { willReadFrequently: true });
  if (!ctx) return 0;
  ctx.drawImage(source, 0, 0, width, height);
  return laplacianVariance(toGray(ctx.getImageData(0, 0, width, height).data), width, height);
}

/** `scan_photos.sensor_payload` for a frame; `pose` may be re-anchored (reshoots). */
function sensorPayload(shot: Shot, pose: Pose | null) {
  return JSON.parse(
    JSON.stringify({
      roll_deg: shot.roll,
      pose,
      motion_energy: shot.pose?.motion_energy ?? null,
      drift_m: shot.pose?.drift_m ?? null,
      fov_deg: shot.fov_deg,
      lens: shot.lens,
      ultra_wide: shot.ultra_wide,
      station: shot.station,
      station_kind: "viewpoint",
      view: shot.view,
      quality: {
        weak: shot.weak,
        deviation: shot.deviation,
        sharpness: shot.sharpness,
        brightness: shot.brightness,
      },
      source: "deviceorientation + devicemotion (inertial odometry)",
    }),
  );
}

const shotFrame = (shot: Shot): StationFrame => ({
  station: shot.station,
  heading_deg: shot.heading,
  motion_energy: shot.pose?.motion_energy ?? null,
  weak: shot.weak,
});

function CapturePage() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const search = Route.useSearch();
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // Stable id for this capture session — links the consent record, the
  // eventual `scans` row and the analysis request so a retried submit
  // dedupes instead of creating a second scan. See src/lib/capture-id.ts.
  const captureIdRef = useRef<string>(getOrCreateCaptureId());
  const [showConsent, setShowConsent] = useState(false);

  const [step, setStep] = useState<0 | 1 | 2 | 3 | 4>(0);
  const [mode, setMode] = useState<"auto" | "manual">("auto");
  const [autoPhase, setAutoPhase] = useState<"idle" | "sweep" | "walk" | "done">("idle");
  // The capture loop needs the phase synchronously; state alone lags a tick.
  const autoPhaseRef = useRef<"idle" | "sweep" | "walk" | "done">("idle");
  const setPhase = (p: "idle" | "sweep" | "walk" | "done") => {
    autoPhaseRef.current = p;
    setAutoPhase(p);
  };

  const [autoMsg, setAutoMsg] = useState<string | null>(null);
  const coveredRef = useRef<Set<number>>(new Set());
  const [autoCovered, setAutoCovered] = useState<number[]>([]);
  /** Which of the five capture stations the sweep is on. */
  const stationRef = useRef(0);
  const [station, setStation] = useState(0);
  /** Bumped per viewpoint sweep; frames are tagged with it (see `Shot.attempt`). */
  const attemptRef = useRef(0);
  /**
   * The viewpoint being reshot, if any. Its sweep replaces that viewpoint's
   * earlier frames instead of adding a new corner.
   */
  const reshootRef = useRef<number | null>(null);
  const [reshootStation, setReshootStation] = useState<number | null>(null);
  /** Wall ranges from the viewpoint's previous sweep, dropped once the reshoot lands. */
  const reshootOldRangesRef = useRef<WallRange[]>([]);
  /** The reshoot's sweep attempt once it has started; null while still idle. */
  const reshootAttemptRef = useRef<number | null>(null);
  const legsRef = useRef<WalkLeg[]>([]);
  const [legs, setLegs] = useState<WalkLeg[]>([]);
  const [walkDist, setWalkDist] = useState(0);

  const [lens, setLens] = useState<LensChoice | null>(null);
  const lensRef = useRef<LensChoice | null>(null);

  // --- device pickers (Zoom-style "which camera / which mic" dropdowns) ---
  // Labels are only populated by the browser after the user grants permission
  // once, so the "Detect devices" button below does a throwaway getUserMedia
  // just to unlock the labels, then stops the stream. Values persist across
  // step 0 so they're read when the real capture stream is opened.
  const [videoDevices, setVideoDevices] = useState<MediaDeviceInfo[]>([]);
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
  const [videoDeviceId, setVideoDeviceId] = useState<string>("");
  const [audioDeviceId, setAudioDeviceId] = useState<string>("");
  const [devicesDetecting, setDevicesDetecting] = useState(false);

  /** Sectors whose only frame was marginal, re-shot before the sweep ends. */
  const weakRef = useRef<Set<number>>(new Set());
  /** Exact bearings for corner frames: start wall, two overlapping interiors, end wall. */
  const cornerTargetsRef = useRef<number[]>([]);
  const [turnHint, setTurnHint] = useState<string | null>(null);
  /** Set while the last frame came out too dark. */
  const [lightWarning, setLightWarning] = useState(false);
  /** When the corner's downward view was requested; null outside that step. */
  const tiltSinceRef = useRef<number | null>(null);

  /** A draft found in IndexedDB from a previous session — offered as a resume prompt. */
  const [pendingDraft, setPendingDraft] = useState<CaptureDraft | null>(null);
  const draftHydratedRef = useRef(false);

  /** Set when we detect the phone's magnetometer is uncalibrated — nudges the user to figure-8. */
  const [compassCalibration, setCompassCalibration] = useState<"ok" | "poor" | "unknown">(
    "unknown",
  );

  const headingRef = useRef<number | null>(null);
  const steadyRef = useRef(true);
  const lastShotRef = useRef(0);
  const busyShotRef = useRef(false);
  const abortSweepRef = useRef(false);
  const micPromiseRef = useRef<Promise<void> | null>(null);
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");
  const rollRef = useRef<number | null>(null);
  const trackerRef = useRef<MotionTracker | null>(null);
  const poseRef = useRef<Pose | null>(null);
  const [steady, setSteady] = useState(true);
  const [shots, setShots] = useState<Shot[]>([]);
  const [camError, setCamError] = useState<string | null>(null);
  const [acoustics, setAcoustics] = useState<AcousticsResult | null>(null);
  /**
   * Auto-scan decay probes, one per viewpoint sweep. `acoustics` is always
   * recombined from this list, so a reshoot can swap its viewpoint's probe
   * instead of averaging it on top of the old one.
   */
  const viewpointProbesRef = useRef<
    { station: number; attempt: number; result: AcousticsResult }[]
  >([]);
  const [probeStage, setProbeStage] = useState<string | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [micReady, setMicReady] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [audioEnv, setAudioEnv] = useState<AudioEnvironment | null>(null);
  const probeRef = useRef<ProbeSession | null>(null);
  const rangesRef = useRef<WallRange[]>([]);
  const [rangeCount, setRangeCount] = useState(0);

  const [depthFile, setDepthFile] = useState<File | null>(null);
  const [depthMetrics, setDepthMetrics] = useState<DepthMetrics | null>(null);
  const [depthNote, setDepthNote] = useState<string | null>(null);
  const [depthReading, setDepthReading] = useState(false);
  const [depthSkipped, setDepthSkipped] = useState(false);
  const [uploadPct, setUploadPct] = useState(0);
  const [working, setWorking] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [reconPct, setReconPct] = useState(0);
  // Frames exist only in memory until uploaded, and the upload + AI pass run
  // from this tab — a reload at any point from the first frame on loses work.
  const leaveGuard = useLeaveGuard(shots.length > 0 || working !== null);
  const [geo, setGeo] = useState<{ lat: number; lon: number; accuracy: number | null } | null>(
    null,
  );
  const [geoError, setGeoError] = useState<string | null>(null);
  const [geoBusy, setGeoBusy] = useState(false);
  const [geoBlocked, setGeoBlocked] = useState<
    null | "insecure" | "embedded" | "denied" | "unsupported"
  >(null);

  // --- geolocation --------------------------------------------------------
  // IMDF needs a real-world anchor: without lat/long the venue can't be placed.
  //
  // getCurrentPosition MUST be called from a user gesture on Safari (and
  // increasingly on Chrome when the page runs inside an iframe such as the
  // Lovable preview). Auto-firing on mount silently burns the prompt and
  // caches a denial, after which subsequent button clicks are ignored.
  const requestLocation = useCallback(() => {
    if (typeof window === "undefined") return;
    if (!("geolocation" in navigator)) {
      setGeoBlocked("unsupported");
      setGeoError("This browser can't report location.");
      return;
    }
    if (!window.isSecureContext) {
      setGeoBlocked("insecure");
      setGeoError("Location needs an HTTPS connection.");
      return;
    }
    let embedded = false;
    try {
      embedded = window.self !== window.top;
    } catch {
      embedded = true;
    }
    if (embedded) {
      setGeoBlocked("embedded");
      setGeoError("Location is blocked inside embedded previews. Open the deployed URL directly.");
      return;
    }
    setGeoError(null);
    setGeoBlocked(null);
    setGeoBusy(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setGeoBusy(false);
        setGeo({
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          accuracy: Number.isFinite(pos.coords.accuracy) ? pos.coords.accuracy : null,
        });
      },
      (err) => {
        setGeoBusy(false);
        // PERMISSION_DENIED (1) can't be re-prompted by JS; the user has to
        // clear the site's location permission in the browser first. On iOS
        // Safari that lives under aA → Website Settings → Location.
        if (err.code === err.PERMISSION_DENIED) {
          setGeoBlocked("denied");
          setGeoError(
            "Location is blocked for this site. On iOS Safari, tap \u201caA\u201d in the URL bar → Website Settings → Location → Ask, then reload. On macOS Safari, Safari → Settings → Websites → Location → set this site to Ask.",
          );
        } else {
          setGeoError(err.message || "Location unavailable");
        }
        logger.warn("geolocation", "getCurrentPosition failed", {
          code: err.code,
          message: err.message,
        });
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 },
    );
  }, []);

  // Check upfront whether permission was already denied so we can surface
  // guidance without firing another silent prompt.
  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.permissions?.query) return;
    navigator.permissions
      .query({ name: "geolocation" as PermissionName })
      .then((status) => {
        if (status.state === "denied") setGeoBlocked("denied");
      })
      .catch(() => {
        /* permissions API unavailable — ignore */
      });
  }, []);

  // Elapsed seconds while uploading / reconstructing, plus a modelled progress
  // curve for the AI pass (the server gives no incremental signal).
  useEffect(() => {
    if (!working) return;
    const started = Date.now();
    const id = window.setInterval(() => {
      const secs = Math.round((Date.now() - started) / 1000);
      setElapsed(secs);
      setReconPct(Math.min(96, Math.round(100 * (1 - Math.exp(-secs / 45)))));
    }, 1000);
    return () => window.clearInterval(id);
  }, [working]);

  useEffect(() => {
    if (!loading && !user) navigate({ to: "/auth" });
  }, [loading, user, navigate]);

  // --- reshoot of a saved scan ------------------------------------------
  // `?reshoot=<scanId>&station=<n>`: load the scan and how each viewpoint
  // looks today, so the intro can show which one is being replaced.
  const [target, setTarget] = useState<{
    scanId: string;
    name: string;
    status: string;
    notes: unknown;
    createdAt: string | null;
    /** The saved frames, merged with this visit's reshoots on the review screen. */
    frames: StationFrame[];
    health: StationHealth[];
  } | null>(null);

  useEffect(() => {
    const scanId = search.reshoot;
    if (!user || !scanId) return;
    let cancelled = false;
    void (async () => {
      const detail = await spaces.get(scanId).catch(() => null);
      if (cancelled) return;
      if (!detail) {
        toast.error("Space not found");
        navigate({ to: "/" });
        return;
      }
      setName(detail.scan.name);
      const savedFrames = detail.photos.map(stationFrameFromPhoto);
      setTarget({
        scanId,
        name: detail.scan.name,
        status: detail.scan.status,
        notes: detail.scan.analysis_notes,
        createdAt: detail.scan.created_at,
        frames: savedFrames,
        health: assessStations(savedFrames),
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [user, search.reshoot, navigate]);

  const reshootBlocked =
    target &&
    target.status === "processing" &&
    !isAnalysisStale({
      status: target.status,
      analysis_notes: target.notes,
      created_at: target.createdAt,
    })
      ? "This space is still being reconstructed. Reshoot once it finishes."
      : null;

  // --- draft autosave -----------------------------------------------------
  // Phones die, tabs get killed, calls interrupt the wizard. Persist enough
  // metadata to /somewhere/ that we can offer "resume where you left off"
  // when the user returns. We never persist the raw shot buffer — it's too
  // large for synchronous IndexedDB writes mid-capture — but we do snapshot
  // step, mode, name, notes, station, and shot counts.
  useEffect(() => {
    // A reshoot of a saved scan isn't a new capture to resume.
    if (!user || draftHydratedRef.current || search.reshoot) return;
    draftHydratedRef.current = true;
    loadCaptureDraft(user.id)
      .then((draft) => {
        if (draft && draft.step > 0) setPendingDraft(draft);
      })
      .catch(() => {
        /* draft load is best-effort */
      });
  }, [user, search.reshoot]);

  useEffect(() => {
    if (!user || search.reshoot) return;
    // Don't write until user has entered anything meaningful — avoids stomping
    // an existing draft with an empty one on first mount.
    if (step === 0 && !name && !notes && shots.length === 0) return;
    const draft: CaptureDraft = {
      userId: user.id,
      updatedAt: Date.now(),
      step,
      mode,
      name,
      notes,
      station,
      shotsCount: shots.length,
      hasGeo: !!geo,
      hasAcoustics: !!acoustics,
    };
    const t = window.setTimeout(() => {
      void saveCaptureDraft(draft);
    }, 400);
    return () => window.clearTimeout(t);
  }, [user, search.reshoot, step, mode, name, notes, station, shots.length, geo, acoustics]);

  // --- compass calibration watchdog --------------------------------------
  // The sweep pipeline picks a "sharpest photo per compass sector"; if the
  // magnetometer is uncalibrated (common after a phone reboot or near steel
  // door frames), every sector gets the same heading and the reconstruction
  // silently fails. iOS reports accuracy via `webkitCompassAccuracy` (lower
  // is better; > 20° is unreliable). Elsewhere we fall back to a heading
  // variance heuristic: if the phone reports the SAME heading for 30 samples
  // while the user is clearly moving, that's a stuck compass.
  useEffect(() => {
    if (step !== 1) return;
    if (typeof window === "undefined") return;

    let lastHeading: number | null = null;
    let stuckCount = 0;

    const handler = (e: DeviceOrientationEvent) => {
      const accuracy = (e as DeviceOrientationEvent & { webkitCompassAccuracy?: number | null })
        .webkitCompassAccuracy;
      if (typeof accuracy === "number") {
        if (accuracy < 0 || accuracy > 20) {
          setCompassCalibration("poor");
          return;
        }
        setCompassCalibration("ok");
        return;
      }
      const heading =
        (e as DeviceOrientationEvent & { webkitCompassHeading?: number }).webkitCompassHeading ??
        (typeof e.alpha === "number" ? (360 - e.alpha) % 360 : null);
      if (heading == null) return;
      if (lastHeading != null && Math.abs(heading - lastHeading) < 0.05) {
        stuckCount += 1;
        if (stuckCount > 30) setCompassCalibration("poor");
      } else {
        stuckCount = 0;
        setCompassCalibration("ok");
      }
      lastHeading = heading;
    };

    window.addEventListener("deviceorientation", handler, true);
    return () => window.removeEventListener("deviceorientation", handler, true);
  }, [step]);

  // --- compass + inertial odometry ----------------------------------------
  // The compass says where the phone points; the accelerometer says where it
  // moved. Every frame is stamped with a pose relative to frame 1, so the
  // reconstruction can stitch by delta instead of assuming a fixed viewpoint.
  const startOrientation = useCallback(async () => {
    const tracker = trackerRef.current ?? new MotionTracker();
    trackerRef.current = tracker;
    await tracker.start((p) => {
      poseRef.current = p;
      if (p.heading != null) headingRef.current = p.heading;
      rollRef.current = p.roll;
      setSteady(p.motion_energy < 0.6);
      steadyRef.current = p.motion_energy < 1.4;
      if (autoPhaseRef.current === "walk" && walkStartRef.current) {
        setWalkDist(Math.hypot(p.x - walkStartRef.current.x, p.y - walkStartRef.current.y));
      }
    });
  }, []);

  useEffect(() => () => trackerRef.current?.stop(), []);

  // --- device enumeration -------------------------------------------------
  // Populates the camera/mic dropdowns. On first mount and on `devicechange`
  // (a bluetooth headset connects, a webcam is plugged in), refresh the lists.
  // Labels stay empty until the user has granted permission at least once —
  // that's what `detectDevices` handles below.
  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      setVideoDevices(all.filter((d) => d.kind === "videoinput"));
      setAudioDevices(all.filter((d) => d.kind === "audioinput"));
    } catch {
      /* enumeration is best-effort; fall back to browser defaults */
    }
  }, []);

  useEffect(() => {
    void refreshDevices();
    const md = navigator.mediaDevices;
    if (!md) return;
    const onChange = () => void refreshDevices();
    md.addEventListener?.("devicechange", onChange);
    return () => md.removeEventListener?.("devicechange", onChange);
  }, [refreshDevices]);

  // One-shot permission unlock so device labels populate. Zoom/Teams do the
  // same thing on their pre-join screen: open a stream just long enough for
  // the browser to hand back real labels, then release it.
  const detectDevices = useCallback(async () => {
    setDevicesDetecting(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: true,
      });
      stream.getTracks().forEach((t) => t.stop());
      await refreshDevices();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not access camera or mic to list devices.",
      );
    } finally {
      setDevicesDetecting(false);
    }
  }, [refreshDevices]);

  // --- camera ------------------------------------------------------------
  // Plain rear camera. Mobile Safari only names the individual lenses after
  // permission is granted and routinely refuses a request for a specific one,
  // so asking for the 0.5x module by id just returns the standard camera with
  // extra steps. The true field of view is read back off the live track.
  const startCamera = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          // `ideal` so a picked deviceId that the browser refuses (Safari
          // routinely does this for the ultra-wide module) falls back to the
          // default rear camera instead of throwing.
          ...(videoDeviceId
            ? { deviceId: { ideal: videoDeviceId } }
            : { facingMode: { ideal: "environment" } }),
          width: { ideal: 1920 },
        },
        audio: false,
      });
      streamRef.current = stream;
      const described = describeLensFromTrack(stream.getVideoTracks()[0]);
      if (described) {
        lensRef.current = described;
        setLens(described);
      }
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setCamError(null);
      // Labels are now populated (permission granted) — refresh so a user
      // going back to step 0 sees real device names next time.
      void refreshDevices();
    } catch (err) {
      setCamError(
        err instanceof Error ? err.message : "Camera unavailable. Allow camera access and reload.",
      );
    }
  }, [refreshDevices, videoDeviceId]);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  useEffect(() => stopCamera, [stopCamera]);

  // Leaving the page mid-sweep must stop the auto loop.
  useEffect(
    () => () => {
      abortSweepRef.current = true;
      runningRef.current = false;
      probeRef.current?.close();
      probeRef.current = null;
    },
    [],
  );

  const beginCapture = async () => {
    if (!name.trim()) {
      toast.error("Give the space a name first");
      return;
    }
    // Gate on consent before touching camera/mic. Consent is scoped to the
    // capture session id so a resumed draft doesn't re-prompt.
    if (!hasLocalConsent(captureIdRef.current)) {
      setShowConsent(true);
      return;
    }
    await startCaptureSession();
  };

  /** Runs after consent is confirmed (either already-given or just accepted). */
  const startCaptureSession = async () => {
    // Must run inside the tap: iOS only unlocks the audio output path while
    // user activation is alive, so the mic/AudioContext is claimed first.
    setShots((previous) => {
      for (const shot of previous) URL.revokeObjectURL(shot.url);
      return [];
    });
    rangesRef.current = [];
    viewpointProbesRef.current = [];
    setAcoustics(null);
    legsRef.current = [];
    walkStartRef.current = null;
    stationsDoneRef.current = 0;
    setLegs([]);
    setStationsDone(0);
    setRangeCount(0);
    setStation(0);
    setPhase("idle");
    setStep(1);
    markPhase("capture_started", { captureId: captureIdRef.current, mode });
    await startOrientation();
    await startCamera();
    markPhase("camera_ready");
  };

  /** Start the camera for the viewpoint a `?reshoot=` visit is replacing. */
  const startExistingReshoot = async () => {
    if (search.station == null) return;
    dropShots(() => true);
    rangesRef.current = [];
    setRangeCount(0);
    setMode("auto");
    markPhase("reshoot_started", { scanId: search.reshoot, station: search.station });
    await beginReshoot(search.station);
  };

  const beginExistingReshoot = async () => {
    if (!hasLocalConsent(captureIdRef.current)) {
      setShowConsent(true);
      return;
    }
    await startExistingReshoot();
  };

  const handleConsentAccept = () => {
    persistLocalConsent(captureIdRef.current);
    setShowConsent(false);
    const consentData: { captureId: string; consentVersion: string; userAgent?: string } = {
      captureId: captureIdRef.current,
      consentVersion: CONSENT_VERSION,
    };
    if (typeof navigator !== "undefined") consentData.userAgent = navigator.userAgent.slice(0, 500);
    spaces
      .recordConsent(consentData)
      .catch((e: unknown) =>
        logger.warn("consent", "recording capture consent failed", { err: String(e) }),
      );
    void (search.reshoot ? startExistingReshoot() : startCaptureSession());
  };

  /** Grab one frame from the live video at the current pose. */
  const grabFrame = useCallback((view: "level" | "low" = "level") => {
    return new Promise<{ ok: boolean; weak: boolean; dark: boolean }>((resolve) => {
      const fail = () => resolve({ ok: false, weak: true, dark: false });
      const video = videoRef.current;
      if (!video || !video.videoWidth) {
        fail();
        return;
      }
      // Long edge capped at FRAME_MAX_EDGE: current Claude models read up to
      // 2576 px, and small devices and brand markings need the detail.
      const scale = Math.min(FRAME_MAX_EDGE / Math.max(video.videoWidth, video.videoHeight), 1);
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        fail();
        return;
      }
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const sample = document.createElement("canvas");
      sample.width = Math.min(32, canvas.width);
      sample.height = Math.min(24, canvas.height);
      const sampleCtx = sample.getContext("2d", { willReadFrequently: true });
      if (!sampleCtx) {
        fail();
        return;
      }
      sampleCtx.drawImage(canvas, 0, 0, sample.width, sample.height);
      const quality = measureImageData(sampleCtx, sample.width, sample.height);
      if (!quality.usable) {
        fail();
        return;
      }
      const at = new Date().toISOString();
      const attempt = attemptRef.current;
      const h = headingRef.current;
      const p = poseRef.current;
      const lensNow = lensRef.current;
      // A frame is "weak" when it is blurry, dark, low-contrast or was taken
      // while the phone was still swinging: usable, but worth re-shooting
      // before the sweep ends.
      const sharpness = measureSharpness(canvas);
      const { weak, dark } = assessFrame({
        sharpness,
        brightness: quality.mean,
        deviation: quality.deviation,
        motionEnergy: p?.motion_energy ?? null,
      });
      canvas.toBlob(
        (blob) => {
          // The sweep was cancelled while this frame was encoding.
          if (!blob || attemptRef.current !== attempt) {
            fail();
            return;
          }
          setShots((prev) => {
            if (prev.length === 0) trackerRef.current?.resetOrigin();
            return [
              ...prev,
              {
                blob,
                url: URL.createObjectURL(blob),
                heading: h,
                pitch: poseRef.current?.pitch ?? null,
                roll: rollRef.current,
                pose: p,
                fov_deg: lensNow?.fovDeg ?? null,
                lens: lensNow?.label ?? null,
                ultra_wide: !!lensNow?.ultraWide,
                station: stationRef.current,
                weak,
                deviation: Math.round(quality.deviation * 10) / 10,
                sharpness: Math.round(sharpness),
                brightness: Math.round(quality.mean),
                view,
                attempt,
                at,
              },
            ];
          });
          resolve({ ok: true, weak, dark });
        },
        "image/jpeg",
        FRAME_JPEG_QUALITY,
      );
    });
  }, []);

  const takeShot = () => void grabFrame();

  const coveredTargets = TARGETS.filter((t) =>
    shots.some((s) => s.heading != null && angleDiff(s.heading, t) < 16),
  );

  // Bins the ring draws for the viewpoint being swept right now.
  const arcBins = stationArc(station);

  // One progress number for the on-camera ring: whole sweeps plus the arc
  // covered inside the sweep currently under the finger.
  const sweepPct = (() => {
    if (autoPhase === "done") return 100;
    // The number of viewpoints is open-ended, so the ring shows the arc
    // covered inside the viewpoint currently being swept.
    if (autoPhase === "sweep") {
      return Math.min(100, Math.round((autoCovered.length / arcBins) * 100));
    }
    return 0;
  })();

  // Live capture-quality readout for the current viewpoint: how much of the
  // ring has been covered and how steady the frames were. Recomputed as
  // frames land; the shot list is small so this is cheap on every render.
  const currentStationShots = shots.filter((s) => s.station === station);
  const qualitySignals = computeQualitySignals({
    headings: currentStationShots.map((s) => s.heading),
    poseDrift: currentStationShots.map((s) => s.pose?.drift_m ?? null),
    targetBins: arcBins,
  });

  // Step A — must run synchronously inside the tap so iOS keeps user
  // activation for the audio output path, then requests the microphone.
  const enableMic = () => {
    probeRef.current?.close();
    probeRef.current = null;
    setMicReady(false);
    setProbeError(null);
    let session: ProbeSession;
    try {
      session = createProbeSession();
    } catch (err) {
      setProbeError(err instanceof Error ? err.message : "Audio unavailable");
      return;
    }
    probeRef.current = session;
    setProbeStage("Requesting microphone");
    micPromiseRef.current = session
      .enableMicrophone(audioDeviceId || null)
      .then(() => {
        if (probeRef.current !== session) {
          session.close();
          return;
        }
        setMicReady(true);
        setProbeStage(null);
      })
      .catch((err: unknown) => {
        if (probeRef.current !== session) return;
        setProbeStage(null);
        probeRef.current = null;
        session.close();
        const env = inspectAudioEnvironment();
        setProbeError(
          env.blocked === "embedded" && env.message
            ? env.message
            : err instanceof Error
              ? err.message
              : "Microphone unavailable",
        );
      });
  };

  const closeMicrophone = useCallback(() => {
    probeRef.current?.close();
    probeRef.current = null;
    micPromiseRef.current = null;
    setMicReady(false);
    setMicLevel(0);
    setProbeStage(null);
  }, []);

  // Live input meter while the mic is open and we're on the acoustics step.
  useEffect(() => {
    if (!micReady || step !== 2) return;
    const id = window.setInterval(() => {
      setMicLevel(probeRef.current?.level() ?? 0);
    }, 100);
    return () => window.clearInterval(id);
  }, [micReady, step]);

  useEffect(() => {
    setAudioEnv(inspectAudioEnvironment());
    return closeMicrophone;
  }, [closeMicrophone]);

  // Step B — fire the ping.
  const runProbe = async () => {
    const session = probeRef.current;
    if (!session) return;
    setProbeError(null);
    try {
      setProbeStage("Starting");
      const result = await session.runProbe(setProbeStage);
      setAcoustics(result);
      setProbeStage(null);
      toast.success(`RT60 ${result.rt60_s}s · ${result.hardness}`);
    } catch (err) {
      setProbeStage(null);
      setProbeError(err instanceof Error ? err.message : "Probe failed");
    }
  };

  // --- auto sweep ---------------------------------------------------------
  // Each viewpoint is one stationary decay measurement followed by a pan.
  // Frames only start once the room's decay has been recorded, so the blast is
  // never smeared by movement.
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /** Replace the viewpoint probe list and recombine the scan's acoustics from it. */
  const setViewpointProbes = (probes: typeof viewpointProbesRef.current) => {
    viewpointProbesRef.current = probes;
    setAcoustics(combineViewpointProbes(probes.map((p) => p.result)));
  };

  // Three chirps, like the manual probe: the median shrugs off one bad chirp
  // (a passing noise, a speaker glitch), and the viewpoint only loses its
  // acoustics if all three go unheard.
  const fireDecayProbe = async (): Promise<AcousticsResult | null> => {
    const waitStart = Date.now();
    while (!probeRef.current && Date.now() - waitStart < 8000) await sleep(200);
    const session = probeRef.current;
    if (!session) return null;
    try {
      await Promise.race([micPromiseRef.current ?? Promise.resolve(), sleep(9000)]);
      return await session.runProbe((s) => setAutoMsg(`Hold still. ${s}`));
    } catch (err) {
      setProbeError(err instanceof Error ? err.message : "Probe failed");
      return null;
    }
  };

  // Taps define station boundaries. Motion is measured only between them.
  const runningRef = useRef(false);
  const walkStartRef = useRef<ReturnType<MotionTracker["anchor"]> | null>(null);
  const stationsDoneRef = useRef(0);
  const [stationsDone, setStationsDone] = useState(0);
  /** Frames stay locked until this viewpoint's decay has been recorded. */
  const decayReadyRef = useRef(false);
  const [decayReady, setDecayReady] = useState(false);

  /**
   * Capture only the active viewpoint. Walks never produce image frames.
   */
  const runScan = async () => {
    while (runningRef.current && !abortSweepRef.current) {
      await sleep(70);
      const now = Date.now();
      if (busyShotRef.current) continue;

      const h = headingRef.current;
      if (autoPhaseRef.current !== "sweep") continue;
      // Stand still while the blast decays: no frames until it is measured.
      if (!decayReadyRef.current) continue;

      // A corner sweep ends with one downward view across the floor: low
      // furniture and anything under a table. Skipped if the phone reports no
      // tilt or the user doesn't tilt within TILT_TIMEOUT_MS.
      if (tiltSinceRef.current != null) {
        const pitch = poseRef.current?.pitch;
        if (pitch == null || now - tiltSinceRef.current > TILT_TIMEOUT_MS) {
          finishViewpoint();
          return;
        }
        if (pitch < LOW_VIEW_PITCH.min || pitch > LOW_VIEW_PITCH.max) {
          setTurnHint(
            pitch > LOW_VIEW_PITCH.max
              ? "Tilt the phone down toward the floor"
              : "Tilt up a little",
          );
          continue;
        }
        if (!steadyRef.current) {
          setTurnHint("Hold still");
          continue;
        }
        setTurnHint(null);
        busyShotRef.current = true;
        const low = await grabFrame("low");
        busyShotRef.current = false;
        if (low.ok) {
          finishViewpoint();
          return;
        }
        continue;
      }

      if (h == null) continue;

      const targets = cornerTargetsRef.current;
      const pendingTarget =
        stationRef.current > 0
          ? targets.find((target) => !coveredRef.current.has(target) && angleDiff(h, target) <= 14)
          : null;
      const center = stationRef.current > 0 ? pendingTarget : headingBin(h) * BIN_DEG;
      if (center == null) {
        setTurnHint("Pan slowly to the next marker");
        continue;
      }
      if (coveredRef.current.has(center) && !weakRef.current.has(center)) {
        setTurnHint(null);
        continue;
      }
      // Blur is the one thing worth waiting for: a smeared frame helps nobody.
      if (!steadyRef.current) {
        setTurnHint("Slow down");
        continue;
      }
      setTurnHint(null);
      if (now - lastShotRef.current < 160) continue;
      busyShotRef.current = true;
      const shot = await grabFrame();
      busyShotRef.current = false;
      if (shot.ok) {
        setLightWarning(shot.dark);
        lastShotRef.current = now;
        coveredRef.current.add(center);
        if (shot.weak) weakRef.current.add(center);
        else weakRef.current.delete(center);
        setAutoCovered([...coveredRef.current]);
        // A corner only needs its left-wall-to-right-wall arc. Once that is
        // covered the viewpoint closes itself instead of asking for more turn.
        if (coveredRef.current.size >= stationArc(stationRef.current)) {
          if (stationRef.current > 0) {
            tiltSinceRef.current = now;
            setTurnHint("Tilt the phone down toward the floor");
            continue;
          }
          finishViewpoint();
          return;
        }
      }
    }
    setTurnHint(null);
  };

  /** Start one explicit center/corner viewpoint. */
  const startViewpoint = () => {
    if (camError || runningRef.current) return;
    const tracker = trackerRef.current;
    const reshooting = reshootRef.current;
    // A reshoot returns to a viewpoint already walked to; it is not a new leg.
    if (reshooting == null && walkStartRef.current && tracker) {
      const leg = makeLeg(legsRef.current.length, walkStartRef.current, tracker.anchor());
      legsRef.current = [...legsRef.current, leg];
      setLegs(legsRef.current);
      walkStartRef.current = null;
    }
    runningRef.current = true;
    abortSweepRef.current = false;
    tiltSinceRef.current = null;
    setLightWarning(false);
    coveredRef.current = new Set();
    weakRef.current = new Set();
    cornerTargetsRef.current = [];
    setAutoCovered([]);
    decayReadyRef.current = false;
    setDecayReady(false);
    const attempt = attemptRef.current + 1;
    attemptRef.current = attempt;
    const stationId = reshooting ?? stationsDoneRef.current;
    if (reshooting != null) {
      reshootAttemptRef.current = attempt;
      // Kept until the new sweep completes, so a cancelled reshoot loses nothing.
      reshootOldRangesRef.current = rangesRef.current.filter((r) => r.station === stationId);
    }
    stationRef.current = stationId;
    setStation(stationId);
    setPhase("sweep");
    setAutoMsg("Hold still. Measuring the room decay.");

    // iOS requires this to begin synchronously inside the tap handler.
    enableMic();
    void (async () => {
      const probe = await fireDecayProbe();
      // The sweep was cancelled while the chirps were measuring.
      if (attemptRef.current !== attempt) return;
      if (probe) {
        // A reshoot keeps the viewpoint's old probe until its sweep completes
        // (see completeReshoot); a plain restart of the viewpoint replaces it.
        setViewpointProbes([
          ...viewpointProbesRef.current.filter(
            (p) => reshooting != null || p.station !== stationId,
          ),
          { station: stationId, attempt, result: probe },
        ]);
        // The stationary blast doubles as a cross-check on room size: the first
        // reflection is the distance to the nearest large surface. It is kept
        // as advisory evidence only, never as the primary scale.
        const heading = headingRef.current;
        if (probe.reflection_distance_m != null && probe.first_reflection_ms != null) {
          rangesRef.current = [
            ...rangesRef.current,
            {
              station: stationId,
              heading_deg: heading,
              distance_m: probe.reflection_distance_m,
              delay_ms: probe.first_reflection_ms,
              snr_db: probe.ping_snr_db,
              measured_at: probe.measured_at,
            },
          ];
          setRangeCount(rangesRef.current.length);
        }
      }
      decayReadyRef.current = true;
      setDecayReady(true);
      if (stationId > 0) {
        const start = headingRef.current;
        if (start != null) {
          const span = stationSweepDeg(stationId);
          cornerTargetsRef.current = Array.from(
            { length: stationArc(stationId) },
            (_, index) =>
              (((start + (span * index) / (stationArc(stationId) - 1)) % 360) + 360) % 360,
          );
        }
      }
      setAutoMsg(`Start turning. ${stationHint(stationId)}`);
    })();

    void runScan();
  };

  const finishViewpoint = () => {
    if (autoPhaseRef.current !== "sweep") return;
    const arc = stationArc(stationRef.current);
    const minimumDirections = Math.min(arc, Math.max(3, arc - 2));
    if (coveredRef.current.size < minimumDirections) {
      toast.error(`Keep turning until ${minimumDirections} clear directions are captured`);
      return;
    }

    runningRef.current = false;
    decayReadyRef.current = false;
    setDecayReady(false);
    if (reshootRef.current != null) {
      completeReshoot();
      return;
    }
    const completed = stationsDoneRef.current + 1;
    stationsDoneRef.current = completed;
    setStationsDone(completed);
    closeMicrophone();
    // The scan never ends on its own: the user keeps adding corners until
    // they tap finish, so any room shape is supported.
    walkStartRef.current = trackerRef.current?.anchor() ?? null;
    setWalkDist(0);
    setPhase("walk");
    setAutoMsg(
      completed >= MIN_STATIONS
        ? "Walk to the next corner and tap to scan it, or tap finish."
        : "Walk to a corner, then tap to scan it",
    );
  };

  const dropShots = (drop: (shot: Shot) => boolean) =>
    setShots((prev) => {
      const keep = prev.filter((shot) => !drop(shot));
      for (const shot of prev) if (!keep.includes(shot)) URL.revokeObjectURL(shot.url);
      return keep;
    });

  const clearReshoot = () => {
    reshootRef.current = null;
    reshootAttemptRef.current = null;
    reshootOldRangesRef.current = [];
    setReshootStation(null);
  };

  /** Go back into the camera to redo one viewpoint of this capture. */
  const beginReshoot = async (id: number) => {
    reshootRef.current = id;
    reshootAttemptRef.current = null;
    setReshootStation(id);
    walkStartRef.current = null;
    setPhase("idle");
    setAutoMsg(null);
    setStep(1);
    await startOrientation();
    await startCamera();
  };

  /** The reshoot sweep is complete: its frames replace the viewpoint's earlier ones. */
  const completeReshoot = () => {
    const id = reshootRef.current;
    const attempt = reshootAttemptRef.current;
    if (id == null) return;
    dropShots((shot) => shot.station === id && shot.attempt !== attempt);
    const old = reshootOldRangesRef.current;
    rangesRef.current = rangesRef.current.filter((r) => !old.includes(r));
    setRangeCount(rangesRef.current.length);
    // Only drop the old probe if the reshoot produced a replacement.
    if (viewpointProbesRef.current.some((p) => p.station === id && p.attempt === attempt)) {
      setViewpointProbes(
        viewpointProbesRef.current.filter((p) => p.station !== id || p.attempt === attempt),
      );
    }
    clearReshoot();
    toast.success(`${stationLabel(id)} reshot`);
    endCapture();
  };

  /** Abandon a reshoot: keep the viewpoint's previous frames and ranges. */
  const cancelReshoot = () => {
    const id = reshootRef.current;
    const attempt = reshootAttemptRef.current;
    if (id == null) return;
    runningRef.current = false;
    abortSweepRef.current = true;
    decayReadyRef.current = false;
    setDecayReady(false);
    if (attempt != null) {
      // Bumping the attempt also drops frames still encoding (see grabFrame).
      attemptRef.current += 1;
      dropShots((shot) => shot.attempt === attempt);
      const old = reshootOldRangesRef.current;
      rangesRef.current = rangesRef.current.filter((r) => r.station !== id || old.includes(r));
      setRangeCount(rangesRef.current.length);
      setViewpointProbes(viewpointProbesRef.current.filter((p) => p.attempt !== attempt));
    }
    const kept = shots.filter((shot) => attempt == null || shot.attempt !== attempt);
    clearReshoot();
    if (search.reshoot && kept.length === 0) {
      // Nothing captured for the saved scan yet: back to its intro.
      closeMicrophone();
      stopCamera();
      setPhase("idle");
      setAutoMsg(null);
      setStep(0);
      return;
    }
    endCapture();
  };

  const endCapture = () => {
    runningRef.current = false;
    decayReadyRef.current = false;
    setDecayReady(false);
    closeMicrophone();
    setPhase("done");
    setAutoMsg(null);
    stopCamera();
    setStep(4);
  };

  const finish = async () => {
    if (!user) return;
    if (shots.length === 0) {
      toast.error("Capture at least one frame");
      return;
    }
    closeMicrophone();
    setWorking("Creating space");
    markPhase("submit_start", { captureId: captureIdRef.current, shots: shots.length });
    const track = summarisePoses(shots.map((sh) => sh.pose));
    const wallRanges = rangesRef.current;
    const measuredShell = wallRanges.length ? shellFromRanges(wallRanges) : null;
    const walkLegs = legsRef.current;
    // The walked legs are now the solver's odometry prior rather than the last
    // word on room size: the server re-solves them against the landmark
    // bearings, so a drifted step can be corrected instead of believed.
    const stationSeeds = stationPositions(walkLegs);
    const geometry = stationConditioning(stationSeeds);

    try {
      // Idempotent per capture id: a retried submit gets the same space back.
      const created = await spaces.create({
        captureId: captureIdRef.current,
        name: name.trim() || "Untitled space",
        notes: notes.trim() || null,
        acoustics: acoustics ? JSON.parse(JSON.stringify(acoustics)) : {},
        analysisNotes: JSON.parse(
          JSON.stringify({
            ...(geo
              ? {
                  geo: {
                    lat: geo.lat,
                    lon: geo.lon,
                    accuracy_m: geo.accuracy,
                    source: "device-gps",
                  },
                }
              : {}),
            track,
            ...(wallRanges.length ? { wall_ranges: wallRanges } : {}),
            ...(measuredShell ? { measured_shell: measuredShell } : {}),
            ...(walkLegs.length ? { walk_legs: walkLegs } : {}),
            station_seeds: stationSeeds,
            station_geometry: geometry,
            stations: Math.max(1, stationsDoneRef.current),
            capture_mode: mode,
          }),
        ),
        ...(geo ? { siteLocation: { lat: geo.lat, lon: geo.lon } } : {}),
        depthProvided: !!depthFile,
        depthMetrics: depthMetrics ? JSON.parse(JSON.stringify(depthMetrics)) : {},
        scaleReference: depthMetrics
          ? "depth-measured"
          : depthFile
            ? "depth-import"
            : measuredShell
              ? "acoustic-ranging"
              : "vision-only",
        depthSource: depthFile
          ? (depthFile.name.split(".").pop()?.toUpperCase() ?? "import")
          : null,
      });
      const scan = { id: created.scan.id, name: created.scan.name };

      if (geo) {
        // Resolve a real street address from the GPS fix (server-side reverse geocode).
        spaces
          .resolveAddress(scan.id, geo.lat, geo.lon)
          .catch((e: unknown) => logger.error("capture", "address resolve failed", e));
      }

      // Frames go straight to Blob Storage with create-only URLs. A retried
      // submit whose frames already made it doesn't upload them twice.
      const saved = await spaces.get(scan.id);
      if (saved.photos.length === 0) {
        setWorking(depthFile ? "Uploading frames and depth capture" : "Uploading frames");
        const uploads: (FrameUpload | DepthUpload)[] = shots.map((shot) => ({
          kind: "frame",
          blob: shot.blob,
          headingDeg: shot.heading,
          pitchDeg: shot.pitch,
          capturedAt: shot.at,
          sensorPayload: sensorPayload(shot, shot.pose),
        }));
        if (depthFile) uploads.push({ kind: "depth", blob: depthFile, fileName: depthFile.name });
        await uploadToScan(api, scan.id, uploads, {
          onProgress: (fraction) => setUploadPct(Math.round(fraction * 100)),
        });
      }
      setUploadPct(100);

      setWorking("Reconstructing space with AI");
      // The frames are safe in storage and the worker finishes the run on its
      // own, so a slow reconstruction shouldn't hold the user on a progress
      // bar. Past RECON_HANDOFF_MS, hand off to the catalog (which refreshes
      // processing scans) and keep following the run in the background.
      let handedOff = false;
      const reconstruction = (async () => {
        try {
          await runAnalysis(api, scan.id, {
            captureId: captureIdRef.current,
            onProgress: (p) => {
              if (!handedOff) setWorking(`Reconstructing space with AI: ${p.message}`);
            },
          });
          markPhase("submit_done", { scanId: scan.id });
          if (handedOff) {
            toast.success(`"${scan.name}" is reconstructed`, {
              action: {
                label: "View",
                onClick: () => navigate({ to: "/space/$id", params: { id: scan.id } }),
              },
            });
          } else {
            toast.success("Space reconstructed");
          }
        } catch (aErr) {
          markPhase("submit_failed", { scanId: scan.id });
          // The capture is safe in storage, and the server marks a failed run
          // on the scan itself, so the space page offers the retry.
          logger.warn("capture", "analysis failed", {
            err: aErr instanceof Error ? aErr.message : String(aErr),
          });
          toast.error("Capture saved, but analysis failed. Retry it from the space page.");
        }
      })();
      let handoffTimer = 0;
      const finishedInTime = await Promise.race([
        reconstruction.then(() => true),
        new Promise<false>((resolve) => {
          handoffTimer = window.setTimeout(() => resolve(false), RECON_HANDOFF_MS);
        }),
      ]);
      window.clearTimeout(handoffTimer);
      stopCamera();
      if (user) void clearCaptureDraft(user.id);
      clearCaptureId();
      leaveGuard.allowLeave();
      if (!finishedInTime) {
        handedOff = true;
        navigate({ to: "/", search: { reconstructing: scan.id } });
        return;
      }
      navigate({ to: "/space/$id", params: { id: scan.id } });
    } catch (err) {
      setWorking(null);
      toast.error(err instanceof Error ? err.message : "Capture failed");
    }
  };

  /**
   * Swap every viewpoint reshot in this visit into the saved scan, then
   * reconstruct once, so the new corners are merged with the rest of the
   * capture. New frames are uploaded before the old ones are removed: a failed
   * upload leaves the scan as it was.
   */
  const submitReshoot = async () => {
    if (!user || !target) return;
    const reshot = [...new Set(shots.map((s) => s.station))].sort((a, b) => a - b);
    if (reshot.length === 0) {
      toast.error("Scan the viewpoint first");
      return;
    }
    closeMicrophone();
    setUploadPct(0);
    setWorking("Uploading frames");
    try {
      // Re-read: the scan may have changed since this page opened.
      const detail = await spaces.get(target.scanId);
      const scan = detail.scan;
      if (scan.status === "processing" && !isAnalysisStale(scan)) {
        throw new Error("This space is still being reconstructed. Try again once it finishes.");
      }
      const notes = (scan.analysis_notes ?? {}) as Record<string, unknown>;

      const existing = detail.photos;
      const stationOf = (p: { heading_deg: number | null; sensor_payload: unknown }) =>
        stationFrameFromPhoto(p).station ?? 0;
      const replaced = existing.filter((p) => reshot.includes(stationOf(p)));

      // Poses are dead-reckoned from wherever this visit started and drift as
      // the user walks between corners. Re-anchor each viewpoint's frames on
      // its own first frame, then shift them to where the original capture put
      // that viewpoint (original frames are relative to the center's first
      // frame; the stored seeds are centroid-relative). Without a known
      // position, drop the poses rather than store misleading ones.
      const seeds = Array.isArray(notes["station_seeds"])
        ? (notes["station_seeds"] as { x: number; y: number }[])
        : [];
      const anchorFor = (stationId: number) => {
        if (stationId === 0) return { x: 0, y: 0 };
        const seed = seeds[stationId];
        const origin = seeds[0];
        return seed && origin ? { x: seed.x - origin.x, y: seed.y - origin.y } : null;
      };

      const uploads: FrameUpload[] = [];
      for (const stationId of reshot) {
        const own = shots.filter((s) => s.station === stationId);
        const anchor = anchorFor(stationId);
        const first = own.find((s) => s.pose)?.pose ?? null;
        for (const shot of own) {
          const pose =
            shot.pose && first && anchor
              ? {
                  ...shot.pose,
                  x: shot.pose.x - first.x + anchor.x,
                  y: shot.pose.y - first.y + anchor.y,
                }
              : null;
          uploads.push({
            kind: "frame",
            blob: shot.blob,
            headingDeg: shot.heading,
            pitchDeg: shot.pitch,
            capturedAt: shot.at,
            sensorPayload: { ...sensorPayload(shot, pose), reshoot: true },
          });
        }
      }
      // The server saves the new frames and removes the viewpoints' old ones
      // in one transaction: a failed upload leaves the scan as it was.
      await uploadToScan(api, target.scanId, uploads, {
        replaceStations: reshot,
        onProgress: (fraction) => setUploadPct(Math.round(fraction * 100)),
      });

      // Swap in each reshot viewpoint's new wall range; a viewpoint keeps its
      // old one if its new chirp didn't produce a usable reflection.
      let ranges = Array.isArray(notes["wall_ranges"]) ? (notes["wall_ranges"] as WallRange[]) : [];
      for (const stationId of reshot) {
        const fresh = rangesRef.current.filter((r) => r.station === stationId);
        if (fresh.length) ranges = [...ranges.filter((r) => r.station !== stationId), ...fresh];
      }
      const shell = ranges.length ? shellFromRanges(ranges) : null;
      const at = new Date().toISOString();
      const reshoots = Array.isArray(notes["reshoots"]) ? notes["reshoots"] : [];
      // Merged key by key into the scan's notes; server-written keys are kept.
      await spaces.update(target.scanId, {
        analysisNotes: JSON.parse(
          JSON.stringify({
            wall_ranges: ranges,
            ...(shell ? { measured_shell: shell } : {}),
            reshoots: [
              ...reshoots,
              ...reshot.map((stationId) => ({
                station: stationId,
                at,
                frames: shots.filter((s) => s.station === stationId).length,
                replaced: replaced.filter((p) => stationOf(p) === stationId).length,
              })),
            ],
          }),
        ),
      });

      setWorking("Reconstructing space with AI");
      const merged = reshot.map(stationLabel).join(", ");
      try {
        await runAnalysis(api, target.scanId);
        toast.success(`${merged} merged. Space reconstructed.`);
      } catch (aErr) {
        toast.error(
          `Frames replaced, but reconstruction failed: ${
            aErr instanceof Error ? aErr.message : "unknown error"
          }. Retry from the space page.`,
        );
      }
      stopCamera();
      clearCaptureId();
      leaveGuard.allowLeave();
      navigate({ to: "/space/$id", params: { id: target.scanId } });
    } catch (err) {
      setWorking(null);
      toast.error(err instanceof Error ? err.message : "Reshoot failed");
    }
  };

  // Per-viewpoint verdict for the review screen (green = good, red = reshoot).
  const captureHealth = mode === "auto" ? assessStations(shots.map(shotFrame)) : [];
  const captureNeedsReshoot = captureHealth.some((h) => h.status === "reshoot");

  // Saved-scan reshoot: the room as it will look once this visit's reshoots
  // replace their viewpoints' saved frames.
  const reshotStations = [...new Set(shots.map((s) => s.station))].sort((a, b) => a - b);
  const reshootHealth = target
    ? assessStations([
        ...target.frames.filter((f) => !reshotStations.includes(f.station ?? 0)),
        ...shots.map(shotFrame),
      ])
    : [];
  const stillRed = reshootHealth.filter((h) => h.status === "reshoot");

  const workingProgress = working ? (
    <div className="space-y-2">
      <Progress value={working.startsWith("Reconstructing") ? reconPct : uploadPct} />
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{working}…</span>
        <span className="tabular">
          {working.startsWith("Reconstructing") ? reconPct : uploadPct}% ·{" "}
          {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")}
        </span>
      </div>
    </div>
  ) : null;

  return (
    <main className="min-h-screen bg-background pb-24">
      <header className="brand-bar safe-top sticky top-0 z-10 border-b">
        <div className="flex min-h-[52px] items-center justify-between px-4 pb-3 pt-2">
          <Link to="/">
            <BrandMark />
          </Link>
          <span className="tabular rounded-full bg-secondary px-3 py-1 text-xs text-muted-foreground">
            {mode === "auto"
              ? step === 0
                ? "setup"
                : step === 1
                  ? "scanning"
                  : "review"
              : `step ${step + 1}/5`}
          </span>
        </div>
      </header>

      <div className="mx-auto w-full max-w-xl px-4 py-6">
        {/* ── step 0 ── */}
        {step === 0 && showConsent && <CaptureConsent onAccept={handleConsentAccept} />}
        {step === 0 && !showConsent && search.reshoot && search.station != null && (
          <section className="space-y-5">
            <h1 className="text-2xl font-semibold">Reshoot {stationLabel(search.station)}</h1>
            {target ? (
              <>
                <p className="text-sm text-muted-foreground">
                  {target.name}.{" "}
                  {search.station === 0
                    ? "Stand in the middle of the room, tap Start and turn a full circle."
                    : "Go to the corner marked on the map, tap Start, then scan left to right."}{" "}
                  You can reshoot other red viewpoints too; the space is reconstructed once, after
                  all of them.
                </p>
                <div className="surface-card p-4">
                  <StationHealthMap stations={target.health} highlight={search.station} />
                </div>
                {reshootBlocked && <p className="text-sm text-destructive">{reshootBlocked}</p>}
                <Button
                  className="w-full"
                  size="lg"
                  disabled={!!reshootBlocked}
                  onClick={() => void beginExistingReshoot()}
                >
                  Start
                </Button>
                <Button variant="ghost" className="w-full" asChild>
                  <Link to="/space/$id" params={{ id: target.scanId }}>
                    Cancel
                  </Link>
                </Button>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">Loading space…</p>
            )}
          </section>
        )}
        {step === 0 && !showConsent && !search.reshoot && (
          <section className="space-y-5">
            <h1 className="text-2xl font-semibold">New space</h1>
            <div className="space-y-1.5">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                value={name}
                placeholder="Studio B, kitchen, warehouse bay 3…"
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="notes">Notes (optional)</Label>
              <Textarea
                id="notes"
                value={notes}
                placeholder="Anything the analysis should know: intended use, known materials…"
                onChange={(e) => setNotes(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>Capture mode</Label>
              <div className="grid grid-cols-2 gap-2 rounded-md border border-border bg-card p-1">
                {(["auto", "manual"] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setMode(m)}
                    className={`rounded px-3 py-2 text-sm font-medium transition-colors ${
                      mode === m
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {m === "auto" ? "Auto sweep" : "Manual"}
                  </button>
                ))}
              </div>
            </div>

            <div className="rounded-md border border-border bg-card p-4 text-sm text-muted-foreground">
              <p className="mb-2 font-medium text-foreground">What happens next</p>
              {mode === "auto" ? (
                <ol className="list-decimal space-y-1 pl-4">
                  <li>
                    Stand in the middle of the room and tap once. Camera, mic and compass come on
                    together.
                  </li>

                  <li>
                    Hold still while three loud pings sound and their decay is measured, then turn
                    one slow full circle. 16 frames fire on their own, then tap to close the
                    viewpoint.
                  </li>
                  <li>
                    Walk to a corner. The phone measures the walk itself, so keep it in your hand.
                  </li>
                  <li>
                    Tap while aimed slightly behind along the left wall, hold still for the pings,
                    then pan 120° right. Four frames capture both walls and two overlapping interior
                    views.
                  </li>
                  <li>
                    Four corners plus the center is 32 frames total. {TYPICAL_STATIONS - 1} corners
                    is typical, {MIN_STATIONS} viewpoints is the minimum, and there is no upper
                    limit.
                  </li>
                  <li>
                    Tap reconstruct whenever you are satisfied. AI rebuilds the shell, portals,
                    surfaces and the major furniture from every viewpoint.
                  </li>
                </ol>
              ) : (
                <ol className="list-decimal space-y-1 pl-4">
                  <li>
                    Stand near the middle of the room and turn slowly, tapping to capture each
                    heading.
                  </li>
                  <li>Your phone plays three pings and records the decay to measure acoustics.</li>
                  <li>Optionally import a LiDAR/photogrammetry export for true scale.</li>
                  <li>AI reconstructs dimensions, objects, surfaces and portals.</li>
                </ol>
              )}
            </div>
            <div className="rounded-md border border-border bg-card p-4 text-sm">
              <p className="mb-1 font-medium text-foreground">Geo anchor</p>
              {geo ? (
                <p className="tabular text-muted-foreground">
                  {geo.lat.toFixed(6)}, {geo.lon.toFixed(6)}
                  {geo.accuracy != null ? ` ±${Math.round(geo.accuracy)} m` : ""}
                </p>
              ) : (
                <div className="flex items-center justify-between gap-3">
                  <p className="text-muted-foreground">
                    {geoError ?? "Tap Enable to share your location. Needed for IMDF export."}
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={requestLocation}
                    disabled={
                      geoBusy ||
                      geoBlocked === "insecure" ||
                      geoBlocked === "embedded" ||
                      geoBlocked === "unsupported"
                    }
                  >
                    {geoBusy ? "Requesting…" : geoBlocked === "denied" ? "Try again" : "Enable"}
                  </Button>
                </div>
              )}
            </div>
            <div className="rounded-md border border-border bg-card p-4 text-sm">
              <div className="mb-3 flex items-center justify-between">
                <p className="font-medium text-foreground">Camera &amp; microphone</p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={detectDevices}
                  disabled={devicesDetecting}
                >
                  {devicesDetecting
                    ? "Detecting…"
                    : videoDevices.some((d) => d.label)
                      ? "Re-detect"
                      : "Detect devices"}
                </Button>
              </div>
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="camera-select" className="flex items-center gap-1.5 text-xs">
                    <Camera className="size-3.5" /> Camera
                  </Label>
                  <Select
                    value={videoDeviceId || "default"}
                    onValueChange={(v) => setVideoDeviceId(v === "default" ? "" : v)}
                  >
                    <SelectTrigger id="camera-select">
                      <SelectValue placeholder="System default (rear camera)" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="default">System default (rear camera)</SelectItem>
                      {videoDevices.map((d, i) => (
                        <SelectItem key={d.deviceId || `v-${i}`} value={d.deviceId || `v-${i}`}>
                          {d.label || `Camera ${i + 1}`}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="mic-select" className="flex items-center gap-1.5 text-xs">
                    <Mic className="size-3.5" /> Microphone
                  </Label>
                  <Select
                    value={audioDeviceId || "default"}
                    onValueChange={(v) => setAudioDeviceId(v === "default" ? "" : v)}
                  >
                    <SelectTrigger id="mic-select">
                      <SelectValue placeholder="System default microphone" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="default">System default microphone</SelectItem>
                      {audioDevices.map((d, i) => (
                        <SelectItem key={d.deviceId || `a-${i}`} value={d.deviceId || `a-${i}`}>
                          {d.label || `Microphone ${i + 1}`}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <p className="text-xs text-muted-foreground">
                  iOS Safari may ignore a specific-lens choice and hand back the standard rear
                  camera — the scan still works, but the chosen module isn't guaranteed.
                </p>
              </div>
            </div>
            <Button className="w-full" size="lg" onClick={beginCapture}>
              <Camera className="mr-2 size-4" /> {mode === "auto" ? "Start scan" : "Start capture"}
            </Button>
          </section>
        )}

        {/* ── step 1: photos ── */}
        {step === 1 && (
          <section className="space-y-4">
            <div className="relative overflow-hidden rounded-[28px] border border-border bg-black">
              <video
                ref={videoRef}
                playsInline
                muted
                className="aspect-[3/4] w-full object-cover"
              />
              {camError && (
                <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-destructive">
                  {camError}
                </div>
              )}
              {lightWarning && autoPhase === "sweep" && (
                <div className="absolute left-3 right-3 top-3 rounded-full bg-black/60 px-3 py-1.5 text-center text-xs font-medium text-white">
                  Too dark: turn on more lights for sharper frames
                </div>
              )}

              {lens && (
                <div className="absolute left-3 top-3 rounded-full border border-white/25 bg-black/35 px-3 py-1 text-[11px] font-medium text-white backdrop-blur-xl">
                  {lens.ultraWide ? "0.5× wide" : "1× wide"} · {Math.round(lens.fovDeg)}°
                </div>
              )}

              {((mode === "auto" && autoPhase !== "idle" && autoPhase !== "done") ||
                (mode === "manual" && shots.length > 0)) && (
                <QualityBar signals={qualitySignals} className="absolute bottom-3 left-3 w-40" />
              )}

              {compassCalibration === "poor" && (
                <div className="pointer-events-none absolute right-3 top-3 flex items-center gap-1.5 rounded-full border border-amber-300/40 bg-amber-500/25 px-3 py-1 text-[11px] font-semibold text-amber-50 backdrop-blur-xl">
                  <Compass className="size-3" aria-hidden />
                  Calibrate · wave phone in figure-8
                </div>
              )}

              {mode === "auto" && autoPhase === "sweep" && !steady && (
                <div className="pointer-events-none absolute inset-x-0 bottom-24 flex justify-center">
                  <div className="rounded-full border border-white/25 bg-black/50 px-3 py-1 text-[11px] font-medium text-white backdrop-blur-xl">
                    Hold steady · turning too fast
                  </div>
                </div>
              )}

              {/* Capture guidance: the sweep direction is always left wall to
                  right wall, while the user owns start and stop. */}
              {mode === "auto" && autoPhase !== "done" && (
                <div className="pointer-events-none absolute inset-x-3 top-3 flex flex-col items-center gap-1.5">
                  <div className="rounded-full border border-white/25 bg-black/45 px-3.5 py-1.5 text-center text-[12px] font-semibold text-white backdrop-blur-xl">
                    {autoPhase === "sweep"
                      ? !decayReady
                        ? "Hold still · measuring decay"
                        : station === 0
                          ? "Center · turn one slow full circle"
                          : "Left wall · pan 120° right · right wall"
                      : stationsDone === 0
                        ? "Stand in the center, then tap to start"
                        : "Walk to the next corner, then tap to scan"}
                  </div>
                  {autoPhase === "sweep" && decayReady && station > 0 && (
                    <div className="flex items-center gap-2 rounded-full border border-white/20 bg-black/35 px-3 py-1 text-[11px] font-medium text-white/85 backdrop-blur-xl">
                      <span>Left wall</span>
                      <span aria-hidden className="tracking-[0.3em]">
                        →→→
                      </span>
                      <span>Right wall</span>
                    </div>
                  )}
                </div>
              )}

              <div className="absolute inset-0 flex items-center justify-center">
                {mode === "auto" ? (
                  <button
                    type="button"
                    disabled={!!camError || autoPhase === "done"}
                    onClick={() => {
                      if (autoPhase === "idle" || autoPhase === "walk") startViewpoint();
                      else if (autoPhase === "sweep") finishViewpoint();
                    }}
                    role="progressbar"
                    aria-label="Start or stop the room scan"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={sweepPct}
                    className={`relative flex size-[168px] select-none items-center justify-center rounded-full border text-white backdrop-blur-xl transition active:scale-95 ${
                      autoPhase === "sweep"
                        ? "border-white/60 bg-white/25"
                        : "border-white/30 bg-white/12"
                    }`}
                  >
                    <svg viewBox="0 0 100 100" className="absolute inset-0 size-full -rotate-90">
                      <circle
                        cx="50"
                        cy="50"
                        r="46"
                        fill="none"
                        stroke="rgba(255,255,255,0.18)"
                        strokeWidth="4"
                      />
                      <circle
                        cx="50"
                        cy="50"
                        r="46"
                        fill="none"
                        stroke="white"
                        strokeWidth="4"
                        strokeLinecap="round"
                        strokeDasharray={2 * Math.PI * 46}
                        strokeDashoffset={2 * Math.PI * 46 * (1 - sweepPct / 100)}
                        style={{ transition: "stroke-dashoffset 300ms ease" }}
                      />
                      {/* One tick per heading bin: gaps stay visible during the turn. */}
                      {(station > 0 && cornerTargetsRef.current.length
                        ? cornerTargetsRef.current
                        : Array.from({ length: BIN_COUNT }, (_, i) => i * BIN_DEG)
                      ).map((t) => {
                        const done = autoCovered.includes(t);
                        const a = ((t - 90) * Math.PI) / 180;
                        const r1 = 36;
                        const r2 = done ? 30 : 32;
                        return (
                          <line
                            key={t}
                            x1={50 + r1 * Math.cos(a)}
                            y1={50 + r1 * Math.sin(a)}
                            x2={50 + r2 * Math.cos(a)}
                            y2={50 + r2 * Math.sin(a)}
                            stroke={done ? "white" : "rgba(255,255,255,0.28)"}
                            strokeWidth={done ? 4 : 2.5}
                            strokeLinecap="round"
                            transform="rotate(90 50 50)"
                          />
                        );
                      })}
                    </svg>
                    <span className="relative text-center leading-tight">
                      <span className="tabular block text-2xl font-semibold">
                        {autoPhase === "sweep"
                          ? decayReady
                            ? `${autoCovered.length}/${arcBins}`
                            : "Ping"
                          : autoPhase === "walk"
                            ? "Start"
                            : autoPhase === "done"
                              ? "Done"
                              : "Start"}
                      </span>
                      <span className="block text-[11px] font-medium text-white/80">
                        {autoPhase === "sweep"
                          ? decayReady
                            ? (turnHint ?? "Tap when done")
                            : "Hold still"
                          : autoPhase === "walk"
                            ? `Corner ${stationsDone} · ${walkDist.toFixed(1)} m`
                            : autoPhase === "done"
                              ? "Tap finish below"
                              : reshootStation != null
                                ? stationLabel(reshootStation)
                                : "Center of the room"}
                      </span>

                      {reshootStation == null && autoPhase !== "idle" && autoPhase !== "done" && (
                        <span className="mt-0.5 block text-[11px] font-medium text-white/70">
                          {stationsDone >= MIN_STATIONS
                            ? `${stationsDone} viewpoints · finish anytime`
                            : `${stationsDone}/${MIN_STATIONS} minimum`}
                        </span>
                      )}
                    </span>
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={takeShot}
                    disabled={!!camError}
                    className="tabular rounded-full border border-white/30 bg-white/15 px-8 py-4 text-[17px] font-semibold text-white backdrop-blur-xl transition active:scale-95"
                  >
                    Capture ({shots.length})
                  </button>
                )}
              </div>
            </div>

            {reshootStation != null && (
              <div className="space-y-2">
                <p className="text-center text-sm text-muted-foreground">
                  {autoPhase === "sweep"
                    ? (autoMsg ?? "Scan left to right")
                    : reshootStation === 0
                      ? "Stand in the middle of the room, tap Start and turn a full circle."
                      : `Go to ${stationLabel(reshootStation).toLowerCase()}, tap Start, then scan left to right.`}
                </p>
                <Button variant="secondary" className="w-full" onClick={cancelReshoot}>
                  Cancel reshoot
                </Button>
              </div>
            )}

            {mode === "auto" &&
              reshootStation == null &&
              autoPhase !== "idle" &&
              autoPhase !== "done" && (
                <div className="space-y-2">
                  <p className="text-center text-sm text-muted-foreground">
                    {autoMsg ?? "Scan only while the viewpoint is active"}
                  </p>
                  <Button
                    variant="secondary"
                    className="w-full"
                    onClick={endCapture}
                    disabled={stationsDone < MIN_STATIONS || autoPhase === "sweep"}
                  >
                    Reconstruct{stationsDone ? ` · ${stationsDone} viewpoints` : ""}
                  </Button>
                </div>
              )}

            {mode === "manual" && (
              <Button
                variant="secondary"
                className="w-full"
                onClick={() => {
                  stopCamera();
                  setStep(2);
                }}
                disabled={shots.length === 0}
              >
                Next: acoustics
              </Button>
            )}
          </section>
        )}

        {/* ── step 2: acoustics ── */}
        {step === 2 && (
          <section className="space-y-4">
            <div className="flex items-baseline justify-between">
              <h2 className="text-lg font-semibold">Sonic probe</h2>
              <span className="tabular text-xs text-muted-foreground">optional</span>
            </div>
            <p className="text-sm text-muted-foreground">
              Turn the volume up, take the phone off silent mode, unplug headphones, hold it away
              from your body and stay quiet. The phone fires three short broadband pings and records
              how the room decays after each; the results are averaged, and the first echo is timed
              to measure the distance to the nearest wall.
            </p>

            {audioEnv?.blocked && (
              <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
                {audioEnv.message}
              </div>
            )}

            {!micReady ? (
              <Button
                className="w-full"
                size="lg"
                onClick={enableMic}
                disabled={!!probeStage || audioEnv?.blocked === "unsupported"}
              >
                <Mic className="mr-2 size-4" />
                {probeStage ?? "Enable microphone"}
              </Button>
            ) : (
              <div className="space-y-3">
                <div className="rounded-md border border-border bg-card p-3">
                  <div className="mb-2 flex items-center justify-between text-[11px] uppercase tracking-wide text-muted-foreground">
                    <span>Input level</span>
                    <span className="tabular">{micLevel > 0.02 ? "signal" : "silent"}</span>
                  </div>
                  <div
                    className="h-2 w-full overflow-hidden rounded bg-muted"
                    role="meter"
                    aria-label="Microphone input level"
                    aria-valuenow={Math.round(micLevel * 100)}
                    aria-valuemin={0}
                    aria-valuemax={100}
                  >
                    <div
                      className="h-full bg-primary transition-[width] duration-100"
                      style={{ width: `${Math.round(micLevel * 100)}%` }}
                    />
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    Tap or speak. The bar should move. If it stays flat, the microphone isn't
                    reaching the page.
                  </p>
                </div>

                <Button className="w-full" size="lg" onClick={runProbe} disabled={!!probeStage}>
                  <Mic className="mr-2 size-4" />
                  {probeStage ?? (acoustics ? "Re-run probe (3 pings)" : "Send 3 pings")}
                </Button>
              </div>
            )}

            {probeError && (
              <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
                {probeError}
              </div>
            )}

            {acoustics && (
              <div className="grid grid-cols-2 gap-2">
                {[
                  ["RT60", `${acoustics.rt60_s} s`],
                  ["Character", acoustics.hardness],
                  ["Noise floor", `${acoustics.noise_floor_db} dB`],
                  ["Clarity", `${acoustics.clarity_index} dB`],
                  ["Brightness", acoustics.brightness.toFixed(2)],
                  ["Ping SNR", `${acoustics.ping_snr_db} dB`],
                  ["Chirps", `${acoustics.chirps} (±${acoustics.rt60_spread_s}s)`],
                  [
                    "Nearest wall",
                    acoustics.reflection_distance_m == null
                      ? "no echo timed"
                      : `${acoustics.reflection_distance_m} m`,
                  ],
                ].map(([k, v]) => (
                  <div key={k} className="surface-card p-3">
                    <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                      {k}
                    </div>
                    <div className="tabular mt-1 text-sm">{v}</div>
                  </div>
                ))}
              </div>
            )}

            <Button variant="secondary" className="w-full" onClick={() => setStep(3)}>
              {acoustics ? "Next: depth import" : "Skip acoustics"}
            </Button>
          </section>
        )}

        {/* ── step 3: depth ── */}
        {step === 3 && (
          <section className="space-y-4">
            <div className="flex items-baseline justify-between">
              <h2 className="text-lg font-semibold">LiDAR / depth import</h2>
              <span className="tabular text-xs text-muted-foreground">optional</span>
            </div>
            <p className="text-sm text-muted-foreground">
              iOS Safari doesn't expose the LiDAR sensor to web apps, so this step can't read the
              sensor directly. If you have a scan from an app like Polycam, Scaniverse or RoomPlan,
              attach the export here and it will be used as the scale reference. Otherwise skip it.
              Scale will be inferred from the photos.
            </p>
            <label className="flex cursor-pointer flex-col items-center gap-2 rounded-md border border-dashed border-border bg-card p-8 text-center">
              <Boxes className="size-6 text-primary" />
              <span className="text-sm">
                {depthFile ? depthFile.name : "Choose .usdz / .ply / .obj / .glb"}
              </span>
              <input
                type="file"
                className="hidden"
                accept=".usdz,.ply,.obj,.glb,.gltf,.e57,.las,.laz,.zip"
                onChange={async (e) => {
                  const f = e.target.files?.[0] ?? null;
                  setDepthFile(f);
                  setDepthSkipped(false);
                  setDepthMetrics(null);
                  setDepthNote(null);
                  if (!f) return;
                  setDepthReading(true);
                  const { parseDepthFile } = await import("@/lib/depth-import");
                  const res = await parseDepthFile(f);
                  setDepthMetrics(res.metrics);
                  setDepthNote(res.reason ?? null);
                  setDepthReading(false);
                }}
              />
            </label>
            {depthReading && (
              <p className="tabular text-xs text-muted-foreground">Measuring depth file…</p>
            )}
            {depthMetrics && (
              <div className="rounded-md border border-primary/40 bg-primary/5 p-3 text-sm">
                <p className="font-semibold text-primary">Measured shell</p>
                <p className="tabular mt-1 text-muted-foreground">
                  {depthMetrics.width_m} m × {depthMetrics.length_m} m, ceiling{" "}
                  {depthMetrics.height_m} m
                  {depthMetrics.points ? ` · ${depthMetrics.points.toLocaleString()} points` : ""}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  These dimensions override the photo estimate.
                </p>
              </div>
            )}
            {depthNote && !depthMetrics && (
              <p className="text-xs text-muted-foreground">{depthNote}</p>
            )}
            <div className="grid gap-2 sm:grid-cols-2">
              <Button
                variant="ghost"
                className="w-full"
                onClick={() => {
                  setDepthFile(null);
                  setDepthSkipped(true);
                  setStep(4);
                }}
              >
                Skip: no depth file
              </Button>
              <Button variant="secondary" className="w-full" onClick={() => setStep(4)}>
                Next: review
              </Button>
            </div>
          </section>
        )}

        {/* ── step 4: finish ── */}
        {step === 4 && search.reshoot && (
          <section className="space-y-4">
            <h2 className="text-lg font-semibold">Review reshoots</h2>
            <p className="text-sm text-muted-foreground">
              Reshot: {reshotStations.map(stationLabel).join(", ")}.{" "}
              {stillRed.length
                ? "Reshoot any other red viewpoint now. The space is reconstructed once, after all of them."
                : "Everything looks good. Reconstruct to merge the new frames."}
            </p>
            <div className="surface-card p-4">
              <StationHealthMap
                stations={reshootHealth}
                highlight={reshotStations}
                onReshoot={(id) => void beginReshoot(id)}
                reshootDisabledReason={working ? "Uploading…" : null}
              />
            </div>
            {working ? (
              workingProgress
            ) : (
              <div className="space-y-2">
                <Button
                  className="w-full"
                  size="lg"
                  variant={stillRed.length ? "secondary" : "default"}
                  onClick={() => void submitReshoot()}
                >
                  Reconstruct with {reshotStations.length} reshot{" "}
                  {reshotStations.length === 1 ? "viewpoint" : "viewpoints"}
                </Button>
                <Button variant="ghost" className="w-full" asChild>
                  <Link to="/space/$id" params={{ id: search.reshoot }}>
                    Discard reshoots
                  </Link>
                </Button>
              </div>
            )}
          </section>
        )}

        {step === 4 && !search.reshoot && (
          <section className="space-y-4">
            <h2 className="text-lg font-semibold">Review &amp; reconstruct</h2>
            {captureHealth.length > 0 && (
              <div className="surface-card p-4">
                <StationHealthMap
                  stations={captureHealth}
                  onReshoot={(id) => void beginReshoot(id)}
                  reshootDisabledReason={working ? "Uploading…" : null}
                />
              </div>
            )}
            <ul className="space-y-2 text-sm">
              <li className="flex items-center gap-2">
                <Check className="size-4 text-primary" /> {shots.length} frames ·{" "}
                {mode === "auto"
                  ? `${Math.max(1, stationsDone)} viewpoints swept`
                  : `${coveredTargets.length}/12 headings covered`}
              </li>
              {mode === "auto" && (
                <li className="flex items-center gap-2">
                  <Check
                    className={`size-4 ${legs.length ? "text-primary" : "text-muted-foreground"}`}
                  />
                  {legs.length
                    ? `${legs.length} walked legs · ${legs.map((l) => `${l.distance_m.toFixed(1)} m`).join(" · ")}`
                    : "No walk measured (size will be estimated)"}
                </li>
              )}

              <li className="flex items-center gap-2">
                <Check
                  className={`size-4 ${acoustics ? "text-primary" : "text-muted-foreground"}`}
                />
                {acoustics
                  ? `RT60 ${acoustics.rt60_s}s (${acoustics.hardness})`
                  : "No acoustic probe"}
              </li>
              <li className="flex items-center gap-2">
                <Check
                  className={`size-4 ${rangeCount ? "text-primary" : "text-muted-foreground"}`}
                />
                {rangeCount
                  ? `${rangeCount} wall distance measurements`
                  : "No wall ranging (size will be estimated)"}
              </li>

              <li className="flex items-center gap-2">
                <Check
                  className={`size-4 ${depthFile ? "text-primary" : "text-muted-foreground"}`}
                />
                {depthMetrics
                  ? `${depthMetrics.width_m} × ${depthMetrics.length_m} × ${depthMetrics.height_m} m measured (${depthMetrics.format})`
                  : depthFile
                    ? depthFile.name
                    : depthSkipped
                      ? "Depth import skipped. Scale from photos."
                      : "No depth import"}
              </li>
            </ul>

            {working ? (
              workingProgress
            ) : (
              <div className="space-y-2">
                <Button
                  className="w-full"
                  size="lg"
                  variant={captureNeedsReshoot ? "secondary" : "default"}
                  onClick={finish}
                >
                  {captureNeedsReshoot ? "Reconstruct anyway" : "Reconstruct space"}
                </Button>
                {mode === "auto" && !depthFile && (
                  <Button variant="ghost" className="w-full" onClick={() => setStep(3)}>
                    Add a LiDAR / depth file first
                  </Button>
                )}
              </div>
            )}
          </section>
        )}
      </div>

      <LeaveGuardDialog
        blocker={leaveGuard.blocker}
        title={working ? "Leave while processing?" : "Discard this capture?"}
        description={
          working
            ? `${working} is still running in this tab. Leaving now interrupts it and you may have to capture the space again.`
            : `Your ${shots.length} captured frame${shots.length === 1 ? " hasn't" : "s haven't"} been uploaded yet. Leaving this page discards them.`
        }
      />

      <AlertDialog
        open={!!pendingDraft}
        onOpenChange={(open) => {
          if (!open) setPendingDraft(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Resume previous capture?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDraft
                ? `You have an unfinished ${pendingDraft.mode} capture` +
                  (pendingDraft.name ? ` for "${pendingDraft.name}"` : "") +
                  ` from ${new Date(pendingDraft.updatedAt).toLocaleString()}. ` +
                  `Restore the name and notes, or start fresh?`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={() => {
                if (user) void clearCaptureDraft(user.id);
                setPendingDraft(null);
              }}
            >
              Start fresh
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (!pendingDraft) return;
                setName(pendingDraft.name);
                setNotes(pendingDraft.notes);
                setMode(pendingDraft.mode);
                setPendingDraft(null);
              }}
            >
              Resume
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  );
}
