// A space's analysis, for pages (plan §13.2): follows a run in progress over
// the event stream (polling as the fallback), and starts a new one. The run
// happens in the worker, so leaving the page never interrupts it; following
// just refreshes the page when it ends.
import type { AnalysisEvent } from "@spatial/contracts";
import { isAnalysisStale } from "@spatial/domain/analysis-deadline";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { AnalysisFailedError, followAnalysis } from "./analysis";
import { api, ApiError } from "./client";

type Progress = Pick<AnalysisEvent, "stage" | "pct" | "message">;

export function useAnalysisRun(
  scanId: string,
  scan: { status: string; analysis_notes?: unknown; created_at?: string | null } | undefined,
) {
  const queryClient = useQueryClient();
  const [progress, setProgress] = useState<Progress | null>(null);
  const [starting, setStarting] = useState(false);
  const processing = !!scan && scan.status === "processing" && !isAnalysisStale(scan);

  const refresh = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["space", scanId] }),
      queryClient.invalidateQueries({ queryKey: ["spaces"] }),
      queryClient.invalidateQueries({ queryKey: ["space-export", scanId] }),
    ]);
  }, [queryClient, scanId]);

  useEffect(() => {
    if (!processing) {
      setProgress(null);
      return;
    }
    const controller = new AbortController();
    followAnalysis(api, scanId, { signal: controller.signal, onProgress: setProgress })
      .then(() => toast.success("Reconstruction complete"))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        toast.error(
          err instanceof AnalysisFailedError ? err.message : "Lost track of the analysis",
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) void refresh();
      });
    return () => controller.abort();
  }, [processing, scanId, refresh]);

  /** Queues a new run; the page then follows it. */
  const start = useCallback(async () => {
    setStarting(true);
    try {
      await api.request("POST", `/v1/scans/${scanId}/analysis`, { body: {} });
      await refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not start the analysis");
    } finally {
      setStarting(false);
    }
  }, [scanId, refresh]);

  return { processing, progress, starting, start };
}
