import { createFileRoute, Link, ClientOnly, useNavigate } from "@tanstack/react-router";
import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ApiError } from "@/api/client";
import { useSpace } from "@/api/queries";
import { spaces } from "@/api/spaces";
import { useAnalysisRun } from "@/api/useAnalysisRun";
import { isAnalysisStale } from "@spatial/domain/analysis-deadline";
import {
  assessStations,
  stationFrameFromPhoto,
  stationLabel,
} from "@spatial/domain/station-health";
import { summarizeRemovals } from "@spatial/domain/frame-removals";

import { FloorPlan2D } from "@/components/FloorPlan2D";
import { DataTab } from "@/components/DataTab";
import { MapTab } from "@/components/MapTab";
import { StationHealthMap } from "@/components/StationHealthMap";
import { DeleteSpaceDialog } from "@/components/DeleteSpaceDialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { ArrowLeft, RefreshCw, ShieldAlert, Trash2 } from "lucide-react";

const RoomViewer3D = lazy(() => import("@/components/RoomViewer3D"));
const PointCloudViewer = lazy(() => import("@/components/PointCloudViewer"));
import type { CloudStats } from "@/components/PointCloudViewer";

export const Route = createFileRoute("/space/$id")({
  head: () => ({
    meta: [
      { title: "Space detail - SQNR" },
      {
        name: "description",
        content:
          "2D plan, 3D walkthrough, tagged objects, portals, surface materials and acoustic measurements for a captured room.",
      },
      { property: "og:title", content: "Space detail - SQNR" },
      {
        property: "og:description",
        content:
          "Navigate a captured room in 2D and 3D with objects, portals, surfaces and acoustics.",
      },
      { property: "og:type", content: "article" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: SpacePage,
});

interface PrivacySweep {
  status?: "queued" | "done" | "failed";
  requested_at?: string;
  scanned?: number;
  removed?: number;
  error?: string;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="surface-card px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="tabular mt-0.5 text-sm">{value}</div>
    </div>
  );
}

function SpacePage() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [purging, setPurging] = useState(false);
  const [cloudStats, setCloudStats] = useState<CloudStats | null>(null);
  const [activeTab, setActiveTab] = useState("plan");
  const showDetails = ["plan", "walk", "cloud"].includes(activeTab);

  // One request for the scan, its rows and its frames (was five reads).
  const { data, isLoading } = useSpace(id);
  // The run happens in the worker; this follows it and refreshes the page at
  // the end, so leaving the page no longer interrupts anything.
  const analysis = useAnalysisRun(id, data?.scan);
  const reanalyzing = analysis.starting || analysis.processing;

  // The privacy sweep is a job now: report its result when it lands.
  const sweepRequested = useRef<string | null>(null);
  const sweep = (data?.scan.analysis_notes as { privacy_sweep?: PrivacySweep } | undefined)
    ?.privacy_sweep;
  useEffect(() => {
    if (!sweep || sweep.requested_at !== sweepRequested.current || sweep.status === "queued") {
      return;
    }
    sweepRequested.current = null;
    setPurging(false);
    if (sweep.status === "failed") {
      toast.error(sweep.error ?? "Privacy sweep failed");
    } else {
      const scanned = sweep.scanned ?? 0;
      toast.success(
        sweep.removed
          ? `Removed ${sweep.removed} of ${scanned} frame${scanned === 1 ? "" : "s"}: a person was in view`
          : `Screened ${scanned} frame${scanned === 1 ? "" : "s"}: no people in the room`,
      );
    }
  }, [sweep]);

  if (isLoading || !data?.scan) {
    return (
      <main className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">
        {isLoading ? "Loading space…" : "Space not found."}
      </main>
    );
  }

  const { scan, objects, portals, surfaces, photos } = data;
  const analysisNotes = (scan.analysis_notes ?? {}) as { error?: string; capture_mode?: string };
  const staleProcessing = isAnalysisStale(scan);
  // Which viewpoints need a reshoot. Manual captures have no viewpoints.
  const stationHealth =
    analysisNotes.capture_mode === "manual"
      ? []
      : assessStations(photos.map(stationFrameFromPhoto));
  // Frames removed from this scan, and why (see frame-removals.ts).
  const removals = summarizeRemovals(
    scan.analysis_notes,
    photos.map((p) => Number(p.idx)).filter((i) => Number.isInteger(i)),
  );
  const ac = (scan.acoustics ?? {}) as Record<string, unknown>;
  const w = Number(scan.width_m ?? 4);
  const l = Number(scan.length_m ?? 4);
  const h = Number(scan.height_m ?? 2.6);

  return (
    <main className="min-h-screen bg-background pb-16">
      <header className="brand-bar safe-top sticky top-0 z-20 border-b">
        <div className="mx-auto flex min-h-[52px] w-full max-w-6xl items-center justify-between px-3 pb-3 pt-2 sm:px-6">
          <Link
            to="/"
            className="group flex shrink-0 items-center gap-1 text-[17px] font-medium tracking-tight text-foreground"
          >
            <ArrowLeft className="size-5 text-muted-foreground transition-colors group-hover:text-foreground" />
            <span className="text-muted-foreground transition-colors group-hover:text-foreground">
              Catalog
            </span>
          </Link>
          <h1 className="min-w-0 flex-1 truncate pr-2 text-right text-[17px] font-semibold tracking-tight sm:pr-3">
            {scan.name}
          </h1>
          <DeleteSpaceDialog
            scanId={id}
            scanName={scan.name}
            onDeleted={() => navigate({ to: "/" })}
            trigger={
              <Button
                variant="ghost"
                size="icon"
                aria-label="Delete this space"
                title="Delete this space"
                className="size-9 shrink-0 rounded-full text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              >
                <Trash2 className="size-4" />
              </Button>
            }
          />
        </div>
      </header>

      {scan.status !== "ready" && (
        <div className="mx-auto w-full max-w-6xl px-4 pt-4 sm:px-6">
          <div className="flex flex-col gap-3 surface-card p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <div className="text-sm font-semibold">
                {scan.status === "failed" || staleProcessing
                  ? "Reconstruction failed"
                  : scan.status === "processing"
                    ? "Reconstructing space"
                    : "Not reconstructed yet"}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {scan.status === "processing" && !staleProcessing
                  ? `${analysis.progress ? `${analysis.progress.message} (${analysis.progress.pct}%). ` : ""}Analyzing the captured frames. This page updates when the reconstruction is ready, and you can leave it meanwhile.`
                  : (analysisNotes.error ??
                    "The captured frames and acoustics are still stored. Run the reconstruction again.")}
              </p>
            </div>
            <Button
              size="sm"
              disabled={reanalyzing || (scan.status === "processing" && !staleProcessing)}
              onClick={() => void analysis.start()}
            >
              <RefreshCw className={`mr-1 size-4 ${reanalyzing ? "animate-spin" : ""}`} />
              {reanalyzing || (scan.status === "processing" && !staleProcessing)
                ? "Analyzing…"
                : "Run analysis again"}
            </Button>
          </div>
        </div>
      )}

      {stationHealth.length > 0 && (
        <div className="mx-auto w-full max-w-6xl px-4 pt-4 sm:px-6">
          <div className="surface-card p-4">
            <h2 className="mb-3 text-xs uppercase tracking-[0.2em] text-muted-foreground">
              Capture check
            </h2>
            <StationHealthMap
              stations={stationHealth}
              widthM={scan.width_m}
              lengthM={scan.length_m}
              onReshoot={(station) =>
                navigate({ to: "/capture", search: { reshoot: id, station } })
              }
              reshootDisabledReason={
                scan.status === "processing" && !staleProcessing
                  ? "Reshoot is available once the reconstruction finishes."
                  : null
              }
            />
          </div>
        </div>
      )}

      <div
        className={`mx-auto grid w-full max-w-6xl gap-6 px-4 py-6 sm:px-6 ${showDetails ? "lg:grid-cols-[minmax(0,1fr)_320px]" : "lg:grid-cols-1"}`}
      >
        <div className="min-w-0 space-y-4">
          <Tabs value={activeTab} onValueChange={setActiveTab} defaultValue="plan">
            <TabsList className="h-11 w-full rounded-full bg-secondary p-1 sm:h-10 sm:w-auto">
              <TabsTrigger
                value="plan"
                className="flex-1 rounded-full text-[13px] sm:flex-none sm:text-[14px]"
              >
                2D
              </TabsTrigger>
              <TabsTrigger
                value="walk"
                className="flex-1 rounded-full text-[13px] sm:flex-none sm:text-[14px]"
              >
                3D
              </TabsTrigger>
              <TabsTrigger
                value="cloud"
                className="flex-1 rounded-full text-[13px] sm:flex-none sm:text-[14px]"
              >
                Cloud
              </TabsTrigger>
              <TabsTrigger
                value="map"
                className="flex-1 rounded-full text-[13px] sm:flex-none sm:text-[14px]"
              >
                Map
              </TabsTrigger>
              <TabsTrigger
                value="frames"
                className="flex-1 rounded-full text-[13px] sm:flex-none sm:text-[14px]"
              >
                Frames
              </TabsTrigger>
              <TabsTrigger
                value="data"
                className="flex-1 rounded-full text-[13px] sm:flex-none sm:text-[14px]"
              >
                Data
              </TabsTrigger>
            </TabsList>

            <TabsContent value="plan" className="mt-3">
              <div className="surface-card p-2 sm:p-4">
                <FloorPlan2D
                  width={w}
                  length={l}
                  objects={objects}
                  portals={portals}
                  exportMeta={{
                    spaceName: scan.name,
                    width_m: w,
                    length_m: l,
                    address: scan.site_address,
                    createdAt: scan.created_at,
                  }}
                />
              </div>
            </TabsContent>

            <TabsContent value="walk" className="mt-3">
              <div className="overflow-hidden surface-card">
                <ClientOnly fallback={<div className="h-[60vh]" />}>
                  <Suspense fallback={<div className="h-[60vh]" />}>
                    <RoomViewer3D
                      width={w}
                      length={l}
                      height={h}
                      objects={objects}
                      portals={portals}
                      surfaces={surfaces}
                    />
                  </Suspense>
                </ClientOnly>
              </div>
            </TabsContent>

            <TabsContent value="cloud" className="mt-3">
              <div className="overflow-hidden surface-card">
                <ClientOnly fallback={<div className="h-[60vh]" />}>
                  <Suspense fallback={<div className="h-[60vh]" />}>
                    <PointCloudViewer
                      width={w}
                      length={l}
                      height={h}
                      objects={objects}
                      portals={portals}
                      surfaces={surfaces}
                      onStats={setCloudStats}
                    />
                  </Suspense>
                </ClientOnly>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Stat label="Points" value={cloudStats ? cloudStats.total.toLocaleString() : "-"} />
                <Stat
                  label="Structure pts"
                  value={cloudStats ? cloudStats.structure.toLocaleString() : "-"}
                />
                <Stat
                  label="Object pts"
                  value={cloudStats ? cloudStats.objects.toLocaleString() : "-"}
                />
                <Stat
                  label="Sample density"
                  value={cloudStats ? `${cloudStats.density}/m²` : "-"}
                />
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Stat label="Volume" value={`${(w * l * h).toFixed(1)} m³`} />
                <Stat label="Footprint" value={`${(w * l).toFixed(1)} m²`} />
                <Stat label="Objects" value={String(objects.length)} />
                <Stat label="Portals" value={String(portals.length)} />
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                Cloud is resampled from the reconstructed geometry - walls, floor and ceiling
                (portal openings cut out), portal rims, and object shells colored by category and
                surface reflectivity. Export as .ply for use in other point-cloud tools.
              </p>
            </TabsContent>

            <TabsContent value="map" className="mt-3">
              <MapTab scanId={id} scanName={scan.name} />
            </TabsContent>

            <TabsContent value="frames" className="mt-3">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs text-muted-foreground">
                  {photos.length} frame{photos.length === 1 ? "" : "s"} stored. Remove any frame
                  yourself, or let the privacy screen remove frames showing a person in the room.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={purging}
                  onClick={async () => {
                    setPurging(true);
                    try {
                      // Queued; the result is reported when the sweep lands (above).
                      const res = await spaces.requestPrivacyPurge(id);
                      sweepRequested.current = res.requestedAt;
                      toast.info("Screening every frame for people…");
                      await queryClient.invalidateQueries({ queryKey: ["space", id] });
                    } catch (err) {
                      setPurging(false);
                      toast.error(err instanceof ApiError ? err.message : "Privacy sweep failed");
                    }
                  }}
                >
                  <ShieldAlert className={`mr-1 size-4 ${purging ? "animate-pulse" : ""}`} />
                  {purging ? "Screening…" : "Purge frames with people"}
                </Button>
              </div>
              {(removals.frames.length > 0 || removals.unrecorded.length > 0) && (
                <details className="mb-3 rounded-md border border-border px-3 py-2 text-xs text-muted-foreground">
                  <summary className="cursor-pointer select-none">
                    {[
                      removals.people
                        ? `${removals.people} frame${removals.people === 1 ? "" : "s"} removed for privacy (a person in view)`
                        : null,
                      removals.manual ? `${removals.manual} deleted by you` : null,
                      removals.unrecorded.length
                        ? `${removals.unrecorded.length} removed earlier without a record`
                        : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </summary>
                  <ul className="mt-2 space-y-1">
                    {removals.frames.map((f, i) => (
                      <li key={`${f.at}-${f.idx ?? i}`}>
                        Frame {f.idx ?? "?"}
                        {f.heading_deg == null ? "" : ` · ${Math.round(f.heading_deg)}°`}
                        {f.station == null ? "" : ` · ${stationLabel(f.station)}`} —{" "}
                        {f.reason === "people"
                          ? `a person in view, removed ${f.source === "analysis" ? "after the analysis" : "by the privacy sweep"}`
                          : "deleted by you"}
                        , {new Date(f.at).toLocaleString()}
                      </li>
                    ))}
                    {removals.unrecorded.length > 0 && (
                      <li>
                        Frame{removals.unrecorded.length === 1 ? "" : "s"}{" "}
                        {removals.unrecorded.join(", ")} — removed before removals were recorded
                        (most likely by the privacy screen).
                      </li>
                    )}
                  </ul>
                </details>
              )}
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {photos.map((p) => (
                  <figure
                    key={p.id}
                    className="relative overflow-hidden rounded border border-border"
                  >
                    {p.url && (
                      <img
                        src={p.url}
                        alt={`Captured frame facing ${p.heading_deg == null ? "unknown heading" : `${Math.round(Number(p.heading_deg))} degrees`}`}
                        className="aspect-[3/4] w-full object-cover"
                        loading="lazy"
                      />
                    )}
                    <Button
                      variant="secondary"
                      size="icon"
                      aria-label="Delete this frame"
                      className="absolute right-1 top-1 size-7 opacity-90"
                      onClick={async () => {
                        try {
                          await spaces.removePhoto(id, p.id);
                          await queryClient.invalidateQueries({ queryKey: ["space", id] });
                          toast.success("Frame deleted");
                        } catch (err) {
                          toast.error(
                            err instanceof Error ? err.message : "Could not delete frame",
                          );
                        }
                      }}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                    <figcaption className="tabular px-2 py-1 text-[10px] text-muted-foreground">
                      {p.heading_deg == null ? "-" : `${Math.round(Number(p.heading_deg))}°`} ·{" "}
                      {p.captured_at ? new Date(p.captured_at).toLocaleTimeString() : ""}
                    </figcaption>
                  </figure>
                ))}
              </div>
            </TabsContent>

            <TabsContent value="data" className="mt-3">
              <DataTab
                scanId={id}
                scanName={scan.name}
                reRunAction={
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={reanalyzing}
                    className="press h-9 rounded-full px-3"
                    onClick={() => void analysis.start()}
                  >
                    <RefreshCw className={`mr-1 size-4 ${reanalyzing ? "animate-spin" : ""}`} />
                    {reanalyzing ? "Analyzing…" : "Re-run"}
                  </Button>
                }
                deleteAction={
                  <DeleteSpaceDialog
                    scanId={id}
                    scanName={scan.name}
                    onDeleted={() => navigate({ to: "/" })}
                    trigger={
                      <Button
                        variant="outline"
                        size="sm"
                        aria-label="Delete this space"
                        title="Delete this space"
                        className="press h-9 rounded-full border-destructive/50 px-3 text-destructive hover:bg-destructive/10 hover:text-destructive"
                      >
                        <Trash2 className="mr-1 size-4" /> Delete
                      </Button>
                    }
                  />
                }
              />
            </TabsContent>
          </Tabs>

          {showDetails && (
            <section className="surface-card p-4">
              <h2 className="mb-3 text-xs uppercase tracking-[0.2em] text-muted-foreground">
                Detected objects
              </h2>
              <ul className="grid gap-2 sm:grid-cols-2">
                {objects.map((o) => (
                  // Focusable so a tap on touch screens expands a truncated
                  // name; `title` covers mouse hover.
                  <li
                    key={o.id}
                    tabIndex={0}
                    className="group flex items-start justify-between gap-2 rounded border border-border px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span
                      title={o.label}
                      className="min-w-0 truncate group-focus:whitespace-normal group-focus:break-words"
                    >
                      {o.label}
                    </span>
                    <span className="tabular shrink-0 pt-[3px] text-[11px] text-muted-foreground">
                      {o.category ?? "object"} · {Math.round(Number(o.confidence ?? 0) * 100)}%
                    </span>
                  </li>
                ))}
                {objects.length === 0 && (
                  <li className="text-sm text-muted-foreground">No objects detected.</li>
                )}
              </ul>
            </section>
          )}
        </div>

        {showDetails && (
          <aside className="space-y-4 lg:sticky lg:top-20 lg:self-start">
            {scan.ai_summary && (
              <div className="surface-card p-4">
                <h2 className="mb-3 text-xs uppercase tracking-[0.2em] text-muted-foreground">
                  Description
                </h2>
                <p className="text-sm leading-relaxed">{scan.ai_summary}</p>
              </div>
            )}

            <div className="flex items-center justify-between px-1">
              <span className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
                Shell
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Stat label="Width" value={`${w.toFixed(2)} m`} />
              <Stat label="Length" value={`${l.toFixed(2)} m`} />
              <Stat label="Height" value={`${h.toFixed(2)} m`} />
              <Stat
                label="Floor area"
                value={`${Number(scan.floor_area_m2 ?? w * l).toFixed(1)} m²`}
              />
            </div>

            {scan.scale_reference && (
              <p className="px-1 text-xs leading-relaxed text-muted-foreground">
                Scale: {String(scan.scale_reference)}
              </p>
            )}

            <div className="surface-card p-4">
              <h2 className="mb-3 text-xs uppercase tracking-[0.2em] text-muted-foreground">
                Acoustic Data
              </h2>
              <div className="grid grid-cols-2 gap-2">
                <Stat label="RT60" value={ac["rt60_s"] ? `${String(ac["rt60_s"])} s` : "-"} />
                <Stat label="Character" value={ac["hardness"] ? String(ac["hardness"]) : "-"} />
              </div>
              {ac["rt60_s"] == null ? (
                <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                  No acoustic probe was recorded for this space. Capture it again with sound enabled
                  to measure RT60, surface hardness and the acoustic volume cross-check.
                </p>
              ) : (
                Number(ac["rt60_s"]) <= 0.2 && (
                  <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                    Measured RT60 of {String(ac["rt60_s"])} s is below the plausible floor for a
                    room this size - the decay likely fell into the noise floor. Treat it as an
                    estimate and re-probe in a quieter moment for a reliable figure.
                  </p>
                )
              )}
            </div>

            <div className="surface-card p-4">
              <h2 className="mb-3 text-xs uppercase tracking-[0.2em] text-muted-foreground">
                Surfaces
              </h2>
              <ul className="space-y-2 text-sm">
                {surfaces.map((s) => (
                  <li key={s.id} className="flex items-start justify-between gap-2">
                    <span className="capitalize">{s.name || s.kind}</span>
                    <span className="tabular text-right text-[11px] text-muted-foreground">
                      {s.material ?? "-"}
                      <br />α {Number(s.absorption ?? 0).toFixed(2)}
                    </span>
                  </li>
                ))}
                {surfaces.length === 0 && (
                  <li className="text-muted-foreground">No surfaces classified.</li>
                )}
              </ul>
            </div>

            <div className="surface-card p-4">
              <h2 className="mb-3 text-xs uppercase tracking-[0.2em] text-muted-foreground">
                Portals
              </h2>
              <ul className="space-y-2 text-sm">
                {portals.map((p) => (
                  <li
                    key={p.id}
                    className="flex items-center justify-between gap-2 rounded border border-border px-3 py-2"
                  >
                    <span className="capitalize">{p.kind}</span>
                    <span className="tabular shrink-0 text-[11px] text-muted-foreground">
                      {p.wall} · {Number(p.width_m ?? 0).toFixed(2)}m
                    </span>
                  </li>
                ))}
                {portals.length === 0 && (
                  <li className="text-muted-foreground">No portals found.</li>
                )}
              </ul>
            </div>
          </aside>
        )}
      </div>
    </main>
  );
}
