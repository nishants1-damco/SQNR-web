/**
 * 2D floor plan (read-only).
 *
 * Renders a static SVG of the reconstructed room: shell, portals, objects,
 * labels with caption collision resolution, and an optional PDF export. The
 * geometry is produced by the AI reconstruction pipeline; this view only
 * displays it.
 *
 * Conventions:
 *   - The plan CRS has +y = compass north. The SVG is drawn in centimeters
 *     (`S = 100`) so sub-1 user-unit fonts don't collapse.
 *   - SVG y grows downward, so we render at y = -y_m (matching FloorPlan and
 *     `room-geometry.ts::placeObjects` which maps y_m to -z in three.js).
 */
import { useRef, useState } from "react";
import { placeObjects } from "@spatial/domain/room-geometry";
import { exportFloorPlanPdf, type FloorPlanExportMeta } from "@/lib/floor-plan-export";
import { FileDown } from "lucide-react";

export interface PlanObject {
  id: string;
  label: string;
  category: string | null;
  x_m: number | null;
  y_m: number | null;
  against_wall?: string | null;
  attributes?: unknown;
  width_m: number | null;
  depth_m: number | null;
  confidence: number | null;
  height_m?: number | null;
  yaw_deg?: number | null;
}

export interface PlanPortal {
  id: string;
  kind: string;
  wall: string;
  offset_m: number | null;
  width_m: number | null;
}

const CATEGORY_COLORS: Record<string, string> = {
  seating: "var(--chart-1)",
  table: "var(--chart-2)",
  storage: "var(--chart-3)",
  appliance: "var(--chart-4)",
  electronics: "var(--chart-5)",
  lighting: "var(--chart-2)",
  decor: "var(--chart-3)",
  plant: "var(--chart-1)",
  rug: "var(--chart-4)",
  fixture: "var(--chart-5)",
};

// See file header re. cm scale.
const S = 100;

export function FloorPlan2D({
  width,
  length,
  objects,
  portals,
  exportMeta,
}: {
  width: number;
  length: number;
  objects: PlanObject[];
  portals: PlanPortal[];
  /** When present, a PDF-export button is rendered next to the Objects toggle. */
  exportMeta?: FloorPlanExportMeta;
}) {
  const [hover, setHover] = useState<string | null>(null);
  const [showObjects, setShowObjects] = useState(true);
  const svgRef = useRef<SVGSVGElement>(null);

  const pad = 1.2 * S;
  const W = width * S;
  const L = length * S;
  const vb = { x: -W / 2 - pad, y: -L / 2 - pad, w: W + pad * 2, h: L + pad * 2 };

  const placedObjects = placeObjects(width, length, 100, objects);

  const portalSegment = (p: PlanPortal) => {
    const w = (p.width_m ?? 0.9) * S;
    const off = (p.offset_m ?? 0) * S;
    switch (p.wall) {
      case "north":
        return { x1: -W / 2 + off, y1: -L / 2, x2: -W / 2 + off + w, y2: -L / 2 };
      case "south":
        return { x1: -W / 2 + off, y1: L / 2, x2: -W / 2 + off + w, y2: L / 2 };
      case "east":
        return { x1: W / 2, y1: L / 2 - off, x2: W / 2, y2: L / 2 - off - w };
      default:
        return { x1: -W / 2, y1: L / 2 - off, x2: -W / 2, y2: L / 2 - off - w };
    }
  };

  return (
    <div className="relative w-full overflow-hidden rounded-md border border-border bg-card">
      <div className="absolute right-2 top-2 z-10 flex items-center gap-1.5">
        {exportMeta && (
          <button
            type="button"
            onClick={() => exportFloorPlanPdf(svgRef.current, exportMeta)}
            aria-label="Export as PDF"
            className="press inline-flex items-center gap-1 rounded-full bg-background/70 px-2.5 py-[5px] text-[11px] font-medium leading-none text-foreground backdrop-blur transition-colors hover:bg-background"
          >
            <FileDown className="size-3" />
            PDF
          </button>
        )}
        <button
          type="button"
          onClick={() => setShowObjects((v) => !v)}
          className={`rounded-full px-2.5 py-[5px] text-[11px] font-medium leading-none backdrop-blur transition-colors ${
            showObjects ? "bg-primary text-primary-foreground" : "bg-background/70 text-foreground"
          }`}
        >
          Objects
        </button>
      </div>

      <svg
        ref={svgRef}
        viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
        className="h-full w-full"
        style={{ aspectRatio: `${vb.w} / ${vb.h}` }}
      >
        <defs>
          <pattern id="fpgrid" width={0.5 * S} height={0.5 * S} patternUnits="userSpaceOnUse">
            <path
              d={`M ${0.5 * S} 0 L 0 0 0 ${0.5 * S}`}
              fill="none"
              stroke="var(--border)"
              strokeWidth={0.8}
            />
          </pattern>
        </defs>
        <rect x={vb.x} y={vb.y} width={vb.w} height={vb.h} fill="url(#fpgrid)" />

        <rect
          x={-W / 2}
          y={-L / 2}
          width={W}
          height={L}
          fill="color-mix(in oklch, var(--primary) 6%, transparent)"
          stroke="var(--primary)"
          strokeWidth={6}
        />

        {portals.map((p) => {
          const s = portalSegment(p);
          const color = p.kind.toLowerCase().includes("window")
            ? "var(--chart-5)"
            : "var(--accent)";
          return (
            <g key={p.id}>
              <line
                x1={s.x1}
                y1={s.y1}
                x2={s.x2}
                y2={s.y2}
                stroke={color}
                strokeWidth={14}
                strokeLinecap="round"
              />
              <title>{`${p.kind} · ${p.wall} wall · ${(p.width_m ?? 0).toFixed(2)} m`}</title>
            </g>
          );
        })}

        {(() => {
          if (!showObjects) return null;
          const placed: Array<{ x: number; y: number; w: number; h: number }> = [];
          const fontSize = Math.max(vb.w, vb.h) / 34;
          const charW = fontSize * 0.56;
          const lineH = fontSize * 1.55;
          const ordered = [...objects].sort((a, b) => (b.y_m ?? 0) - (a.y_m ?? 0));
          return ordered.map((o) => {
            const placedObject = placedObjects.find((p) => p.id === o.id);
            if (!placedObject) return null;
            const w = Math.max(placedObject.w * S, 15);
            const d = Math.max(placedObject.d * S, 15);
            const cx = placedObject.x * S;
            const cy = placedObject.z * S;
            const x = cx - w / 2;
            const y = cy - d / 2;
            const color = CATEGORY_COLORS[o.category ?? "other"] ?? "var(--muted-foreground)";
            const active = hover === o.id;

            const clean = o.label.replace(/\s+/g, " ").trim();
            const text = clean.length > 18 ? `${clean.slice(0, 17)}…` : clean;
            const labelW = text.length * charW;
            const halfW = labelW / 2 + fontSize * 0.3;
            const clampX = (v: number) =>
              Math.min(Math.max(v, vb.x + halfW + 4), vb.x + vb.w - halfW - 4);
            const lx = clampX(cx);
            let ly = cy;
            for (let step = 0; step < 14; step++) {
              const clash = placed.some(
                (p) =>
                  Math.abs(p.y - ly) < lineH * 0.95 && Math.abs(p.x - lx) < (p.w + labelW) / 2 + 4,
              );
              if (!clash) break;
              const k = Math.ceil((step + 1) / 2);
              ly = cy + (step % 2 === 0 ? 1 : -1) * k * lineH;
            }
            ly = Math.min(Math.max(ly, vb.y + lineH), vb.y + vb.h - fontSize * 0.6);
            placed.push({ x: lx, y: ly, w: labelW, h: lineH });
            const leader = Math.hypot(lx - cx, ly - cy) > fontSize;
            const headings = (o.attributes as { supporting_headings_deg?: unknown } | null)
              ?.supporting_headings_deg;
            const sightings = Array.isArray(headings) ? headings.length : 0;
            const uncertain = sightings <= 1 || (o.confidence ?? 0) < 0.55;

            return (
              <g
                key={o.id}
                onMouseEnter={() => setHover(o.id)}
                onMouseLeave={() => setHover(null)}
                style={{ cursor: "pointer" }}
              >
                <g transform={`rotate(${placedObject.yawDeg} ${cx} ${cy})`}>
                  <rect
                    x={x}
                    y={y}
                    width={w}
                    height={d}
                    rx={6}
                    fill={color}
                    fillOpacity={uncertain ? (active ? 0.22 : 0.08) : active ? 0.55 : 0.28}
                    stroke={color}
                    strokeWidth={3.5}
                    strokeDasharray={uncertain ? "10 8" : undefined}
                  />
                </g>

                {leader && (
                  <line
                    x1={cx}
                    y1={cy}
                    x2={lx}
                    y2={ly - fontSize * 0.3}
                    stroke={color}
                    strokeWidth={fontSize * 0.05}
                    strokeOpacity="0.6"
                  />
                )}
                <rect
                  x={lx - labelW / 2 - fontSize * 0.25}
                  y={ly - fontSize * 0.9}
                  width={labelW + fontSize * 0.5}
                  height={fontSize * 1.25}
                  rx={fontSize * 0.35}
                  fill="var(--card)"
                  fillOpacity={0.9}
                  style={{ pointerEvents: "none" }}
                />
                <text
                  x={lx}
                  y={ly}
                  textAnchor="middle"
                  fill="var(--foreground)"
                  fontSize={fontSize}
                  style={{ pointerEvents: "none" }}
                >
                  {text}
                </text>
                <title>{`${o.label} · ${Math.round((o.confidence ?? 0) * 100)}% confidence · ${sightings || "no"} supporting ${sightings === 1 ? "frame" : "frames"}${uncertain ? " (shown as an outline: single or weak sighting)" : ""}`}</title>
              </g>
            );
          });
        })()}

        <circle cx="0" cy="0" r={Math.max(vb.w, vb.h) / 110} fill="var(--primary)" />
        <text
          x="0"
          y={L / 2 + pad * 0.72}
          textAnchor="middle"
          fill="var(--muted-foreground)"
          fontSize={Math.max(vb.w, vb.h) / 26}
        >
          {width.toFixed(2)} m × {length.toFixed(2)} m
        </text>
        <text
          x={0}
          y={-L / 2 - pad * 0.42}
          textAnchor="middle"
          fill="var(--muted-foreground)"
          fontSize={Math.max(vb.w, vb.h) / 26}
        >
          N ↑
        </text>
      </svg>
    </div>
  );
}
