/**
 * Room map of capture viewpoints, colored by health: green = good, red =
 * go back and reshoot from there. The room is drawn north-up; each corner
 * viewpoint sits in the quadrant its sweep came from (see station-health.ts),
 * so the user can see which physical corner to walk to.
 */
import { Check, RefreshCw, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { RoomSide, StationHealth } from "@spatial/domain/station-health";

const GOOD = "oklch(0.627 0.194 149.214)";
const BAD = "var(--destructive)";

const SIDE_CORNER: Record<RoomSide, [number, number]> = {
  NE: [1, -1],
  SE: [1, 1],
  SW: [-1, 1],
  NW: [-1, -1],
};

export function StationHealthMap({
  stations,
  widthM,
  lengthM,
  onReshoot,
  reshootDisabledReason,
  highlight,
}: {
  stations: StationHealth[];
  /** Room size, when known, sets the outline's proportions. */
  widthM?: number | null;
  lengthM?: number | null;
  onReshoot?: (station: number) => void;
  /** Shown instead of the reshoot buttons when reshooting isn't possible now. */
  reshootDisabledReason?: string | null;
  /** Viewpoints to emphasize, e.g. the ones being reshot. */
  highlight?: number | number[] | null;
}) {
  const bad = stations.filter((s) => s.status === "reshoot");
  const highlighted = new Set(highlight == null ? [] : [highlight].flat());

  // North-up outline, proportions from the room when known (clamped so a
  // bad estimate can't squash the map into a sliver).
  const aspect =
    widthM && lengthM && widthM > 0 && lengthM > 0
      ? Math.min(1.6, Math.max(0.6, lengthM / widthM))
      : 1;
  const W = 100;
  const H = Math.round(W * aspect);
  const pad = 14;
  const room = { x: pad, y: pad, w: W - pad * 2, h: H - pad * 2 };
  const cx = W / 2;
  const cy = H / 2;

  const perSide = new Map<RoomSide, number>();
  const markers = stations.map((s) => {
    if (s.kind === "center") return { s, x: cx, y: cy };
    if (!s.side) return null;
    const [sx, sy] = SIDE_CORNER[s.side];
    const nth = perSide.get(s.side) ?? 0;
    perSide.set(s.side, nth + 1);
    // Several viewpoints on one side step toward the center so none overlap.
    const inset = 9 + nth * 10;
    return {
      s,
      x: cx + sx * (room.w / 2 - inset),
      y: cy + sy * (room.h / 2 - inset),
    };
  });

  return (
    <div className="space-y-3">
      <div
        className={`flex items-center gap-2 text-sm font-medium ${bad.length ? "text-destructive" : ""}`}
        style={bad.length ? undefined : { color: GOOD }}
      >
        {bad.length ? <TriangleAlert className="size-4" /> : <Check className="size-4" />}
        {bad.length
          ? `Reshoot ${bad.length === 1 ? bad[0]?.label.toLowerCase() : `${bad.length} viewpoints`} (shown in red)`
          : "All viewpoints look good"}
      </div>

      <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="mx-auto w-full max-w-[220px] shrink-0"
          role="img"
          aria-label={
            bad.length
              ? `Room map: ${bad.map((s) => s.label).join(", ")} ${bad.length === 1 ? "needs" : "need"} a reshoot`
              : "Room map: all viewpoints look good"
          }
        >
          <rect
            x={room.x}
            y={room.y}
            width={room.w}
            height={room.h}
            rx={2}
            fill="var(--secondary)"
            stroke="var(--border)"
            strokeWidth={1.2}
          />
          <text
            x={cx}
            y={7}
            textAnchor="middle"
            fontSize={6}
            fontWeight={600}
            fill="currentColor"
            opacity={0.55}
          >
            N
          </text>
          {markers.map((m) => {
            if (!m) return null;
            const color = m.s.status === "good" ? GOOD : BAD;
            const emphasized = highlighted.has(m.s.station);
            return (
              <g key={m.s.station}>
                {emphasized && (
                  <circle cx={m.x} cy={m.y} r={8.5} fill="none" stroke={color} strokeWidth={1} />
                )}
                <circle cx={m.x} cy={m.y} r={5.5} fill={color} />
                <text
                  x={m.x}
                  y={m.y + 2}
                  textAnchor="middle"
                  fontSize={5.5}
                  fontWeight={700}
                  fill="white"
                >
                  {m.s.kind === "center" ? "C" : m.s.station}
                </text>
              </g>
            );
          })}
        </svg>

        <ul className="min-w-0 flex-1 space-y-2">
          {stations.map((s) => (
            <li key={s.station} className="flex items-center gap-3">
              <span
                className="size-2.5 shrink-0 rounded-full"
                style={{ background: s.status === "good" ? GOOD : BAD }}
              />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{s.label}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {s.status === "good"
                    ? `${s.covered}/${s.expected} directions · looks good`
                    : s.reasons.join(" · ")}
                </div>
              </div>
              {onReshoot && !reshootDisabledReason && (
                <Button
                  size="sm"
                  variant={s.status === "reshoot" ? "default" : "ghost"}
                  onClick={() => onReshoot(s.station)}
                >
                  <RefreshCw className="mr-1 size-3.5" />
                  Reshoot
                </Button>
              )}
            </li>
          ))}
        </ul>
      </div>

      {onReshoot && reshootDisabledReason && (
        <p className="text-xs text-muted-foreground">{reshootDisabledReason}</p>
      )}
    </div>
  );
}
