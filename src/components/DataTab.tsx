import { useEffect, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { useSpaceExport } from "@/api/queries";
import { Button } from "@/components/ui/button";
import { Copy, Download } from "lucide-react";

type Format = "geojson" | "postgis" | "layers" | "imdf" | "usd";

const FORMATS: { id: Format; label: string; hint: string; ext: string }[] = [
  { id: "geojson", label: "GeoJSON", hint: "FeatureCollection · RFC 7946 shape", ext: "geojson" },
  { id: "postgis", label: "PostGIS rows", hint: "Raw table rows with WKT geometry", ext: "json" },
  { id: "layers", label: "L0–L5 layers", hint: "Layered capture bundle", ext: "json" },
  {
    id: "imdf",
    label: "IMDF",
    hint: "Apple Indoor Mapping Data Format · WGS84 GeoJSON archive (.zip)",
    ext: "zip",
  },
  {
    id: "usd",
    label: "OpenUSD",
    hint: "Universal Scene Description · .usda preview + .usdz archive",
    ext: "usda",
  },
];

function slug(s: string) {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "space"
  );
}

/** Minimal JSON syntax highlighter — returns HTML-safe spans. */
function highlight(json: string) {
  return json
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(
      /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g,
      (match) => {
        let cls = "text-emerald-700";
        if (/^"/.test(match)) cls = /:$/.test(match) ? "text-sky-700" : "text-amber-700";
        else if (/true|false/.test(match)) cls = "text-fuchsia-700";
        else if (/null/.test(match)) cls = "text-muted-foreground";
        return `<span class="${cls}">${match}</span>`;
      },
    );
}

export function DataTab({
  scanId,
  scanName,
  reRunAction,
  deleteAction,
}: {
  scanId: string;
  scanName: string;
  reRunAction?: ReactNode;
  deleteAction?: ReactNode;
}) {
  const [format, setFormat] = useState<Format>("geojson");
  const [imdfFile, setImdfFile] = useState("manifest.json");

  const { data, isLoading, error } = useSpaceExport(scanId);

  const imdf = data?.imdf;
  const usd = data?.usd;

  useEffect(() => {
    if (imdf && !imdf.files[imdfFile]) setImdfFile("manifest.json");
  }, [imdf, imdfFile]);

  const active = FORMATS.find((f) => f.id === format)!;

  const payload = useMemo(() => {
    if (!data) return null;
    if (format === "geojson") return data.geojson;
    if (format === "postgis") return data.postgis;
    if (format === "imdf") return data.imdf?.files[imdfFile] ?? null;
    if (format === "usd") return data.usd?.usda ?? null;
    return data.layers;
  }, [data, format, imdfFile]);

  const text = useMemo(() => {
    if (!payload) return "";
    if (format === "usd") return String(payload);
    return JSON.stringify(payload, null, 2);
  }, [payload, format]);

  const stats = useMemo(() => {
    if (!data) return null;
    const features = (data.geojson?.["features"] as unknown[] | undefined) ?? [];
    const levels = new Set(
      ((data.layers?.layers as { level?: number }[] | undefined) ?? []).map((l) => l.level),
    );
    const withGeom = features.filter((f) => (f as { geometry?: unknown }).geometry != null).length;
    return {
      features: features.length,
      withGeom,
      levels: [...levels]
        .sort()
        .map((l) => `L${l}`)
        .join(" "),
    };
  }, [data]);

  const baseName = `${slug(scanName)}-${new Date().toISOString().slice(0, 10)}`;

  const saveBlob = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const download = async (target: "imdf" | "usda" | "usdz") => {
    if (target === "imdf") {
      if (!imdf) return;
      const { zipSync, strToU8 } = await import("fflate");
      const entries: Record<string, Uint8Array> = {};
      for (const [name, content] of Object.entries(imdf.files)) {
        entries[name] = strToU8(JSON.stringify(content, null, 2));
      }
      const zipped = zipSync(entries, { level: 6 });
      saveBlob(
        new Blob([zipped as unknown as BlobPart], { type: "application/zip" }),
        `${baseName}-imdf.zip`,
      );
      return;
    }

    if (target === "usda") {
      if (!usd) return;
      saveBlob(new Blob([usd.usda], { type: "text/plain" }), `${baseName}.usda`);
      return;
    }

    if (target === "usdz") {
      if (!usd) return;
      const { zipSync, strToU8 } = await import("fflate");
      const entries: Record<string, Uint8Array> = {
        "scene.usda": strToU8(usd.usda),
      };
      // USDZ uses store compression (level 0) so the archive can be memory-mapped.
      const zipped = zipSync(entries, { level: 0 });
      saveBlob(
        new Blob([zipped as unknown as BlobPart], { type: "application/vnd.pixar.usdz+zip" }),
        `${baseName}.usdz`,
      );
      return;
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Copied to clipboard");
    } catch {
      toast.error("Clipboard unavailable");
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="grid w-full grid-cols-6 gap-1 surface-card p-1">
          {[
            { id: "geojson", label: "GeoJSON" },
            { id: "postgis", label: "PostGIS" },
          ].map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setFormat(f.id as Format)}
              className={`col-span-3 tabular min-h-9 rounded-full px-3 text-xs uppercase tracking-wide transition-colors ${
                format === f.id
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted"
              }`}
            >
              {f.label}
            </button>
          ))}
          {[
            { id: "layers", label: "Layers" },
            { id: "imdf", label: "IMDF" },
            { id: "usd", label: "OpenUSD" },
          ].map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setFormat(f.id as Format)}
              className={`col-span-2 tabular min-h-9 rounded-full px-3 text-xs uppercase tracking-wide transition-colors ${
                format === f.id
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        <div className="mt-3 flex w-full items-center gap-2 border-t border-border/40 pt-3">
          <div className="flex flex-1 items-center">{reRunAction}</div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="press h-9 rounded-full"
              onClick={copy}
              disabled={!text}
            >
              <Copy className="mr-1 size-4" /> Copy
            </Button>
            {format === "usd" ? (
              <>
                <Button
                  size="sm"
                  className="press h-9 rounded-full"
                  onClick={() => download("usda")}
                  disabled={!usd}
                >
                  <Download className="mr-1 size-4" /> USDA
                </Button>
                <Button
                  size="sm"
                  className="press h-9 rounded-full"
                  onClick={() => download("usdz")}
                  disabled={!usd}
                >
                  <Download className="mr-1 size-4" /> USDZ
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                className="press h-9 rounded-full"
                onClick={() => download(format === "imdf" ? "imdf" : "usda")}
                disabled={format === "imdf" ? !imdf : !text}
              >
                <Download className="mr-1 size-4" /> Export
              </Button>
            )}
          </div>
        </div>
      </div>

      <p className="truncate whitespace-nowrap text-xs text-muted-foreground">{active.hint}</p>

      {format === "imdf" && imdf && (
        <div className="surface-card flex items-center gap-1 overflow-hidden px-3 py-2 text-xs">
          <span className="shrink-0 text-muted-foreground">Address:</span>
          <span className="truncate whitespace-nowrap font-medium text-foreground">
            {imdf.address
              ? imdf.address
              : imdf.georeferenced
                ? `${imdf.origin!.lat.toFixed(5)}, ${imdf.origin!.lon.toFixed(5)}`
                : "Unknown (no site location captured)"}
          </span>
        </div>
      )}

      {format === "imdf" && imdf && !imdf.georeferenced && (
        <p className="rounded border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          Not georeferenced. This space has no site location, so coordinates are placed at a neutral
          origin. Set a site location for a valid IMDF archive.
        </p>
      )}

      {format === "usd" && usd && !usd.hasShell && (
        <p className="rounded border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          No room shell reconstructed. The USD scene contains only object boxes.
        </p>
      )}

      {format === "imdf" && imdf && (
        <div className="flex flex-wrap gap-1">
          {imdf.index.map((f) => (
            <button
              key={f.file}
              type="button"
              onClick={() => setImdfFile(f.file)}
              className={`tabular rounded border px-2 py-1 text-[11px] transition-colors ${
                imdfFile === f.file
                  ? "border-primary bg-primary/10 text-foreground"
                  : "border-border text-muted-foreground hover:bg-muted"
              }`}
            >
              {f.file}
              {f.file.endsWith(".geojson") && (
                <span className="ml-1 text-muted-foreground">· {f.features}</span>
              )}
            </button>
          ))}
        </div>
      )}

      {stats && format !== "imdf" && format !== "usd" && (
        <dl className="tabular grid grid-cols-2 gap-2 sm:grid-cols-4">
          {[
            ["Features", String(stats.features)],
            ["With geometry", String(stats.withGeom)],
            ["Layers", stats.levels || "-"],
            ["CRS", "local m · EPSG:4326"],
          ].map(([k, v]) => (
            <div key={k} className="surface-card px-3 py-2">
              <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">{k}</dt>
              <dd className="mt-0.5 text-xs">{v}</dd>
            </div>
          ))}
        </dl>
      )}

      {format === "imdf" && imdf && (
        <dl className="tabular grid grid-cols-2 gap-2 sm:grid-cols-4">
          {[
            ["Files", String(imdf.index.length)],
            ["Features", String(imdf.index.reduce((sum, f) => sum + f.features, 0))],
            [
              "Origin",
              imdf.origin ? `${imdf.origin.lat.toFixed(5)}, ${imdf.origin.lon.toFixed(5)}` : "none",
            ],
            ["North offset", `${Math.round(imdf.north_offset_deg)}°`],
          ].map(([k, v]) => (
            <div key={k} className="surface-card px-3 py-2">
              <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">{k}</dt>
              <dd className="mt-0.5 text-xs">{v}</dd>
            </div>
          ))}
        </dl>
      )}

      {format === "usd" && usd && (
        <dl className="tabular grid grid-cols-2 gap-2 sm:grid-cols-4">
          {[
            ["Shell prims", String(usd.prims.shell)],
            ["Objects", String(usd.prims.objects)],
            ["Openings", String(usd.prims.openings)],
            ["Materials", String(usd.prims.materials)],
          ].map(([k, v]) => (
            <div key={k} className="surface-card px-3 py-2">
              <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">{k}</dt>
              <dd className="mt-0.5 text-xs">{v}</dd>
            </div>
          ))}
        </dl>
      )}

      <div className="overflow-hidden surface-card">
        {isLoading && <p className="p-6 text-sm text-muted-foreground">Building export…</p>}
        {error && (
          <p className="p-6 text-sm text-destructive">
            {error instanceof Error ? error.message : "Could not build export"}
          </p>
        )}
        {!isLoading && !error && (
          <pre
            className="max-h-[60vh] overflow-auto p-4 text-[11px] leading-relaxed"
            dangerouslySetInnerHTML={{
              __html:
                format === "usd"
                  ? text.replace(/</g, "&lt;").replace(/>/g, "&gt;")
                  : highlight(text),
            }}
          />
        )}
      </div>

      {deleteAction && (
        <div
          className="flex justify-end pt-6"
          style={{ paddingBottom: "max(env(safe-area-inset-bottom, 0px), 2.5rem)" }}
        >
          {deleteAction}
        </div>
      )}
    </div>
  );
}
