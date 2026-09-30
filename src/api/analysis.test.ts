import { describe, expect, it, vi } from "vitest";
import { AnalysisFailedError, followAnalysis, readSse, runAnalysis } from "./analysis";
import type { ApiClient } from "./client";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of it) out.push(item);
  return out;
}

const status = (scanStatus: string, extra: Record<string, unknown> = {}) => ({
  scanId: "s1",
  scanStatus,
  stage: null,
  progressPct: null,
  deadlineAt: null,
  error: null,
  run: null,
  ...extra,
});

const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

function fakeClient(options: {
  stream?: () => Promise<Response>;
  statuses?: unknown[];
  start?: unknown;
}) {
  const statuses = [...(options.statuses ?? [])];
  const request = vi.fn(async (method: string) => {
    if (method === "POST") return options.start;
    return statuses.length > 1 ? statuses.shift() : statuses[0];
  });
  const client = {
    request,
    stream: vi.fn(options.stream ?? (() => Promise.reject(new Error("no stream")))),
  } as unknown as ApiClient;
  return { client, request };
}

const noSleep = () => Promise.resolve();

describe("readSse", () => {
  it("parses events split across chunks and skips heartbeats", async () => {
    const messages = await collect(
      readSse(streamOf(["event: status\nda", 'ta: {"a":1}\n\n: ping\n\n', "data: x\ndata: y\n\n"])),
    );
    expect(messages).toEqual([
      { event: "status", data: '{"a":1}' },
      { event: "message", data: "x\ny" },
    ]);
  });
});

describe("followAnalysis", () => {
  it("follows the stream to `done`, then confirms the result", async () => {
    const progress: string[] = [];
    const { client, request } = fakeClient({
      stream: async () =>
        new Response(
          streamOf([
            sse("status", status("processing")),
            sse("progress", { stage: "pass1", pct: 55, message: "Reconstructing" }),
            sse("progress", { stage: "done", pct: 100, message: "Done" }),
          ]),
        ),
      statuses: [status("ready")],
    });
    await followAnalysis(client, "s1", { onProgress: (p) => progress.push(p.stage) });
    expect(progress).toEqual(["pass1", "done"]);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("returns at once when the snapshot says the scan is ready", async () => {
    const { client, request } = fakeClient({
      stream: async () => new Response(streamOf([sse("status", status("ready"))])),
    });
    await followAnalysis(client, "s1");
    expect(request).not.toHaveBeenCalled();
  });

  it("falls back to polling when the stream can't be opened", async () => {
    const onWaiting = vi.fn();
    const { client, request } = fakeClient({
      statuses: [status("processing"), status("processing"), status("ready")],
    });
    await followAnalysis(client, "s1", { sleep: noSleep, onWaiting });
    expect(request).toHaveBeenCalledTimes(3);
    expect(onWaiting).toHaveBeenCalledTimes(1);
  });

  it("rejects with the server's error when the run fails", async () => {
    const { client } = fakeClient({
      statuses: [status("failed", { error: "AI request rejected: check your API key." })],
    });
    await expect(followAnalysis(client, "s1", { sleep: noSleep })).rejects.toEqual(
      new AnalysisFailedError("AI request rejected: check your API key."),
    );
  });

  it("gives up after the run's deadline", async () => {
    const { client } = fakeClient({
      statuses: [status("processing", { deadlineAt: "2000-01-01T00:00:00Z" })],
    });
    await expect(followAnalysis(client, "s1", { sleep: noSleep })).rejects.toThrow(
      /did not finish in time/,
    );
  });
});

describe("runAnalysis", () => {
  it("doesn't follow anything when the capture belongs to another space", async () => {
    const { client } = fakeClient({
      start: {
        outcome: "duplicate",
        scanId: "other",
        analysisId: null,
        provider: null,
        model: null,
      },
    });
    expect(await runAnalysis(client, "s1", { captureId: "c" })).toEqual({
      scanId: "other",
      outcome: "duplicate",
    });
  });
});
