// Typed calls for the spaces endpoints. Each replaces a Supabase query or a
// TanStack Start server function the original app used (plan §7.3).
import type {
  AddressResponseSchema,
  CaptureConsentInput,
  CreateScanRequest,
  FlagsResponse,
  GeocodeResponseSchema,
  PrivacyPurgeResponse,
  ScanDetailResponse,
  ScanListQuery,
  ScanListResponse,
  ScanResponse,
  UpdateScanRequest,
} from "@spatial/contracts";
import type { z } from "zod";
import { api, type ApiClient } from "./client";
import { asSpaceDetail, type Json, type SpaceDetail } from "./rows";

export interface SpatialLayerBundle {
  ontology: Json;
  crs: { local: string; site: string };
  scan_id: string;
  room_name: string | null;
  generated_at: string;
  level_count: number;
  layers: Json[];
}

/** GET /v1/scans/:id/export (was the `exportScanData` server function). */
export interface ScanExportPayload {
  geojson: { [key: string]: Json };
  postgis: { [key: string]: Json };
  layers: SpatialLayerBundle;
  imdf: import("@spatial/domain/imdf").ImdfArchive;
  usd: import("@spatial/domain/usd").UsdArchive;
}

export function spacesApi(client: ApiClient = api) {
  return {
    list: (query: Partial<ScanListQuery>, signal?: AbortSignal) =>
      client.request<ScanListResponse>("GET", "/v1/scans", {
        query: query as Record<string, string | number | undefined>,
        ...(signal ? { signal } : {}),
      }),

    /** One request for the scan and all its rows, frames with read URLs (was 5 reads). */
    get: async (id: string, signal?: AbortSignal): Promise<SpaceDetail> =>
      asSpaceDetail(
        await client.request<ScanDetailResponse>("GET", `/v1/scans/${id}`, {
          ...(signal ? { signal } : {}),
        }),
      ),

    /** Idempotent per capture id: repeating one returns the same space. */
    create: (body: CreateScanRequest) =>
      client.request<ScanResponse>("POST", "/v1/scans", { body }),

    update: (id: string, body: UpdateScanRequest) =>
      client.request<ScanResponse>("PATCH", `/v1/scans/${id}`, { body }),

    remove: (id: string) => client.request<void>("DELETE", `/v1/scans/${id}`),

    removePhoto: (scanId: string, photoId: string) =>
      client.request<void>("DELETE", `/v1/scans/${scanId}/photos/${photoId}`),

    requestPrivacyPurge: (id: string) =>
      client.request<PrivacyPurgeResponse>("POST", `/v1/scans/${id}/privacy-purge`),

    export: (id: string) => client.request<ScanExportPayload>("GET", `/v1/scans/${id}/export`),

    resolveAddress: (id: string, lat: number, lon: number) =>
      client.request<z.infer<typeof AddressResponseSchema>>("POST", `/v1/scans/${id}/address`, {
        body: { lat, lon },
      }),

    geocode: async (address: string) =>
      (
        await client.request<z.infer<typeof GeocodeResponseSchema>>("GET", "/v1/geocode", {
          query: { address },
        })
      ).result,

    recordConsent: (input: CaptureConsentInput) =>
      client.request<{ ok: true }>("POST", "/v1/consents", { body: input }),

    flags: () => client.request<FlagsResponse>("GET", "/v1/flags"),
  };
}

export const spaces = spacesApi();
