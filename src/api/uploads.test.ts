import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "./client";
import { type FrameUpload, uploadToScan } from "./uploads";

const frame = (bytes = 10): FrameUpload => ({
  kind: "frame",
  blob: new Blob([new Uint8Array(bytes)], { type: "image/jpeg" }),
  headingDeg: 0,
  sensorPayload: { station: 1 },
});

/** An API that issues one URL per file and records every completion. */
function fakeClient() {
  const completions: { url: string; body: Record<string, unknown> }[] = [];
  const sessions: number[] = [];
  const request = vi.fn(
    async (method: string, url: string, options: { body?: Record<string, unknown> }) => {
      if (url.endsWith("/uploads")) {
        const files = (options.body?.["files"] as unknown[]) ?? [];
        sessions.push(files.length);
        return {
          sessionId: `s${sessions.length}`,
          expiresAt: "2030-01-01T00:00:00Z",
          files: files.map((_, index) => ({
            index,
            kind: "frame",
            key: `k/${sessions.length}/${index}`,
            upload: {
              url: `https://blob.test/${sessions.length}/${index}`,
              method: "PUT",
              headers: {},
            },
          })),
        };
      }
      completions.push({ url, body: options.body ?? {} });
      const frames = (options.body?.["frames"] as { fileIndex: number }[]) ?? [];
      return {
        photos: frames.map((f) => ({ id: `p${f.fileIndex}`, idx: f.fileIndex, storage_path: "x" })),
        replaced: options.body?.["replaceStations"] ? 2 : 0,
        depth_path: null,
      };
    },
  );
  return { client: { request } as unknown as ApiClient, completions, sessions };
}

const noSleep = () => Promise.resolve();

describe("uploadToScan", () => {
  it("PUTs every file, at most four at a time, then completes with the frame metadata", async () => {
    const { client, completions } = fakeClient();
    let inFlight = 0;
    let peak = 0;
    const fetchImpl = vi.fn(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return new Response(null, { status: 201 });
    }) as unknown as typeof fetch;
    const progress: number[] = [];
    const result = await uploadToScan(
      client,
      "scan-1",
      Array.from({ length: 10 }, () => frame()),
      {
        fetchImpl,
        onProgress: (f) => progress.push(f),
      },
    );
    expect(fetchImpl).toHaveBeenCalledTimes(10);
    expect(peak).toBe(4);
    expect(result.photos).toHaveLength(10);
    expect(progress.at(0)).toBe(0);
    expect(progress.at(-1)).toBe(1);
    expect(completions[0]?.body["frames"]).toContainEqual({
      fileIndex: 3,
      headingDeg: 0,
      sensorPayload: { station: 1 },
    });
  });

  it("retries a failed PUT, and counts a 409 (the blob is already there) as done", async () => {
    const { client } = fakeClient();
    const statuses = [503, 409];
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: statuses.shift() ?? 201 }),
    ) as unknown as typeof fetch;
    await uploadToScan(client, "scan-1", [frame()], { fetchImpl, sleep: noSleep });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("gives up at once on a rejected upload URL", async () => {
    const { client, completions } = fakeClient();
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 403 }),
    ) as unknown as typeof fetch;
    await expect(
      uploadToScan(client, "scan-1", [frame()], { fetchImpl, sleep: noSleep }),
    ).rejects.toMatchObject({ status: 403 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(completions).toHaveLength(0);
  });

  it("splits large captures into sessions and replaces viewpoints only in the last one", async () => {
    const { client, completions, sessions } = fakeClient();
    const fetchImpl = (async () => new Response(null, { status: 201 })) as unknown as typeof fetch;
    const result = await uploadToScan(
      client,
      "scan-1",
      Array.from({ length: 250 }, () => frame(1)),
      { fetchImpl, replaceStations: [1, 2] },
    );
    expect(sessions).toEqual([200, 50]);
    expect(completions.map((c) => c.body["replaceStations"])).toEqual([undefined, [1, 2]]);
    expect(result.replaced).toBe(2);
    expect(result.photos).toHaveLength(250);
  });

  it("sends the depth file as the session's depth file", async () => {
    const { client, completions } = fakeClient();
    const fetchImpl = (async () => new Response(null, { status: 201 })) as unknown as typeof fetch;
    await uploadToScan(
      client,
      "scan-1",
      [frame(), { kind: "depth", blob: new Blob([new Uint8Array(3)]), fileName: "room.ply" }],
      { fetchImpl },
    );
    expect(completions[0]?.body["depthFileIndex"]).toBe(1);
    expect(completions[0]?.body["frames"]).toHaveLength(1);
  });
});
