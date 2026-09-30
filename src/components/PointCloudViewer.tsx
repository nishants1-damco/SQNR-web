import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { Viewer3DObject, Viewer3DPortal, Viewer3DSurface } from "./RoomViewer3D";
import {
  WALLS,
  placeObjects,
  placePortals,
  portalHitTest,
  wallPoint,
  type PlacedObject,
  type PlacedPortal,
} from "@spatial/domain/room-geometry";

const CAT_COLORS: Record<string, [number, number, number]> = {
  seating: [0.31, 0.84, 0.78],
  table: [0.89, 0.78, 0.35],
  storage: [0.66, 0.55, 0.88],
  appliance: [0.88, 0.57, 0.35],
  electronics: [0.44, 0.71, 0.91],
  lighting: [0.89, 0.78, 0.35],
  decor: [0.66, 0.55, 0.88],
  plant: [0.44, 0.82, 0.54],
  rug: [0.88, 0.57, 0.35],
  fixture: [0.44, 0.71, 0.91],
};

// Deterministic pseudo-random so the cloud is stable between renders.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export interface CloudStats {
  total: number;
  structure: number;
  objects: number;
  density: number;
  culled: number;
  stations: number;
}

/** A capture viewpoint, in the same metric frame as the placed geometry. */
export interface Station {
  x: number;
  y: number;
  z: number;
}

/**
 * Ray/AABB slab test. Returns the entry distance along `dir` (unit length) or
 * null when the ray misses the box.
 */
function rayBoxHit(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
): number | null {
  let t0 = 0;
  let t1 = Infinity;
  const axes: Array<[number, number, number, number]> = [
    [ox, dx, minX, maxX],
    [oy, dy, minY, maxY],
    [oz, dz, minZ, maxZ],
  ];
  for (const [o, d, lo, hi] of axes) {
    if (Math.abs(d) < 1e-9) {
      if (o < lo || o > hi) return null;
      continue;
    }
    let ta = (lo - o) / d;
    let tb = (hi - o) / d;
    if (ta > tb) [ta, tb] = [tb, ta];
    t0 = Math.max(t0, ta);
    t1 = Math.min(t1, tb);
    if (t0 > t1) return null;
  }
  return t0;
}

/**
 * Samples the SAME placed geometry the 3D viewer renders: identical origin,
 * identical wall planes, identical portal sills, identical object clamping.
 *
 * The cloud is *view honest*: every sample must be visible from at least one
 * capture station, so back faces of furniture and floor hidden behind a sofa
 * are dropped the way a real depth sensor would leave holes there.
 */
function buildCloud(
  width: number,
  length: number,
  height: number,
  objects: PlacedObject[],
  portals: PlacedPortal[],
  surfaces: Viewer3DSurface[],
  densityPerM2: number,
  stations: Station[],
  occlude: boolean,
) {
  const rand = rng(2166136261);
  const pos: number[] = [];
  const col: number[] = [];
  let structure = 0;
  let objectPts = 0;
  let culled = 0;

  // Occluders: every object as a slightly shrunk box so a point sampled on an
  // object's own shell isn't rejected by its own geometry.
  const boxes = objects.map((o) => ({
    minX:
      o.x - (Math.abs(Math.cos(o.yawRad)) * o.w + Math.abs(Math.sin(o.yawRad)) * o.d) / 2 + 0.02,
    maxX:
      o.x + (Math.abs(Math.cos(o.yawRad)) * o.w + Math.abs(Math.sin(o.yawRad)) * o.d) / 2 - 0.02,
    minY: o.bottom + 0.02,
    maxY: Math.max(o.bottom + 0.04, o.bottom + o.h - 0.02),
    minZ:
      o.z - (Math.abs(Math.sin(o.yawRad)) * o.w + Math.abs(Math.cos(o.yawRad)) * o.d) / 2 + 0.02,
    maxZ:
      o.z + (Math.abs(Math.sin(o.yawRad)) * o.w + Math.abs(Math.cos(o.yawRad)) * o.d) / 2 - 0.02,
  }));

  /** True when at least one station has line of sight to the sample. */
  const visible = (x: number, y: number, z: number, nx: number, ny: number, nz: number) => {
    if (!occlude) return true;
    for (const s of stations) {
      const vx = x - s.x;
      const vy = y - s.y;
      const vz = z - s.z;
      const dist = Math.hypot(vx, vy, vz);
      if (dist < 1e-4) return true;
      // Back-face rejection: a sensor never sees a surface turned away from it.
      if (nx * vx + ny * vy + nz * vz > -0.02 * dist) continue;
      const dx = vx / dist;
      const dy = vy / dist;
      const dz = vz / dist;
      let blocked = false;
      for (const b of boxes) {
        const t = rayBoxHit(
          s.x,
          s.y,
          s.z,
          dx,
          dy,
          dz,
          b.minX,
          b.minY,
          b.minZ,
          b.maxX,
          b.maxY,
          b.maxZ,
        );
        if (t !== null && t < dist - 0.03) {
          blocked = true;
          break;
        }
      }
      if (!blocked) return true;
    }
    return false;
  };

  const surfaceTone = (kind: string) => {
    const s = surfaces.find((x) => (x.kind ?? "").toLowerCase().includes(kind));
    const refl = s?.reflectivity ?? 0.5;
    const base = 0.35 + refl * 0.45;
    return [base * 0.72, base * 0.94, base] as [number, number, number];
  };

  const push = (x: number, y: number, z: number, c: [number, number, number], jitter = 0.012) => {
    pos.push(x + (rand() - 0.5) * jitter, y + (rand() - 0.5) * jitter, z + (rand() - 0.5) * jitter);
    col.push(c[0], c[1], c[2]);
  };

  /** Push only when a station can actually see the sample. */
  const pushSeen = (
    x: number,
    y: number,
    z: number,
    n: [number, number, number],
    c: [number, number, number],
    jitter: number,
    onStructure: boolean,
  ) => {
    if (!visible(x, y, z, n[0], n[1], n[2])) {
      culled++;
      return;
    }
    push(x, y, z, c, jitter);
    if (onStructure) structure++;
    else objectPts++;
  };

  // Floor + ceiling
  const floorTone = surfaceTone("floor");
  const ceilTone = surfaceTone("ceiling");
  const floorN = Math.round(width * length * densityPerM2);
  for (let i = 0; i < floorN; i++) {
    pushSeen((rand() - 0.5) * width, 0, (rand() - 0.5) * length, [0, 1, 0], floorTone, 0.02, true);
  }
  for (let i = 0; i < Math.round(floorN * 0.6); i++) {
    pushSeen(
      (rand() - 0.5) * width,
      height,
      (rand() - 0.5) * length,
      [0, -1, 0],
      ceilTone,
      0.02,
      true,
    );
  }

  // Walls with portal cut-outs
  const wallTone = surfaceTone("wall");
  for (const wall of WALLS) {
    const run = wall.run(width, length);
    const n = Math.round(run * height * densityPerM2);
    for (let i = 0; i < n; i++) {
      const u = rand() * run;
      const v = rand() * height;
      if (portalHitTest(portals, wall.key, u, v)) continue;
      const [x, z] = wallPoint(wall.key, u, width, length);
      // Inward normal for each wall plane.
      const nrm: [number, number, number] =
        wall.key === "north"
          ? [0, 0, 1]
          : wall.key === "south"
            ? [0, 0, -1]
            : wall.key === "east"
              ? [-1, 0, 0]
              : [1, 0, 0];
      pushSeen(x, v, z, nrm, wallTone, 0.018, true);
    }
  }

  // Portal rims
  for (const p of portals) {
    const c: [number, number, number] = p.isWindow ? [0.42, 0.78, 0.95] : [0.95, 0.66, 0.3];
    const n = Math.round((p.w + p.h) * 2 * densityPerM2 * 0.6);
    for (let i = 0; i < n; i++) {
      const onVertical = rand() < 0.5;
      const u = onVertical ? p.offset + (rand() < 0.5 ? 0 : p.w) : p.offset + rand() * p.w;
      const v = onVertical ? p.sill + rand() * p.h : p.sill + (rand() < 0.5 ? 0 : p.h);
      const [x, z] = wallPoint(p.wall, u, width, length);
      const nrm: [number, number, number] =
        p.wall === "north"
          ? [0, 0, 1]
          : p.wall === "south"
            ? [0, 0, -1]
            : p.wall === "east"
              ? [-1, 0, 0]
              : [1, 0, 0];
      pushSeen(x, v, z, nrm, c, 0.01, true);
    }
  }

  // Objects as sampled shells — only the faces a station can actually see.
  for (const o of objects) {
    const c = CAT_COLORS[o.category] ?? [0.78, 0.82, 0.85];
    const area = 2 * (o.w * o.d + o.w * o.h + o.d * o.h);
    const n = Math.max(60, Math.round(area * densityPerM2 * 1.4));
    for (let i = 0; i < n; i++) {
      const face = Math.floor(rand() * 5);
      let dx = (rand() - 0.5) * o.w;
      let dy = o.bottom + rand() * o.h;
      let dz = (rand() - 0.5) * o.d;
      let nrm: [number, number, number] = [0, 1, 0];
      if (face === 0) {
        dy = o.bottom + o.h;
      } else if (face === 1) {
        dx = -o.w / 2;
        nrm = [-1, 0, 0];
      } else if (face === 2) {
        dx = o.w / 2;
        nrm = [1, 0, 0];
      } else if (face === 3) {
        dz = -o.d / 2;
        nrm = [0, 0, -1];
      } else {
        dz = o.d / 2;
        nrm = [0, 0, 1];
      }
      const cos = Math.cos(o.yawRad);
      const sin = Math.sin(o.yawRad);
      const worldX = o.x + dx * cos + dz * sin;
      const worldZ = o.z - dx * sin + dz * cos;
      const worldN: [number, number, number] = [
        nrm[0] * cos + nrm[2] * sin,
        nrm[1],
        -nrm[0] * sin + nrm[2] * cos,
      ];
      pushSeen(worldX, dy, worldZ, worldN, c, 0.01, false);
    }
  }

  return {
    positions: new Float32Array(pos),
    colors: new Float32Array(col),
    stats: {
      total: pos.length / 3,
      structure,
      objects: objectPts,
      density: densityPerM2,
      culled,
      stations: stations.length,
    } as CloudStats,
  };
}

export default function PointCloudViewer({
  width,
  length,
  height,
  objects,
  portals,
  surfaces,
  stations,
  onStats,
}: {
  width: number;
  length: number;
  height: number;
  objects: Viewer3DObject[];
  portals: Viewer3DPortal[];
  surfaces: Viewer3DSurface[];
  stations?: Station[];
  onStats?: (s: CloudStats) => void;
}) {
  const mountRef = useRef<HTMLDivElement>(null);
  const [density, setDensity] = useState(900);
  const [pointSize, setPointSize] = useState(0.022);
  const [occlude, setOcclude] = useState(true);
  const [showObjects, setShowObjects] = useState(true);

  const placedObjects = useMemo(
    () => placeObjects(width, length, height, objects),
    [width, length, height, objects],
  );
  const placedPortals = useMemo(
    () => placePortals(width, length, height, portals),
    [width, length, height, portals],
  );

  // Capture viewpoints. Without recorded stations the whole sweep was shot
  // from one spot near the room center at eye height, which is what the
  // stored camera poses say.
  const viewpoints = useMemo<Station[]>(
    () => (stations && stations.length ? stations : [{ x: 0, y: 1.5, z: 0 }]),
    [stations],
  );

  const cloud = useMemo(
    () =>
      buildCloud(
        width,
        length,
        height,
        // Hiding objects removes them as samples AND as occluders, so the
        // shell comes back whole instead of keeping their sensor shadows.
        showObjects ? placedObjects : [],
        placedPortals,
        surfaces,
        density,
        viewpoints,
        occlude,
      ),
    [
      width,
      length,
      height,
      showObjects,
      placedObjects,
      placedPortals,
      surfaces,
      density,
      viewpoints,
      occlude,
    ],
  );

  useEffect(() => {
    onStats?.(cloud.stats);
  }, [cloud, onStats]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x070c12);
    const camera = new THREE.PerspectiveCamera(
      55,
      mount.clientWidth / Math.max(1, mount.clientHeight),
      0.05,
      200,
    );
    const center = new THREE.Vector3(0, height / 2, 0);
    const dir = new THREE.Vector3(0.72, 0.52, 0.72).normalize();
    const corners: THREE.Vector3[] = [];
    for (const sx of [-1, 1])
      for (const sy of [0, 1])
        for (const sz of [-1, 1])
          corners.push(new THREE.Vector3((sx * width) / 2, sy * height, (sz * length) / 2));

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    mount.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.target.copy(center);

    // Exact fit: project the eight room corners onto the camera basis and solve
    // for the distance where every one of them lands inside the frustum.
    const frameRoom = () => {
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      if (!w || !h) return;
      const aspect = w / h;
      const vFov = (camera.fov * Math.PI) / 180;
      const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
      const forward = dir.clone().negate();
      const right = new THREE.Vector3()
        .crossVectors(forward, new THREE.Vector3(0, 1, 0))
        .normalize();
      const up = new THREE.Vector3().crossVectors(right, forward).normalize();
      let dist = 0.1;
      for (const c of corners) {
        const v = c.clone().sub(center);
        const depth = v.dot(forward);
        const x = Math.abs(v.dot(right));
        const y = Math.abs(v.dot(up));
        dist = Math.max(dist, x / Math.tan(hFov / 2) - depth, y / Math.tan(vFov / 2) - depth);
      }
      dist *= 1.08;
      camera.aspect = aspect;
      camera.near = Math.max(0.05, dist / 400);
      camera.far = dist * 8;
      camera.position.copy(dir).multiplyScalar(dist).add(center);
      camera.lookAt(center);
      camera.updateProjectionMatrix();
      controls.target.copy(center);
      controls.update();
    };

    let userMoved = false;
    controls.addEventListener("start", () => {
      userMoved = true;
    });
    frameRoom();

    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(cloud.positions, 3));
    geom.setAttribute("color", new THREE.BufferAttribute(cloud.colors, 3));
    const mat = new THREE.PointsMaterial({
      size: pointSize,
      vertexColors: true,
      sizeAttenuation: true,
    });
    const points = new THREE.Points(geom, mat);
    scene.add(points);

    const grid = new THREE.GridHelper(Math.max(width, length) * 1.5, 20, 0x1d3242, 0x13202b);
    grid.position.y = -0.002;
    scene.add(grid);

    let raf = 0;
    const tick = () => {
      controls.update();
      renderer.render(scene, camera);
      raf = requestAnimationFrame(tick);
    };
    tick();

    const onResize = () => {
      if (!mount.clientWidth) return;
      renderer.setSize(mount.clientWidth, mount.clientHeight);
      if (!userMoved) frameRoom();
      else {
        camera.aspect = mount.clientWidth / Math.max(1, mount.clientHeight);
        camera.updateProjectionMatrix();
      }
    };
    window.addEventListener("resize", onResize);
    const ro = new ResizeObserver(onResize);
    ro.observe(mount);

    const onDouble = () => {
      userMoved = false;
      frameRoom();
    };
    renderer.domElement.addEventListener("dblclick", onDouble);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      ro.disconnect();
      renderer.domElement.removeEventListener("dblclick", onDouble);
      controls.dispose();
      geom.dispose();
      mat.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
    };
  }, [cloud, pointSize, width, length, height]);

  const exportPly = () => {
    const n = cloud.positions.length / 3;
    const lines = [
      "ply",
      "format ascii 1.0",
      `element vertex ${n}`,
      "property float x",
      "property float y",
      "property float z",
      "property uchar red",
      "property uchar green",
      "property uchar blue",
      "end_header",
    ];
    const P = cloud.positions;
    const C = cloud.colors;
    for (let i = 0; i < n; i++) {
      const x = P[i * 3] ?? 0;
      const y = P[i * 3 + 1] ?? 0;
      const z = P[i * 3 + 2] ?? 0;
      const r = Math.round((C[i * 3] ?? 0) * 255);
      const g = Math.round((C[i * 3 + 1] ?? 0) * 255);
      const b = Math.round((C[i * 3 + 2] ?? 0) * 255);
      lines.push(`${x.toFixed(4)} ${y.toFixed(4)} ${z.toFixed(4)} ${r} ${g} ${b}`);
    }
    const blob = new Blob([lines.join("\n")], { type: "application/octet-stream" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "sqnr-pointcloud.ply";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div>
      <div ref={mountRef} className="relative h-[60vh] w-full">
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-center justify-between gap-1.5 p-2">
          <button
            type="button"
            onClick={() => setOcclude((v) => !v)}
            className={`pointer-events-auto rounded-full px-2.5 py-[5px] text-[11px] font-medium leading-none backdrop-blur transition-colors ${
              occlude ? "bg-primary text-primary-foreground" : "bg-background/70 text-foreground"
            }`}
          >
            Honest
          </button>
          <button
            type="button"
            onClick={() => setShowObjects((v) => !v)}
            className={`pointer-events-auto rounded-full px-2.5 py-[5px] text-[11px] font-medium leading-none backdrop-blur transition-colors ${
              showObjects
                ? "bg-primary text-primary-foreground"
                : "bg-background/70 text-foreground"
            }`}
          >
            Objects
          </button>
        </div>
        <span className="pointer-events-none absolute bottom-2 left-2 z-10 text-[10px] uppercase tracking-wide text-muted-foreground/70">
          geometry-based
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-4 border-t border-border px-3 py-2 text-[11px] uppercase tracking-wide text-muted-foreground">
        <label className="flex items-center gap-2">
          Density
          <input
            type="range"
            min={200}
            max={2500}
            step={100}
            value={density}
            onChange={(e) => setDensity(Number(e.target.value))}
          />
        </label>
        <label className="flex items-center gap-2">
          Point size
          <input
            type="range"
            min={0.008}
            max={0.06}
            step={0.002}
            value={pointSize}
            onChange={(e) => setPointSize(Number(e.target.value))}
          />
        </label>
        <button type="button" className="underline underline-offset-2" onClick={exportPly}>
          Export .ply
        </button>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-1 border-t border-border px-3 py-2 text-[11px] uppercase tracking-wide text-muted-foreground">
        <span className="tabular normal-case">
          drag to spin · scroll to zoom · right-drag to pan
        </span>
      </div>
    </div>
  );
}
