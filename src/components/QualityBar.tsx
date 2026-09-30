// UI wrapper for `quality-signals`. Renders three tiny bars: coverage,
// stability, overall. Pure presentational — takes computed signals in
// and doesn't touch state.
import { qualityLabel, type QualitySignals } from "@spatial/domain/quality-signals";
import { cn } from "@/lib/utils";

export interface QualityBarProps {
  signals: QualitySignals;
  className?: string;
}

export function QualityBar({ signals, className }: QualityBarProps) {
  const label = qualityLabel(signals);
  const color =
    label === "good" ? "bg-emerald-500" : label === "ok" ? "bg-amber-500" : "bg-rose-500";
  return (
    <div
      className={cn("flex flex-col gap-1 rounded-md bg-black/70 p-2 text-xs text-white", className)}
    >
      <div className="flex items-center justify-between">
        <span>Coverage</span>
        <span>
          {signals.filledBins}/{signals.totalBins}
        </span>
      </div>
      <div className="h-1 w-full overflow-hidden rounded bg-white/20">
        <div
          className={cn("h-full", color)}
          style={{ width: `${Math.round(signals.coverage * 100)}%` }}
        />
      </div>
      <div className="flex items-center justify-between">
        <span>Stability</span>
        <span className="capitalize">{label}</span>
      </div>
      <div className="h-1 w-full overflow-hidden rounded bg-white/20">
        <div
          className={cn("h-full", color)}
          style={{ width: `${Math.round(signals.stability * 100)}%` }}
        />
      </div>
    </div>
  );
}
