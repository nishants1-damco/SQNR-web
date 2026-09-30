/**
 * Browser-based room acoustics probe.
 *
 * Plays a short broadband burst through the speaker, records the decay with the
 * microphone, and estimates reverberation time, noise floor and spectral
 * balance.
 *
 * iOS Safari specifics handled here:
 *  1. The AudioContext is created and resumed *synchronously* inside the user
 *     gesture, before any await, and a silent buffer is played to latch the
 *     audio session. Awaiting the microphone prompt first loses user
 *     activation and leaves the context suspended, so the ping never sounds.
 *  2. `navigator.audioSession.type = "play-and-record"` keeps output on the
 *     loudspeaker. Without it, an active mic capture routes playback to the
 *     earpiece receiver at very low volume.
 *  3. Permission and measurement are separate steps so the prompt is never
 *     raced by the burst.
 */

export type BandName = "125" | "250" | "500" | "1k" | "2k" | "4k";

export interface AcousticsResult {
  rt60_s: number;
  noise_floor_db: number;
  peak_db: number;
  clarity_index: number;
  brightness: number;
  bands_db: Record<BandName, number>;
  envelope: { t: number; db: number }[];
  hardness: "very soft" | "soft" | "mixed" | "live" | "very live";
  ping_snr_db: number;
  measured_at: string;
  /** How many chirps were fired and averaged. */
  chirps: number;
  /** Spread (max-min) of RT60 across the chirps — a repeatability indicator. */
  rt60_spread_s: number;
  /** Delay from direct sound to the first strong reflection, milliseconds. */
  first_reflection_ms: number | null;
  /** Distance to the nearest large reflecting surface, meters (c·Δt/2). */
  reflection_distance_m: number | null;
  /** Per-chirp RT60 values, in fire order. */
  chirp_rt60_s: number[];
}

// Shared with the worker's shell solver and the analysis cross-check.
export type { WallRange } from "@spatial/domain/wall-ranges";
export { volumeFromRt60 } from "@spatial/domain/room-acoustics";
import type { WallRange } from "@spatial/domain/wall-ranges";

export type AudioBlockReason =
  "insecure" | "embedded" | "unsupported" | "denied" | "no-device" | null;

export interface AudioEnvironment {
  secure: boolean;
  embedded: boolean;
  supported: boolean;
  blocked: AudioBlockReason;
  message: string | null;
}

const BANDS: { name: BandName; lo: number; hi: number }[] = [
  { name: "125", lo: 90, hi: 180 },
  { name: "250", lo: 180, hi: 355 },
  { name: "500", lo: 355, hi: 710 },
  { name: "1k", lo: 710, hi: 1420 },
  { name: "2k", lo: 1420, hi: 2840 },
  { name: "4k", lo: 2840, hi: 5680 },
];

function hardnessFor(rt60: number, brightness: number): AcousticsResult["hardness"] {
  const score = rt60 * 1.6 + brightness * 0.6;
  if (score < 0.5) return "very soft";
  if (score < 0.9) return "soft";
  if (score < 1.5) return "mixed";
  if (score < 2.4) return "live";
  return "very live";
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Inspect the page context before offering the probe. */
export function inspectAudioEnvironment(): AudioEnvironment {
  if (typeof window === "undefined") {
    return {
      secure: false,
      embedded: false,
      supported: false,
      blocked: "unsupported",
      message: null,
    };
  }
  const secure = window.isSecureContext;
  let embedded = false;
  try {
    embedded = window.self !== window.top;
  } catch {
    embedded = true;
  }
  const supported =
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    (!!window.AudioContext ||
      !!(window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext);

  let blocked: AudioBlockReason = null;
  let message: string | null = null;
  if (!supported) {
    blocked = "unsupported";
    message = "This browser doesn't support microphone capture.";
  } else if (!secure) {
    blocked = "insecure";
    message = "Microphone access needs a secure (HTTPS) connection.";
  } else if (embedded) {
    blocked = "embedded";
    message =
      "You're viewing this inside an embedded preview, which blocks the microphone prompt. Open the published app or add it to your home screen, then run the probe.";
  }
  return { secure, embedded, supported, blocked, message };
}

interface AudioSessionCapable {
  audioSession?: { type: string };
}

/**
 * Step 1 — call this SYNCHRONOUSLY from the tap handler (no await before it).
 * Creates and unlocks the audio output path.
 */
export function createProbeSession() {
  const AudioCtx: typeof AudioContext =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtx) throw new Error("Web Audio is not available in this browser.");

  // Keep the loudspeaker active while recording (Safari 16.4+).
  try {
    const nav = navigator as Navigator & AudioSessionCapable;
    if (nav.audioSession) nav.audioSession.type = "play-and-record";
  } catch {
    /* not supported — non-fatal */
  }

  const ctx = new AudioCtx();
  // Silent one-frame buffer, started inside the gesture, latches the session.
  try {
    const unlock = ctx.createBufferSource();
    unlock.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
    unlock.connect(ctx.destination);
    unlock.start(0);
  } catch {
    /* non-fatal */
  }
  void ctx.resume();

  let stream: MediaStream | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let analyzer: AnalyserNode | null = null;
  let closed = false;
  let timeBuf = new Float32Array(2048);
  let freqBuf = new Uint8Array(1024);

  const rms = () => {
    if (!analyzer) return 0;
    analyzer.getFloatTimeDomainData(timeBuf);
    let sum = 0;
    for (let i = 0; i < timeBuf.length; i++) {
      const v = timeBuf[i] ?? 0;
      sum += v * v;
    }
    return Math.sqrt(sum / timeBuf.length);
  };
  const db = (v: number) => 20 * Math.log10(Math.max(v, 1e-8));

  return {
    context: ctx,

    /** Step 2 — request the microphone. Safe to await. */
    async enableMicrophone(deviceId?: string | null): Promise<void> {
      try {
        const acquired = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            // `ideal` (not `exact`) so a picked device that's no longer
            // available doesn't hard-fail — the browser falls back to a
            // working mic instead of throwing OverconstrainedError.
            ...(deviceId ? { deviceId: { ideal: deviceId } } : {}),
          },
        });
        if (closed) {
          acquired.getTracks().forEach((track) => track.stop());
          return;
        }
        stream = acquired;
      } catch (err) {
        const name = err instanceof DOMException ? err.name : "";
        if (name === "NotAllowedError" || name === "SecurityError") {
          throw new Error(
            "Microphone permission was denied. Allow the microphone for this site in your browser settings, then try again.",
          );
        }
        if (name === "NotFoundError" || name === "OverconstrainedError") {
          throw new Error("No microphone was found on this device.");
        }
        throw new Error(err instanceof Error ? err.message : "Could not open the microphone.");
      }

      await ctx.resume();
      source?.disconnect();
      source = ctx.createMediaStreamSource(stream);
      analyzer = ctx.createAnalyser();
      analyzer.fftSize = 2048;
      analyzer.smoothingTimeConstant = 0;
      source.connect(analyzer);
      timeBuf = new Float32Array(analyzer.fftSize);
      freqBuf = new Uint8Array(analyzer.frequencyBinCount);
    },

    get ready() {
      return !!analyzer;
    },

    /** Instantaneous input level, 0..1, for the live meter. */
    level() {
      return Math.min(1, rms() * 6);
    },

    /** One chirp: fire the ping and measure the decay. */
    async runSingleProbe(onProgress?: (stage: string) => void): Promise<AcousticsResult> {
      if (!analyzer) throw new Error("Enable the microphone first.");
      await ctx.resume();
      const binHz = ctx.sampleRate / analyzer.fftSize;

      // --- 1. noise floor -------------------------------------------------
      onProgress?.("Measuring background noise");
      const floorSamples: number[] = [];
      // Short floor sample: the user is standing still waiting, so this window
      // is dead time. 300 ms is plenty to read a room's noise floor.
      for (let i = 0; i < 30; i++) {
        floorSamples.push(rms());
        await sleep(10);
      }
      floorSamples.sort((a, b) => a - b);
      const noiseFloor = db(floorSamples[Math.floor(floorSamples.length / 2)] ?? 1e-8);

      // --- 2. burst -------------------------------------------------------
      // A loud exponential sweep plus dense multi-tone energy. White noise can
      // measure near full scale while sounding weak on a phone speaker because
      // much of its energy is outside the speaker's useful band. Concentrating
      // the burst from 500 Hz to 7 kHz makes it clearly audible while retaining
      // enough bandwidth to excite a useful room decay.
      onProgress?.("Sending sonic blast");
      const burstLen = 0.32;
      const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * burstLen), ctx.sampleRate);
      const data = buffer.getChannelData(0);
      let sweepPhase = 0;
      for (let i = 0; i < data.length; i++) {
        const p = i / data.length;
        const attack = Math.min(1, p / 0.01);
        const release = p > 0.94 ? (1 - p) / 0.06 : 1;
        const frequency = 500 * Math.pow(14, p);
        sweepPhase += (2 * Math.PI * frequency) / ctx.sampleRate;
        const sweep = Math.sin(sweepPhase);
        const tones =
          Math.sin((2 * Math.PI * 730 * i) / ctx.sampleRate) +
          Math.sin((2 * Math.PI * 1450 * i) / ctx.sampleRate) +
          Math.sin((2 * Math.PI * 2900 * i) / ctx.sampleRate);
        const noise = Math.random() * 2 - 1;
        const mixed = sweep * 0.58 + tones * 0.17 + noise * 0.12;
        data[i] = (Math.tanh(mixed * 2.8) / Math.tanh(2.8)) * 0.995 * attack * release;
      }
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      // Straight to the output at full scale. A compressor used to sit here and
      // was throwing away most of the level before it ever reached the speaker.
      const gain = ctx.createGain();
      gain.gain.value = 1;
      src.connect(gain).connect(ctx.destination);
      src.start();

      // --- 3. record decay ------------------------------------------------
      const envelope: { t: number; db: number }[] = [];
      const bandAccum: Record<string, { sum: number; n: number }> = {};
      BANDS.forEach((b) => {
        bandAccum[b.name] = { sum: 0, n: 0 };
      });

      const t0 = performance.now();
      // The blast itself is 160 ms; this window only listens to its tail. Kept
      // short so each chirp's hold-still moment is about two seconds, not a
      // tone droning through the sweep.
      const durationMs = 1800;
      while (performance.now() - t0 < durationMs) {
        const t = (performance.now() - t0) / 1000;
        envelope.push({ t, db: db(rms()) });

        analyzer.getByteFrequencyData(freqBuf);
        for (const b of BANDS) {
          const lo = Math.floor(b.lo / binHz);
          const hi = Math.min(Math.ceil(b.hi / binHz), freqBuf.length - 1);
          let s = 0;
          let n = 0;
          for (let i = lo; i <= hi; i++) {
            s += freqBuf[i] ?? 0;
            n++;
          }
          const acc = bandAccum[b.name];
          if (acc && n > 0 && t > 0.15 && t < 1.2) {
            acc.sum += s / n;
            acc.n++;
          }
        }
        // Dense sampling over the first 250 ms so early reflections (a 3 m
        // wall returns in ~17 ms) are resolvable; coarse after that.
        await sleep(t < 0.25 ? 0 : 8);
      }

      // --- 4. analysis ----------------------------------------------------
      onProgress?.("Analyzing decay");
      let peakIdx = 0;
      for (let i = 0; i < envelope.length; i++) {
        if ((envelope[i]?.db ?? -Infinity) > (envelope[peakIdx]?.db ?? -Infinity)) peakIdx = i;
      }
      const peakEntry = envelope[peakIdx] ?? { t: 0, db: -80 };
      const peak = peakEntry.db;

      // Verification gate: the ping must clearly rise above the noise floor.
      const snr = Math.round((peak - noiseFloor) * 10) / 10;
      if (snr < 6) {
        throw new Error(
          "The ping wasn't heard by the microphone. Turn the volume up, take the phone off silent mode, unplug headphones and try again.",
        );
      }

      // T20-style: time to fall 5 dB -> 25 dB below peak, extrapolated to 60 dB.
      const findDrop = (drop: number) => {
        for (let i = peakIdx; i < envelope.length; i++) {
          const e = envelope[i];
          if (e && e.db <= peak - drop) return e.t;
        }
        return null;
      };
      const t5 = findDrop(5);
      const t25 = findDrop(25);
      let rt60 = 0.4;
      if (t5 != null && t25 != null && t25 > t5) {
        rt60 = (t25 - t5) * 3;
      } else if (t5 != null) {
        const last = envelope[envelope.length - 1] ?? { t: 0, db: peak };
        const tEnd = last.t;
        const dropEnd = peak - last.db;
        if (dropEnd > 3) rt60 = ((tEnd - t5) * 60) / dropEnd;
      }
      rt60 = Math.min(Math.max(rt60, 0.15), 6);

      const bands = {} as Record<BandName, number>;
      for (const b of BANDS) {
        const a = bandAccum[b.name];
        bands[b.name] = a && a.n ? Math.round((a.sum / a.n) * 10) / 10 : 0;
      }
      const low = ((bands["125"] ?? 0) + (bands["250"] ?? 0)) / 2 || 1;
      const high = ((bands["2k"] ?? 0) + (bands["4k"] ?? 0)) / 2;
      const brightness = Math.round((high / Math.max(low, 1)) * 100) / 100;

      const energyIn = (a: number, b: number) =>
        envelope
          .filter((e) => e.t >= a && e.t < b)
          .reduce((s, e) => s + Math.pow(10, e.db / 10), 0);
      const early = energyIn(peakEntry.t, peakEntry.t + 0.08);
      const late = energyIn(peakEntry.t + 0.08, peakEntry.t + 1.2);
      const clarity =
        Math.round(10 * Math.log10(Math.max(early, 1e-9) / Math.max(late, 1e-9)) * 10) / 10;

      // First strong reflection after the direct sound: the earliest local
      // maximum 3-90 ms past the peak that rises at least 1.5 dB above the
      // preceding trough. Distance to that surface is c·Δt/2.
      let firstReflectionMs: number | null = null;
      let trough = peak;
      for (let i = peakIdx + 1; i < envelope.length; i++) {
        const e = envelope[i];
        const prev = envelope[i - 1];
        const next = envelope[i + 1];
        if (!e || !prev || !next) continue;
        const dt = (e.t - peakEntry.t) * 1000;
        if (dt < 3) continue;
        if (dt > 90) break;
        trough = Math.min(trough, e.db);
        if (e.db >= prev.db && e.db >= next.db && e.db - trough > 1.5) {
          firstReflectionMs = Math.round(dt * 10) / 10;
          break;
        }
      }
      const reflectionDistance =
        firstReflectionMs == null
          ? null
          : Math.round(((343 * (firstReflectionMs / 1000)) / 2) * 100) / 100;

      return {
        rt60_s: Math.round(rt60 * 100) / 100,
        noise_floor_db: Math.round(noiseFloor * 10) / 10,
        peak_db: Math.round(peak * 10) / 10,
        clarity_index: clarity,
        brightness,
        bands_db: bands,
        envelope: envelope.filter((_, i) => i % 3 === 0),
        hardness: hardnessFor(rt60, brightness),
        ping_snr_db: snr,
        measured_at: new Date().toISOString(),
        chirps: 1,
        rt60_spread_s: 0,
        first_reflection_ms: firstReflectionMs,
        reflection_distance_m: reflectionDistance,
        chirp_rt60_s: [Math.round(rt60 * 100) / 100],
      };
    },

    /**
     * Step 3 — fire several chirps and aggregate. Multiple bursts average out
     * a bad speaker moment, a passing noise, or an unlucky standing wave, and
     * give a repeatability figure the reconstruction can weigh.
     */
    async runProbe(onProgress?: (stage: string) => void, chirps = 3): Promise<AcousticsResult> {
      const runs: AcousticsResult[] = [];
      let lastError: unknown = null;
      for (let i = 0; i < chirps; i++) {
        try {
          runs.push(
            await this.runSingleProbe((s) => onProgress?.(`Chirp ${i + 1}/${chirps}: ${s}`)),
          );
        } catch (err) {
          lastError = err;
        }
        if (i < chirps - 1) await sleep(400);
      }
      if (runs.length === 0) throw lastError ?? new Error("Probe failed");

      const rt60s = runs.map((r) => r.rt60_s);
      const best = runs.reduce((a, b) => (b.ping_snr_db > a.ping_snr_db ? b : a));
      const reflections = runs
        .map((r) => r.reflection_distance_m)
        .filter((v): v is number => typeof v === "number");
      const rt60 = Math.round(median(rt60s) * 100) / 100;

      return {
        ...best,
        rt60_s: rt60,
        hardness: hardnessFor(rt60, best.brightness),
        chirps: runs.length,
        chirp_rt60_s: rt60s,
        rt60_spread_s: Math.round((Math.max(...rt60s) - Math.min(...rt60s)) * 100) / 100,
        reflection_distance_m: reflections.length
          ? Math.round(median(reflections) * 100) / 100
          : null,
        first_reflection_ms: reflections.length
          ? Math.round((median(reflections) / 343) * 2 * 10000) / 10
          : null,
      };
    },

    /**
     * Directional ranging chirp. Short burst, dense sampling, and a small FFT
     * window so the direct sound and the first reflection can be told apart at
     * a few milliseconds. Distance to the surface the phone is pointing at is
     * c * dt / 2. This is what gives the reconstruction a measured room size
     * instead of a visual guess.
     */
    async runRangeProbe(headingDeg: number | null): Promise<WallRange | null> {
      if (!analyzer) return null;
      await ctx.resume();
      const previousFft = analyzer.fftSize;
      // 256 samples ~ 5.8 ms at 44.1 kHz: fine enough to resolve a wall at 1 m.
      analyzer.fftSize = 256;
      timeBuf = new Float32Array(analyzer.fftSize);
      try {
        const floor: number[] = [];
        for (let i = 0; i < 20; i++) {
          floor.push(rms());
          await sleep(5);
        }
        floor.sort((a, b) => a - b);
        const noise = db(floor[Math.floor(floor.length / 2)] ?? 1e-8);

        // Louder burst: a two-tone sweep summed with its octave, hard-limited to
        // just under full scale, and driven through a dedicated gain stage. The
        // previous single sine sat around a third of the available headroom, so
        // the reflection was often below the room noise and the picker latched
        // onto reverb instead of the wall.
        const burstLen = 0.028;
        const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * burstLen), ctx.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < data.length; i++) {
          const p = i / data.length;
          // Fast attack, slow release: keeps the direct sound sharp in time.
          const env = Math.min(1, p / 0.05) * Math.pow(1 - p, 0.35);
          const f = 1800 + 4700 * p;
          const phase = (2 * Math.PI * f * i) / ctx.sampleRate;
          const s = Math.sin(phase) * 0.75 + Math.sin(2 * phase) * 0.25;
          data[i] = Math.max(-0.99, Math.min(0.99, s * 1.35)) * env;
        }

        const fire = async (): Promise<{ ms: number; snr: number } | null> => {
          const src = ctx.createBufferSource();
          src.buffer = buffer;
          const gain = ctx.createGain();
          gain.gain.value = 1;
          src.connect(gain);
          gain.connect(ctx.destination);
          src.start();

          const trace: { t: number; db: number }[] = [];
          const t0 = performance.now();
          while (performance.now() - t0 < 200) {
            trace.push({ t: (performance.now() - t0) / 1000, db: db(rms()) });
            await sleep(0);
          }

          let peakIdx = 0;
          for (let i = 0; i < trace.length; i++) {
            if ((trace[i]?.db ?? -Infinity) > (trace[peakIdx]?.db ?? -Infinity)) peakIdx = i;
          }
          const peak = trace[peakIdx];
          if (!peak) return null;
          const snr = Math.round((peak.db - noise) * 10) / 10;
          if (snr < 8) return null;

          let trough = peak.db;
          let reflectionMs: number | null = null;
          for (let i = peakIdx + 1; i < trace.length - 1; i++) {
            const e = trace[i];
            const prev = trace[i - 1];
            const next = trace[i + 1];
            if (!e || !prev || !next) continue;
            const dt = (e.t - peak.t) * 1000;
            if (dt < 3) continue;
            // 40 ms of flight is a surface ~6.8 m away. Beyond that indoors we
            // are reading late reverb, not a wall, and it was inflating rooms
            // into aircraft hangars.
            if (dt > 40) break;
            trough = Math.min(trough, e.db);
            if (e.db >= prev.db && e.db >= next.db && e.db - trough > 2) {
              reflectionMs = Math.round(dt * 10) / 10;
              break;
            }
          }
          if (reflectionMs == null) return null;
          return { ms: reflectionMs, snr };
        };

        // Three bursts, median delay. One stray bump can no longer set the size
        // of a room.
        const hits: { ms: number; snr: number }[] = [];
        for (let i = 0; i < 3; i++) {
          const hit = await fire();
          if (hit) hits.push(hit);
          await sleep(90);
        }
        if (hits.length < 2) return null;
        const delays = hits.map((h) => h.ms).sort((a, b) => a - b);
        const mid = Math.floor(delays.length / 2);
        const reflectionMs =
          delays.length % 2
            ? (delays[mid] as number)
            : ((delays[mid - 1] as number) + (delays[mid] as number)) / 2;
        // Reject a scattered set: real wall echoes repeat to within a couple of ms.
        if ((delays[delays.length - 1] as number) - (delays[0] as number) > 6) return null;
        const snr = Math.max(...hits.map((h) => h.snr));

        const distance = Math.round(((343 * (reflectionMs / 1000)) / 2) * 100) / 100;
        if (distance < 0.5 || distance > 6.8) return null;
        return {
          heading_deg: headingDeg,
          distance_m: distance,
          delay_ms: reflectionMs,
          snr_db: snr,
          measured_at: new Date().toISOString(),
        };
      } catch {
        return null;
      } finally {
        analyzer.fftSize = previousFft;
        timeBuf = new Float32Array(analyzer.fftSize);
        freqBuf = new Uint8Array(analyzer.frequencyBinCount);
      }
    },

    close() {
      closed = true;
      stream?.getTracks().forEach((t) => t.stop());
      stream = null;
      source?.disconnect();
      source = null;
      analyzer?.disconnect();
      analyzer = null;
      void ctx.close().catch(() => undefined);
      try {
        const nav = navigator as Navigator & AudioSessionCapable;
        if (nav.audioSession) nav.audioSession.type = "ambient";
      } catch {
        /* not supported */
      }
    },
  };
}

export type ProbeSession = ReturnType<typeof createProbeSession>;

function median(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
}

/**
 * Combine the decay probes from every viewpoint of a capture into the scan's
 * acoustics. RT60 is a property of the room, so every chirp from every
 * viewpoint measures the same thing and they all vote equally in the median.
 * The spread compares the viewpoints' own medians: one bad chirp is already
 * outvoted inside its viewpoint and shouldn't mark the whole capture
 * unrepeatable. Everything else comes from the cleanest (highest-SNR) probe.
 */
export function combineViewpointProbes(probes: AcousticsResult[]): AcousticsResult | null {
  const first = probes[0];
  if (!first) return null;
  if (probes.length === 1) return first;
  const best = probes.reduce((a, b) => (b.ping_snr_db > a.ping_snr_db ? b : a));
  const chirpRt60s = probes.flatMap((p) => (p.chirp_rt60_s.length ? p.chirp_rt60_s : [p.rt60_s]));
  const viewpointRt60s = probes.map((p) => p.rt60_s);
  const rt60 = Math.round(median(chirpRt60s) * 100) / 100;
  return {
    ...best,
    rt60_s: rt60,
    hardness: hardnessFor(rt60, best.brightness),
    chirps: probes.reduce((n, p) => n + p.chirps, 0),
    chirp_rt60_s: chirpRt60s,
    rt60_spread_s:
      Math.round((Math.max(...viewpointRt60s) - Math.min(...viewpointRt60s)) * 100) / 100,
  };
}
