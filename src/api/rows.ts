// Row shapes the API returns for a space (GET /v1/scans/:id). The API keeps
// the database column names and the JSON Supabase used to return, so these
// match the generated Supabase row types the components were written
// against. Geometry columns arrive as GeoJSON (or null).
import type { ScanDetailResponse } from "@spatial/contracts";

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type Geometry = { type: string; [key: string]: unknown } | null;

export interface ScanRow {
  id: string;
  user_id: string;
  name: string;
  notes: string | null;
  status: string;
  acoustics: Json;
  ai_summary: string | null;
  analysis_notes: Json;
  capture_id: string | null;
  created_at: string;
  updated_at: string;
  depth_metrics: Json;
  depth_path: string | null;
  depth_provided: boolean;
  depth_source: string | null;
  dimension_confidence: Json;
  floor_area_m2: number | null;
  width_m: number | null;
  length_m: number | null;
  height_m: number | null;
  volume_m3: number | null;
  footprint: Geometry;
  lod_level: number;
  model_version: string | null;
  prompt_version: string | null;
  provider: string | null;
  north_offset_deg: number | null;
  scale_reference: string | null;
  site_address: string | null;
  site_location: Geometry;
}

export interface ObjectRow {
  id: string;
  scan_id: string;
  user_id: string;
  label: string;
  category: string | null;
  confidence: number | null;
  x_m: number | null;
  y_m: number | null;
  width_m: number | null;
  depth_m: number | null;
  height_m: number | null;
  attributes: Json;
  metadata: Json;
  footprint: Geometry;
  centroid: Geometry;
  created_at: string;
}

export interface PortalRow {
  id: string;
  scan_id: string;
  user_id: string;
  kind: string;
  wall: string;
  offset_m: number | null;
  width_m: number | null;
  height_m: number | null;
  sill_m: number | null;
  confidence: number | null;
  notes: string | null;
  attributes: Json;
  line: Geometry;
  created_at: string;
}

export interface SurfaceRow {
  id: string;
  scan_id: string;
  user_id: string;
  name: string;
  kind: string | null;
  material: string | null;
  area_m2: number | null;
  absorption: number | null;
  reflectivity: number | null;
  color_hex: string | null;
  notes: string | null;
  band_absorption: Json;
  plane: Geometry;
  created_at: string;
}

export interface PhotoRow {
  id: string;
  scan_id: string;
  user_id: string;
  storage_path: string;
  thumbnail_path: string | null;
  idx: number;
  heading_deg: number | null;
  pitch_deg: number | null;
  captured_at: string;
  created_at: string;
  sensor_payload: Json;
  camera_pose: Geometry;
  view_cone: Geometry;
  /** Read URL (SAS), valid for `urlExpiresInSec` of the response. */
  url: string | null;
  thumbnail_url: string | null;
}

export interface SpaceDetail {
  scan: ScanRow;
  objects: ObjectRow[];
  portals: PortalRow[];
  surfaces: SurfaceRow[];
  photos: PhotoRow[];
  urlExpiresInSec: number;
}

/** The detail response with its rows typed. The contract types them loosely, on purpose. */
export const asSpaceDetail = (response: ScanDetailResponse) => response as unknown as SpaceDetail;
