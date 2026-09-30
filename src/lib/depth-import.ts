/**
 * Client-side reader for imported depth / LiDAR exports.
 *
 * Browsers can't touch the iPhone LiDAR sensor, but an export from Polycam,
 * Scaniverse, RoomPlan, or any scanner is real measured geometry. Parsing its
 * bounding box gives the reconstruction a hard metric anchor instead of an
 * AI guess, which is what takes dimensions from "roughly right" to survey-ish.
 */

export interface DepthMetrics {
  format: string;
  /** East-west extent, meters. */
  width_m: number;
  /** North-south extent, meters. */
  length_m: number;
  /** Floor-to-ceiling extent, meters. */
  height_m: number;
  points: number;
  /** Raw axis extents before the up-axis heuristic, for auditing. */
  extents: { x: number; y: number; z: number };
  up_axis: "y" | "z";
  units: "m";
  source_file: string;
}

export interface DepthParseResult {
  metrics: DepthMetrics | null;
  /** Present when the format can't be measured in the browser. */
  reason?: string;
}

interface Box {
  min: [number, number, number];
  max: [number, number, number];
  count: number;
}

function emptyBox(): Box {
  return {
    min: [Infinity, Infinity, Infinity],
    max: [-Infinity, -Infinity, -Infinity],
    count: 0,
  };
}

function grow(box: Box, x: number, y: number, z: number) {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
  if (x < box.min[0]) box.min[0] = x;
  if (y < box.min[1]) box.min[1] = y;
  if (z < box.min[2]) box.min[2] = z;
  if (x > box.max[0]) box.max[0] = x;
  if (y > box.max[1]) box.max[1] = y;
  if (z > box.max[2]) box.max[2] = z;
  box.count++;
}

const PLY_TYPE_BYTES: Record<string, number> = {
  char: 1,
  uchar: 1,
  int8: 1,
  uint8: 1,
  short: 2,
  ushort: 2,
  int16: 2,
  uint16: 2,
  int: 4,
  uint: 4,
  int32: 4,
  uint32: 4,
  float: 4,
  float32: 4,
  double: 8,
  float64: 8,
};

function readScalar(view: DataView, offset: number, type: string, little: boolean): number {
  switch (type) {
    case "char":
    case "int8":
      return view.getInt8(offset);
    case "uchar":
    case "uint8":
      return view.getUint8(offset);
    case "short":
    case "int16":
      return view.getInt16(offset, little);
    case "ushort":
    case "uint16":
      return view.getUint16(offset, little);
    case "int":
    case "int32":
      return view.getInt32(offset, little);
    case "uint":
    case "uint32":
      return view.getUint32(offset, little);
    case "double":
    case "float64":
      return view.getFloat64(offset, little);
    default:
      return view.getFloat32(offset, little);
  }
}

function parsePly(buf: ArrayBuffer): Box | null {
  const bytes = new Uint8Array(buf);
  const headerText = new TextDecoder("ascii").decode(
    bytes.subarray(0, Math.min(bytes.length, 8192)),
  );
  const endIdx = headerText.indexOf("end_header");
  if (!headerText.startsWith("ply") || endIdx === -1) return null;
  const headerEnd = headerText.indexOf("\n", endIdx) + 1;
  const lines = headerText.slice(0, endIdx).split(/\r?\n/);

  let format = "ascii";
  let vertexCount = 0;
  let inVertex = false;
  const props: { name: string; type: string }[] = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("format ")) format = line.split(/\s+/)[1] ?? "ascii";
    else if (line.startsWith("element ")) {
      const [, name, count] = line.split(/\s+/);
      inVertex = name === "vertex";
      if (inVertex) vertexCount = Number(count) || 0;
    } else if (inVertex && line.startsWith("property ")) {
      const parts = line.split(/\s+/);
      if (parts[1] === "list") continue;
      props.push({ type: parts[1] ?? "float", name: parts[2] ?? "" });
    }
  }
  if (!vertexCount) return null;

  const box = emptyBox();
  const ix = props.findIndex((p) => p.name === "x");
  const iy = props.findIndex((p) => p.name === "y");
  const iz = props.findIndex((p) => p.name === "z");
  if (ix < 0 || iy < 0 || iz < 0) return null;

  if (format === "ascii") {
    const body = new TextDecoder("ascii").decode(bytes.subarray(headerEnd));
    const rows = body.split(/\r?\n/);
    for (let i = 0; i < rows.length && box.count < vertexCount; i++) {
      const row = rows[i];
      if (!row) continue;
      const v = row.trim().split(/\s+/);
      if (v.length < props.length) continue;
      grow(box, Number(v[ix]), Number(v[iy]), Number(v[iz]));
    }
    return box.count ? box : null;
  }

  const little = format.includes("little");
  const stride = props.reduce((s, p) => s + (PLY_TYPE_BYTES[p.type] ?? 4), 0);
  const offsets: number[] = [];
  let acc = 0;
  for (const p of props) {
    offsets.push(acc);
    acc += PLY_TYPE_BYTES[p.type] ?? 4;
  }
  const view = new DataView(buf);
  // Big clouds don't need every point for a bounding box — stride-sample.
  const step = Math.max(1, Math.floor(vertexCount / 400_000));
  for (let i = 0; i < vertexCount; i += step) {
    const base = headerEnd + i * stride;
    if (base + stride > buf.byteLength) break;
    grow(
      box,
      readScalar(view, base + (offsets[ix] ?? 0), props[ix]?.type ?? "float", little),
      readScalar(view, base + (offsets[iy] ?? 0), props[iy]?.type ?? "float", little),
      readScalar(view, base + (offsets[iz] ?? 0), props[iz]?.type ?? "float", little),
    );
  }
  return box.count ? box : null;
}

function parseObj(text: string): Box | null {
  const box = emptyBox();
  for (const line of text.split(/\r?\n/)) {
    if (line.charCodeAt(0) !== 118 /* v */ || line[1] !== " ") continue;
    const v = line.split(/\s+/);
    grow(box, Number(v[1]), Number(v[2]), Number(v[3]));
  }
  return box.count ? box : null;
}

async function parseGltf(buf: ArrayBuffer): Promise<Box | null> {
  const [{ GLTFLoader }, THREE] = await Promise.all([
    import("three/examples/jsm/loaders/GLTFLoader.js"),
    import("three"),
  ]);
  const loader = new GLTFLoader();
  const gltf = await loader.parseAsync(buf, "");
  const b = new THREE.Box3().setFromObject(gltf.scene);
  if (!Number.isFinite(b.min.x) || b.isEmpty()) return null;
  return {
    min: [b.min.x, b.min.y, b.min.z],
    max: [b.max.x, b.max.y, b.max.z],
    count: 0,
  };
}

function toMetrics(box: Box, format: string, fileName: string): DepthMetrics | null {
  const ex = box.max[0] - box.min[0];
  const ey = box.max[1] - box.min[1];
  const ez = box.max[2] - box.min[2];
  if (![ex, ey, ez].every((v) => Number.isFinite(v) && v > 0)) return null;

  // Most exports are Y-up; some pipelines (and raw LiDAR point clouds) are
  // Z-up. Ceiling height is the odd one out: it's the axis in the 2.0-6.0 m
  // band while the two floor axes are usually larger.
  const plausibleHeight = (v: number) => v >= 1.8 && v <= 6.5;
  let upAxis: "y" | "z" = "y";
  if (!plausibleHeight(ey) && plausibleHeight(ez)) upAxis = "z";
  else if (plausibleHeight(ey) && plausibleHeight(ez)) upAxis = ey <= ez ? "y" : "z";
  else upAxis = ey <= ez ? "y" : "z";

  const height = upAxis === "y" ? ey : ez;
  // Preserve source axes instead of sorting by magnitude. X is the export's
  // east-west axis; the remaining horizontal axis is north-south. Sorting the
  // two silently swaps long and short walls whenever north-south is longer.
  const width = ex;
  const length = upAxis === "y" ? ez : ey;

  const r = (v: number) => Math.round(v * 1000) / 1000;
  return {
    format,
    width_m: r(width),
    length_m: r(length),
    height_m: r(height),
    points: box.count,
    extents: { x: r(ex), y: r(ey), z: r(ez) },
    up_axis: upAxis,
    units: "m",
    source_file: fileName,
  };
}

/** Reads a depth export and returns its measured bounding box, if readable. */
export async function parseDepthFile(file: File): Promise<DepthParseResult> {
  const ext = (file.name.split(".").pop() ?? "").toLowerCase();
  try {
    if (ext === "ply") {
      const box = parsePly(await file.arrayBuffer());
      return box
        ? { metrics: toMetrics(box, "PLY", file.name) }
        : { metrics: null, reason: "The PLY header could not be read." };
    }
    if (ext === "obj") {
      const box = parseObj(await file.text());
      return box
        ? { metrics: toMetrics(box, "OBJ", file.name) }
        : { metrics: null, reason: "No vertices found in the OBJ file." };
    }
    if (ext === "glb" || ext === "gltf") {
      const box = await parseGltf(await file.arrayBuffer());
      return box
        ? { metrics: toMetrics(box, ext.toUpperCase(), file.name) }
        : { metrics: null, reason: "The glTF scene contained no measurable geometry." };
    }
    return {
      metrics: null,
      reason: `.${ext} can't be measured in the browser. It will still be stored with the scan, but scale will come from the photos.`,
    };
  } catch (err) {
    return {
      metrics: null,
      reason: err instanceof Error ? err.message : "The depth file could not be read.",
    };
  }
}
