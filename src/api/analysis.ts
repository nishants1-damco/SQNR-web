// Running an analysis (plan §9, §13.2), replacing `runAnalysisResilient`. The
// request no longer stays open for the whole run: POST queues it, then the
// run is followed over the event stream, with polling as the fallback when
// the stream can't be opened or drops (mobile networks, proxies).
//
// Following ends at the run's own deadline (`deadlineAt`, sized by the server
// to the provider) plus a grace period, the same rule the space page uses.
import type {
  AnalysisEvent,
  AnalysisProvider,
  AnalysisStatusResponse,
  StartAnalysisResponse,
} from "@spatial/contracts";
import { LOCAL_ANALYSIS_DEADLINE_MS } from "@spatial/domain/analysis-deadline";
import type { ApiClient } from "./client";

/** Grace period past the server's deadline before the client gives up. */
const DEADLINE_GRACE_MS = 60_000;
const POLL_MS = 5_000;

export interface SseMessage {
  event: string;
  data: string;
}

/** Server-sent events from a fetch response body. */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseMessage> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let end: number;
      while ((end = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        let event = "message";
        const data: string[] = [];
        for (const line of block.split("\n")) {
          if (line.startsWith(":")) continue; // heartbeat
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
        }
        if (data.length) yield { event, data: data.join("\n") };
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export interface FollowOptions {
  signal?: AbortSignal;
  onProgress?: (event: Pick<AnalysisEvent, "stage" | "pct" | "message">) => void;
  /** Called once when following falls back to polling. */
  onWaiting?: () => void;
  pollMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });

export class AnalysisFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnalysisFailedError";
  }
}

type Outcome = "ready" | "failed" | "open";

function settle(status: AnalysisStatusResponse): Outcome {
  if (status.scanStatus === "ready") return "ready";
  if (status.scanStatus === "failed") return "failed";
  return "open";
}

/** Resolves when the scan's run is done; rejects with AnalysisFailedError when it fails. */
export async function followAnalysis(
  client: ApiClient,
  scanId: string,
  options: FollowOptions = {},
): Promise<void> {
  const sleep = options.sleep ?? defaultSleep;
  let deadline = Date.now() + LOCAL_ANALYSIS_DEADLINE_MS;
  const note = (status: AnalysisStatusResponse) => {
    if (status.deadlineAt) deadline = Date.parse(status.deadlineAt) + DEADLINE_GRACE_MS;
  };
  const failed = (status: AnalysisStatusResponse) =>
    new AnalysisFailedError(status.error ?? "Analysis failed");

  // 1. The event stream.
  try {
    const res = await client.stream(`/v1/scans/${scanId}/analysis/events`, options.signal);
    if (res.body) {
      for await (const message of readSse(res.body)) {
        const data = JSON.parse(message.data) as Record<string, unknown>;
        if (message.event === "status") {
          const status = data as unknown as AnalysisStatusResponse;
          note(status);
          const outcome = settle(status);
          if (outcome === "ready") return;
          if (outcome === "failed") throw failed(status);
        } else if (message.event === "progress") {
          const event = data as unknown as AnalysisEvent;
          options.onProgress?.(event);
          if (event.stage === "done" || event.stage === "failed") break;
        }
      }
      // The server ends the stream itself; when we stop early, close it.
      await res.body.cancel().catch(() => undefined);
    }
  } catch (err) {
    if (err instanceof AnalysisFailedError) throw err;
    if ((err as { name?: string }).name === "AbortError") throw err;
    // Couldn't open or lost the stream: poll instead.
  }

  // 2. Polling: confirms the final state after the stream, or replaces it.
  let waited = false;
  for (;;) {
    const status = await client.request<AnalysisStatusResponse>(
      "GET",
      `/v1/scans/${scanId}/analysis`,
      options.signal ? { signal: options.signal } : {},
    );
    note(status);
    const outcome = settle(status);
    if (outcome === "ready") return;
    if (outcome === "failed") throw failed(status);
    if (Date.now() > deadline) {
      throw new AnalysisFailedError(
        "Analysis did not finish in time. Retry it from the space page.",
      );
    }
    if (!waited) {
      waited = true;
      options.onWaiting?.();
    }
    if (status.stage && typeof status.progressPct === "number") {
      options.onProgress?.({
        stage: status.stage as AnalysisEvent["stage"],
        pct: status.progressPct,
        message: status.stage,
      });
    }
    await sleep(options.pollMs ?? POLL_MS, options.signal);
  }
}

export interface RunOptions extends FollowOptions {
  captureId?: string;
  provider?: AnalysisProvider;
}

/**
 * Queues an analysis and follows it to the end. A run already in progress is
 * followed instead of starting another. When the capture id already belongs
 * to another space, resolves with that space's id without analysing.
 */
export async function runAnalysis(
  client: ApiClient,
  scanId: string,
  options: RunOptions = {},
): Promise<{ scanId: string; outcome: StartAnalysisResponse["outcome"] }> {
  const started = await client.request<StartAnalysisResponse>(
    "POST",
    `/v1/scans/${scanId}/analysis`,
    {
      body: {
        ...(options.captureId ? { captureId: options.captureId } : {}),
        ...(options.provider ? { provider: options.provider } : {}),
      },
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );
  if (started.outcome === "duplicate") return { scanId: started.scanId, outcome: "duplicate" };
  await followAnalysis(client, scanId, options);
  return { scanId, outcome: started.outcome };
}
