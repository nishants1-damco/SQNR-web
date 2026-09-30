import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSpaceExport } from "@/api/queries";
import { spaces } from "@/api/spaces";
import { Button } from "@/components/ui/button";
import { Crosshair, ExternalLink, MapPin, Minus, Plus } from "lucide-react";

/** Approximate half-span in degrees for a given zoom-ish radius in meters. */
function bbox(lat: number, lon: number, radiusM: number) {
  const dLat = radiusM / 111_320;
  const dLon = radiusM / Math.max(111_320 * Math.cos((lat * Math.PI) / 180), 1e-6);
  return [lon - dLon, lat - dLat, lon + dLon, lat + dLat].map((n) => n.toFixed(6)).join("%2C");
}

export function MapTab({ scanId, scanName }: { scanId: string; scanName: string }) {
  const DEFAULT_RADIUS_M = 1600; // ≈ 1 mile across, comfortable street context
  const [radius, setRadius] = useState(DEFAULT_RADIUS_M);

  const { data, isLoading, error } = useSpaceExport(scanId);

  const imdf = data?.imdf;
  const gpsOrigin = imdf?.origin ?? null;
  const address = imdf?.address ?? null;

  // The raw GPS fix drifts indoors; when we have a resolved street address we
  // pin the map on the geocoded building instead.
  const { data: addressPoint } = useQuery<{ lat: number; lon: number } | null>({
    queryKey: ["address-point", address],
    enabled: Boolean(address),
    staleTime: 24 * 60 * 60 * 1000,
    queryFn: () => spaces.geocode(address as string),
  });

  const origin = addressPoint ?? gpsOrigin;
  const pinnedToAddress = Boolean(addressPoint);

  const src = useMemo(() => {
    if (!origin) return null;
    return `https://www.openstreetmap.org/export/embed.html?bbox=${bbox(
      origin.lat,
      origin.lon,
      radius,
    )}&layer=mapnik&marker=${origin.lat}%2C${origin.lon}`;
  }, [origin, radius]);

  if (isLoading) {
    return <p className="p-6 text-sm text-muted-foreground">Loading location…</p>;
  }
  if (error) {
    return <p className="p-6 text-sm text-destructive">Could not load location.</p>;
  }

  return (
    <div className="overflow-hidden rounded-3xl border bg-card">
      {!origin ? (
        <div className="flex flex-col items-center gap-2 px-6 py-16 text-center">
          <MapPin className="size-6 text-muted-foreground" />
          <p className="text-sm font-medium">No location on this space</p>
          <p className="max-w-sm text-xs text-muted-foreground">
            This scan was captured without geolocation permission, so there is no capture point to
            plot. New captures record latitude and longitude automatically.
          </p>
        </div>
      ) : (
        <>
          <div className="relative">
            <iframe
              key={src ?? ""}
              title={`Capture location of ${scanName}`}
              src={src ?? ""}
              className="block h-[320px] w-full border-0 sm:h-[440px]"
              loading="lazy"
            />
            {/* The marker is rendered by the map itself, so it stays pinned to
                the real coordinates while panning and zooming. */}

            <button
              type="button"
              aria-label="Recenter on capture point"
              className="press absolute left-3 top-3 flex h-9 items-center gap-1 rounded-full border bg-background/85 px-3 text-xs font-medium backdrop-blur"
              onClick={() => setRadius(DEFAULT_RADIUS_M)}
            >
              <Crosshair className="size-4" /> Recenter
            </button>
            <div className="absolute right-3 top-3 flex flex-col overflow-hidden rounded-full border bg-background/85 backdrop-blur">
              <button
                type="button"
                aria-label="Zoom in"
                className="press flex size-9 items-center justify-center text-foreground"
                onClick={() => setRadius((r) => Math.max(60, Math.round(r / 2)))}
              >
                <Plus className="size-4" />
              </button>
              <button
                type="button"
                aria-label="Zoom out"
                className="press flex size-9 items-center justify-center border-t text-foreground"
                onClick={() => setRadius((r) => Math.min(80_000, r * 2))}
              >
                <Minus className="size-4" />
              </button>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3">
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">
                {imdf?.address ?? "Address not resolved"}
              </div>
              <div className="tabular mt-0.5 text-[11px] text-muted-foreground">
                {origin.lat.toFixed(6)}, {origin.lon.toFixed(6)} · WGS84 ·{" "}
                {pinnedToAddress ? "pinned to address" : "GPS fix"} · view radius ≈{" "}
                {radius >= 1000 ? `${(radius / 1000).toFixed(1)} km` : `${radius} m`}
              </div>
            </div>
            <Button asChild variant="outline" size="sm" className="press h-9 rounded-full px-3">
              <a
                href={`https://www.openstreetmap.org/?mlat=${origin.lat}&mlon=${origin.lon}#map=18/${origin.lat}/${origin.lon}`}
                target="_blank"
                rel="noreferrer"
              >
                <ExternalLink className="mr-1 size-4" /> Open map
              </a>
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
