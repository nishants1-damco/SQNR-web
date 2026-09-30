import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { placeObjects, placePortals } from "@spatial/domain/room-geometry";

export interface Viewer3DObject {
  id: string;
  label: string;
  category: string | null;
  x_m: number | null;
  y_m: number | null;
  width_m: number | null;
  depth_m: number | null;
  height_m: number | null;
  attributes?: unknown;
  yaw_deg?: number | null;
}

export interface Viewer3DPortal {
  id: string;
  kind: string;
  wall: string;
  offset_m: number | null;
  width_m: number | null;
  height_m: number | null;
  sill_m?: number | null;
}

export interface Viewer3DSurface {
  kind: string | null;
  color_hex: string | null;
  reflectivity: number | null;
}

const CAT_COLORS: Record<string, number> = {
  seating: 0x4fd6c7,
  table: 0xe3c65a,
  storage: 0xa98be0,
  appliance: 0xe0925a,
  electronics: 0x6fb6e8,
  lighting: 0xe3c65a,
  decor: 0xa98be0,
  plant: 0x6fd08a,
  rug: 0xe0925a,
  fixture: 0x6fb6e8,
};

const LABEL_FONT = "28px monospace";
const LABEL_LINE_PX = 36;
const LABEL_PAD_PX = 12;
/** Wrap width: about 22 monospace characters at LABEL_FONT. */
const LABEL_MAX_LINE_PX = 360;
const LABEL_MAX_LINES = 3;
/** Canvas pixels are drawn at 2× so text stays crisp when zoomed in. */
const LABEL_DPR = 2;
/** World size of one canvas pixel; matches the old 64px → 0.22 m label. */
const LABEL_M_PER_PX = 0.22 / 64;

/** Word-wraps a label to fit `maxWidth`, ellipsising only past `maxLines`. */
function wrapLabel(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxLines: number,
) {
  const lines: string[] = [];
  let line = "";
  for (const word of text.trim().split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(next).width > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  let last = kept[maxLines - 1] ?? "";
  while (last.length > 1 && ctx.measureText(`${last}…`).width > maxWidth) {
    last = last.slice(0, -1);
  }
  kept[maxLines - 1] = `${last.trimEnd()}…`;
  return kept;
}

/**
 * A billboard label sized to its (wrapped) text. Anchored at its bottom edge
 * so multi-line labels grow upward, and drawn over everything so walls and
 * boxes never slice through it.
 */
function labelSprite(text: string) {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  let lines = [text];
  let textWidth = LABEL_MAX_LINE_PX;
  if (ctx) {
    ctx.font = LABEL_FONT;
    lines = wrapLabel(ctx, text, LABEL_MAX_LINE_PX, LABEL_MAX_LINES);
    textWidth = Math.max(1, ...lines.map((l) => ctx.measureText(l).width));
  }
  const w = Math.ceil(textWidth + LABEL_PAD_PX * 2);
  const h = lines.length * LABEL_LINE_PX + LABEL_PAD_PX;
  canvas.width = w * LABEL_DPR;
  canvas.height = h * LABEL_DPR;
  if (ctx) {
    // Resizing the canvas resets the context, so style it after.
    ctx.scale(LABEL_DPR, LABEL_DPR);
    ctx.fillStyle = "rgba(12,18,24,0.75)";
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "#dff6f4";
    ctx.font = LABEL_FONT;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    lines.forEach((l, i) => {
      ctx.fillText(l, w / 2, LABEL_PAD_PX / 2 + LABEL_LINE_PX * (i + 0.5) + 2);
    });
  }
  const tex = new THREE.CanvasTexture(canvas);
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false }),
  );
  sprite.renderOrder = 10;
  sprite.center.set(0.5, 0);
  sprite.scale.set(w * LABEL_M_PER_PX, h * LABEL_M_PER_PX, 1);
  return sprite;
}

export default function RoomViewer3D({
  width,
  length,
  height,
  objects,
  portals,
  surfaces,
}: {
  width: number;
  length: number;
  height: number;
  objects: Viewer3DObject[];
  portals: Viewer3DPortal[];
  surfaces: Viewer3DSurface[];
}) {
  const mountRef = useRef<HTMLDivElement>(null);
  const [walk, setWalk] = useState(false);
  const [showObjects, setShowObjects] = useState(true);
  const walkRef = useRef(false);
  const keys = useRef<Record<string, boolean>>({});
  const nudge = useRef({ x: 0, z: 0 });

  const placedObjects = useMemo(
    () => placeObjects(width, length, height, objects),
    [width, length, height, objects],
  );
  const placedPortals = useMemo(
    () => placePortals(width, length, height, portals),
    [width, length, height, portals],
  );

  useEffect(() => {
    walkRef.current = walk;
  }, [walk]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x101820);
    scene.fog = new THREE.Fog(0x101820, 12, 40);

    const camera = new THREE.PerspectiveCamera(
      60,
      mount.clientWidth / mount.clientHeight,
      0.05,
      200,
    );
    camera.position.set(width * 0.9, height * 1.7, length * 1.2);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    mount.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.target.set(0, height / 2, 0);

    scene.add(new THREE.HemisphereLight(0xcfe9ff, 0x20262e, 1.1));
    const key = new THREE.DirectionalLight(0xffffff, 0.8);
    key.position.set(3, 6, 2);
    scene.add(key);

    const colorOf = (kind: string, fallback: number) => {
      const s = surfaces.find((x) => (x.kind ?? "").toLowerCase().includes(kind));
      if (s?.color_hex && /^#[0-9a-f]{6}$/i.test(s.color_hex))
        return new THREE.Color(s.color_hex).getHex();
      return fallback;
    };
    const roughOf = (kind: string) => {
      const s = surfaces.find((x) => (x.kind ?? "").toLowerCase().includes(kind));
      return 1 - Math.min(Math.max(s?.reflectivity ?? 0.3, 0), 1) * 0.9;
    };

    // floor
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(width, length),
      new THREE.MeshStandardMaterial({
        color: colorOf("floor", 0x2a3340),
        roughness: roughOf("floor"),
        side: THREE.DoubleSide,
      }),
    );
    floor.rotation.x = -Math.PI / 2;
    scene.add(floor);

    const ceiling = floor.clone();
    ceiling.position.y = height;
    (ceiling.material as THREE.MeshStandardMaterial) = new THREE.MeshStandardMaterial({
      color: colorOf("ceiling", 0x39424f),
      roughness: roughOf("ceiling"),
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.25,
    });
    scene.add(ceiling);

    const wallMat = new THREE.MeshStandardMaterial({
      color: colorOf("wall", 0x3a4552),
      roughness: roughOf("wall"),
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.65,
    });
    const walls: { name: string; w: number; pos: [number, number, number]; rotY: number }[] = [
      { name: "north", w: width, pos: [0, height / 2, -length / 2], rotY: 0 },
      { name: "south", w: width, pos: [0, height / 2, length / 2], rotY: 0 },
      { name: "east", w: length, pos: [width / 2, height / 2, 0], rotY: Math.PI / 2 },
      { name: "west", w: length, pos: [-width / 2, height / 2, 0], rotY: Math.PI / 2 },
    ];
    for (const wdef of walls) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(wdef.w, height), wallMat);
      m.position.set(...wdef.pos);
      m.rotation.y = wdef.rotY;
      scene.add(m);
    }

    // grid
    const grid = new THREE.GridHelper(Math.max(width, length) * 1.5, 20, 0x3ecfc0, 0x243040);
    (grid.material as THREE.Material).opacity = 0.25;
    (grid.material as THREE.Material).transparent = true;
    grid.position.y = 0.002;
    scene.add(grid);

    const labels: THREE.Sprite[] = [];

    // portals
    for (const p of placedPortals) {
      const mat = new THREE.MeshStandardMaterial({
        color: p.isWindow ? 0x8fd7ff : 0xe3c65a,
        emissive: p.isWindow ? 0x2b6f96 : 0x4a3d10,
        transparent: true,
        opacity: p.isWindow ? 0.55 : 0.85,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(p.w, p.h), mat);
      const inset = 0.02;
      if (p.wall === "north") mesh.position.set(p.x, p.y, p.z + inset);
      else if (p.wall === "south") mesh.position.set(p.x, p.y, p.z - inset);
      else if (p.wall === "east") {
        mesh.position.set(p.x - inset, p.y, p.z);
        mesh.rotation.y = Math.PI / 2;
      } else {
        mesh.position.set(p.x + inset, p.y, p.z);
        mesh.rotation.y = Math.PI / 2;
      }
      scene.add(mesh);
      const s = labelSprite(p.kind);
      s.position.copy(mesh.position).setY(p.sill + p.h + 0.08);
      scene.add(s);
      labels.push(s);
    }

    // objects
    for (const o of showObjects ? placedObjects : []) {
      const color = CAT_COLORS[o.category] ?? 0x9aa7b4;
      const box = new THREE.Mesh(
        new THREE.BoxGeometry(o.w, o.h, o.d),
        new THREE.MeshStandardMaterial({ color, roughness: 0.6, transparent: true, opacity: 0.85 }),
      );
      box.position.set(o.x, o.bottom + o.h / 2, o.z);
      box.rotation.y = o.yawRad;
      scene.add(box);
      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(box.geometry),
        new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35 }),
      );
      edges.position.copy(box.position);
      edges.rotation.copy(box.rotation);
      scene.add(edges);
      const sprite = labelSprite(o.label);
      sprite.position.set(o.x, o.bottom + o.h + 0.1, o.z);
      scene.add(sprite);
      labels.push(sprite);
    }

    const onKey = (e: KeyboardEvent, down: boolean) => {
      keys.current[e.key.toLowerCase()] = down;
    };
    const kd = (e: KeyboardEvent) => onKey(e, true);
    const ku = (e: KeyboardEvent) => onKey(e, false);
    window.addEventListener("keydown", kd);
    window.addEventListener("keyup", ku);

    const resize = () => {
      if (!mount.clientWidth) return;
      camera.aspect = mount.clientWidth / mount.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(mount.clientWidth, mount.clientHeight);
    };
    const ro = new ResizeObserver(resize);
    ro.observe(mount);

    let raf = 0;
    const clock = new THREE.Clock();
    const dir = new THREE.Vector3();
    const render = () => {
      raf = requestAnimationFrame(render);
      const dt = clock.getDelta();
      if (walkRef.current) {
        const speed = 2.4 * dt;
        camera.getWorldDirection(dir);
        dir.y = 0;
        dir.normalize();
        const right = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0));
        const k = keys.current;
        const fwd =
          (k["w"] || k["arrowup"] ? 1 : 0) - (k["s"] || k["arrowdown"] ? 1 : 0) + nudge.current.z;
        const strafe =
          (k["d"] || k["arrowright"] ? 1 : 0) -
          (k["a"] || k["arrowleft"] ? 1 : 0) +
          nudge.current.x;
        if (fwd || strafe) {
          const move = new THREE.Vector3()
            .addScaledVector(dir, fwd * speed)
            .addScaledVector(right, strafe * speed);
          camera.position.add(move);
          controls.target.add(move);
        }
      }
      controls.update();
      renderer.render(scene, camera);
    };
    render();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("keydown", kd);
      window.removeEventListener("keyup", ku);
      controls.dispose();
      for (const l of labels) {
        l.material.map?.dispose();
        l.material.dispose();
      }
      renderer.dispose();
      mount.removeChild(renderer.domElement);
    };
  }, [width, length, height, placedObjects, placedPortals, surfaces, showObjects]);

  const hold = (x: number, z: number) => ({
    onPointerDown: () => {
      nudge.current = { x, z };
    },
    onPointerUp: () => {
      nudge.current = { x: 0, z: 0 };
    },
    onPointerLeave: () => {
      nudge.current = { x: 0, z: 0 };
    },
  });

  return (
    <div className="relative w-full overflow-hidden rounded-md border border-border bg-card">
      <div ref={mountRef} className="h-[420px] w-full touch-none" />
      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-between gap-2 p-2">
        <span className="tabular truncate rounded-full bg-background/70 px-2 py-[3px] text-[10px] leading-none text-muted-foreground backdrop-blur">
          drag to orbit · pinch to zoom
        </span>
        <div className="flex shrink-0 items-center gap-1.5">
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
          <button
            type="button"
            onClick={() => setWalk((w) => !w)}
            className={`pointer-events-auto rounded-full px-2.5 py-[5px] text-[11px] font-medium leading-none backdrop-blur transition-colors ${
              walk ? "bg-primary text-primary-foreground" : "bg-background/70 text-foreground"
            }`}
          >
            {walk ? "Walk" : "Orbit"}
          </button>
        </div>
      </div>

      {walk && (
        <div className="pointer-events-none absolute inset-x-0 bottom-2 flex items-end justify-between px-3">
          <div className="pointer-events-auto grid grid-cols-3 gap-1">
            <div />
            <button
              type="button"
              className="press rounded-full bg-background/80 p-2 backdrop-blur"
              aria-label="Forward"
              {...hold(0, 1)}
            >
              ▲
            </button>
            <div />
            <button
              type="button"
              className="press rounded-full bg-background/80 p-2 backdrop-blur"
              aria-label="Left"
              {...hold(-1, 0)}
            >
              ◀
            </button>
            <button
              type="button"
              className="press rounded-full bg-background/80 p-2 backdrop-blur"
              aria-label="Back"
              {...hold(0, -1)}
            >
              ▼
            </button>
            <button
              type="button"
              className="press rounded-full bg-background/80 p-2 backdrop-blur"
              aria-label="Right"
              {...hold(1, 0)}
            >
              ▶
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
