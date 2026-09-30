/**
 * Persists in-progress capture wizard state to IndexedDB so a phone call,
 * accidental tab close, or battery-triggered kill doesn't destroy a session.
 *
 * Only lightweight metadata is stored — the raw shot buffer (video frames,
 * audio) can be hundreds of MB and IndexedDB writes for that size would
 * stall the main thread mid-capture. The draft persists just enough to
 * restore step, name, mode, notes, geo anchor, station index, and a summary
 * of captured shots so the user knows what still needs re-shooting.
 *
 * Storage: IndexedDB (falls back to localStorage). Keyed by user id.
 */
import { logger, errString } from "@/lib/logger";

const DB_NAME = "sqnr-capture-drafts";
const STORE = "drafts";
const DB_VERSION = 1;
/** Drafts older than this are considered stale and won't be offered on resume. */
export const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

export interface CaptureDraft {
  userId: string;
  updatedAt: number;
  /** Wizard step index. */
  step: number;
  mode: "auto" | "manual";
  name: string;
  notes: string;
  station: number;
  shotsCount: number;
  hasGeo: boolean;
  hasAcoustics: boolean;
  /**
   * Stable capture-session id. Persisted so that a page reload before
   * submit reuses the same id, and so the eventual server call is
   * idempotent under retries. See src/lib/capture-id.ts.
   */
  captureId?: string;
  /**
   * Storage keys for any large blobs (photos, acoustics recording) that
   * were queued offline and still need to be uploaded. Empty when
   * everything has been flushed.
   */
  pendingBlobRefs?: string[];
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "userId" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function fallbackKey(userId: string) {
  return `sqnr:capture-draft:${userId}`;
}

/** Best-effort write. Failures are logged but never thrown — capture must never stall. */
export async function saveCaptureDraft(draft: CaptureDraft): Promise<void> {
  try {
    if (typeof indexedDB === "undefined") throw new Error("no indexedDB");
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(draft);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (err) {
    // localStorage isn't ideal for larger payloads, but our draft is small
    // (< 1KB) and this path only runs when IndexedDB is unavailable.
    try {
      localStorage.setItem(fallbackKey(draft.userId), JSON.stringify(draft));
    } catch {
      logger.warn("capture-draft", "save failed on both storages", { err: errString(err) });
    }
  }
}

export async function loadCaptureDraft(userId: string): Promise<CaptureDraft | null> {
  try {
    if (typeof indexedDB === "undefined") throw new Error("no indexedDB");
    const db = await openDb();
    const draft = await new Promise<CaptureDraft | null>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(userId);
      req.onsuccess = () => resolve((req.result as CaptureDraft | undefined) ?? null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    if (!draft) return null;
    if (Date.now() - draft.updatedAt > DRAFT_TTL_MS) return null;
    return draft;
  } catch {
    try {
      const raw = localStorage.getItem(fallbackKey(userId));
      if (!raw) return null;
      const draft = JSON.parse(raw) as CaptureDraft;
      if (Date.now() - draft.updatedAt > DRAFT_TTL_MS) return null;
      return draft;
    } catch {
      return null;
    }
  }
}

export async function clearCaptureDraft(userId: string): Promise<void> {
  try {
    if (typeof indexedDB === "undefined") throw new Error("no indexedDB");
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(userId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    try {
      localStorage.removeItem(fallbackKey(userId));
    } catch {
      /* ignore */
    }
  }
}
