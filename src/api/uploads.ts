// Frames and depth files go straight to Blob Storage (plan §5.2, §13.2):
// ask the API for create-only upload URLs, PUT the bytes, then `complete`,
// which checks each blob and records the frames in one transaction.
//
// PUTs run a few at a time with retries. An upload URL can only create its
// blob, so when a retry finds the blob already there (409), the earlier
// attempt succeeded and its response was lost: that counts as done.
import {
  type CompleteUploadRequest,
  type CompleteUploadResponse,
  MAX_FILES_PER_UPLOAD,
  type UploadSessionResponse,
} from "@spatial/contracts";
import { ApiError, type ApiClient } from "./client";

export interface FrameUpload {
  kind: "frame";
  blob: Blob;
  headingDeg: number | null;
  pitchDeg?: number | null;
  capturedAt?: string;
  sensorPayload?: Record<string, unknown>;
}

export interface DepthUpload {
  kind: "depth";
  blob: Blob;
  fileName: string;
}

export interface UploadOptions {
  /** Reshoot: remove the scan's other frames from these viewpoints once the new ones are saved. */
  replaceStations?: number[];
  /** Fraction done, 0..1, by bytes. */
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
  /** PUTs in flight at once. */
  concurrency?: number;
  /** Attempts per PUT. */
  attempts?: number;
  fetchImpl?: typeof fetch;
  /** Waits between retries; replaceable in tests. */
  sleep?: (ms: number) => Promise<void>;
}

export interface UploadResult {
  photos: CompleteUploadResponse["photos"];
  replaced: number;
  depthPath: string | null;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function putWithRetry(
  file: UploadSessionResponse["files"][number],
  blob: Blob,
  options: UploadOptions,
): Promise<void> {
  const attempts = options.attempts ?? 4;
  const sleep = options.sleep ?? defaultSleep;
  const doFetch = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await doFetch(file.upload.url, {
        method: "PUT",
        headers: file.upload.headers,
        body: blob,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      // 409: the blob exists, so an earlier attempt of this PUT got through
      // (`complete` still checks its size and type).
      if (res.ok || res.status === 409) return;
      // Expired or rejected URLs won't work on a retry either.
      if (res.status === 403 || res.status === 400) {
        throw new ApiError(res.status, "invalid_request", `Upload rejected (${res.status})`);
      }
      lastError = new ApiError(res.status, "service_unavailable", `Upload failed (${res.status})`);
    } catch (err) {
      if ((err as { name?: string }).name === "AbortError") throw err;
      if (err instanceof ApiError) throw err;
      lastError = err;
    }
    if (attempt < attempts) await sleep(500 * 2 ** (attempt - 1));
  }
  throw lastError instanceof Error ? lastError : new Error("Upload failed");
}

async function runPool<T>(items: T[], limit: number, work: (item: T) => Promise<void>) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await work(items[next++] as T);
  });
  await Promise.all(workers);
}

const contentTypeOf = (upload: FrameUpload | DepthUpload) =>
  upload.kind === "frame"
    ? upload.blob.type || "image/jpeg"
    : upload.blob.type || "application/octet-stream";

/**
 * Uploads frames (and at most one depth file) to a space. Large captures go
 * in several sessions of up to 200 files; `replaceStations` applies to the
 * last one, so old viewpoint frames are removed only after every new frame
 * is saved.
 */
export async function uploadToScan(
  client: ApiClient,
  scanId: string,
  uploads: (FrameUpload | DepthUpload)[],
  options: UploadOptions = {},
): Promise<UploadResult> {
  const totalBytes = uploads.reduce((sum, u) => sum + u.blob.size, 0) || 1;
  let doneBytes = 0;
  options.onProgress?.(0);

  const chunks: (FrameUpload | DepthUpload)[][] = [];
  for (let i = 0; i < uploads.length; i += MAX_FILES_PER_UPLOAD) {
    chunks.push(uploads.slice(i, i + MAX_FILES_PER_UPLOAD));
  }
  const result: UploadResult = { photos: [], replaced: 0, depthPath: null };

  for (const [chunkIndex, chunk] of chunks.entries()) {
    const session = await client.request<UploadSessionResponse>(
      "POST",
      `/v1/scans/${scanId}/uploads`,
      {
        body: {
          files: chunk.map((u) =>
            u.kind === "frame"
              ? { kind: "frame", contentType: contentTypeOf(u), sizeBytes: u.blob.size }
              : {
                  kind: "depth",
                  contentType: contentTypeOf(u),
                  sizeBytes: u.blob.size,
                  fileName: u.fileName,
                },
          ),
        },
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );

    await runPool(session.files, options.concurrency ?? 4, async (file) => {
      const upload = chunk[file.index];
      if (!upload) throw new Error(`Upload session returned an unknown file ${file.index}`);
      await putWithRetry(file, upload.blob, options);
      doneBytes += upload.blob.size;
      options.onProgress?.(Math.min(1, doneBytes / totalBytes));
    });

    const frames: CompleteUploadRequest["frames"] = [];
    let depthFileIndex: number | undefined;
    chunk.forEach((u, index) => {
      if (u.kind === "depth") {
        depthFileIndex = index;
        return;
      }
      frames.push({
        fileIndex: index,
        headingDeg: u.headingDeg,
        ...(u.pitchDeg === undefined ? {} : { pitchDeg: u.pitchDeg }),
        ...(u.capturedAt ? { capturedAt: u.capturedAt } : {}),
        sensorPayload: u.sensorPayload ?? {},
      });
    });
    const last = chunkIndex === chunks.length - 1;
    const completed = await client.request<CompleteUploadResponse>(
      "POST",
      `/v1/scans/${scanId}/uploads/${session.sessionId}/complete`,
      {
        body: {
          frames,
          ...(depthFileIndex === undefined ? {} : { depthFileIndex }),
          ...(last && options.replaceStations?.length
            ? { replaceStations: options.replaceStations }
            : {}),
        },
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );
    result.photos.push(...completed.photos);
    result.replaced += completed.replaced;
    result.depthPath = completed.depth_path ?? result.depthPath;
  }
  options.onProgress?.(1);
  return result;
}
