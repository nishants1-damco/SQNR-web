/**
 * Print-to-PDF export for the 2D floor plan.
 *
 * Opens a scoped print window containing just the SVG plan plus a caption,
 * then invokes the browser's native print dialog. Users pick "Save as PDF"
 * from the destination dropdown to get a vector-quality file — no new
 * dependencies, no rasterization, no bundle cost.
 *
 * Called from a button inside `FloorPlan2D` so it has direct access to the
 * rendered SVG node.
 */
export interface FloorPlanExportMeta {
  spaceName: string;
  width_m: number;
  length_m: number;
  address?: string | null;
  createdAt?: string | null;
}

export function exportFloorPlanPdf(svgEl: SVGSVGElement | null, meta: FloorPlanExportMeta) {
  if (!svgEl) return;

  // Clone so mutations (adding xmlns for the standalone document) don't touch
  // the live DOM node. Both namespaces are required for a self-contained SVG.
  const clone = svgEl.cloneNode(true) as SVGSVGElement;
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("xmlns:xlink", "http://www.w3.org/1999/xlink");

  // Force size to fill the printable area; the viewBox already carries aspect.
  clone.removeAttribute("style");
  clone.setAttribute("width", "100%");
  clone.setAttribute("height", "100%");

  // The SVG fills/strokes reference Tailwind theme CSS variables
  // (`var(--primary)`, `var(--foreground)`, ...). The print window has none
  // of those declared, so every `var()` falls back to its initial value and
  // fill/stroke render as black. Snapshot the resolved values from the live
  // SVG and inject them into the print document's :root so colors survive.
  const themeVars = [
    "--primary",
    "--foreground",
    "--background",
    "--card",
    "--border",
    "--muted-foreground",
    "--muted",
  ];
  const cs = window.getComputedStyle(svgEl);
  const themeCss = themeVars
    .map((name) => {
      const value = cs.getPropertyValue(name).trim();
      return value ? `${name}: ${value};` : "";
    })
    .filter(Boolean)
    .join(" ");

  const svgMarkup = new XMLSerializer().serializeToString(clone);

  const date = meta.createdAt ? new Date(meta.createdAt) : new Date();
  const dateLabel = Number.isFinite(date.valueOf())
    ? date.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })
    : "";

  const safe = (s: string) =>
    s.replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c]!,
    );

  // Print stylesheet lifts the plan to full page and hides browser default
  // header/footer via @page; users still get "Save as PDF" as a destination.
  const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${safe(meta.spaceName)} · floor plan</title>
    <style>
      :root { ${themeCss} }
      * { box-sizing: border-box; }
      html, body { margin: 0; padding: 0; background: #fff; color: #111; font: 12pt/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
      @page { size: A4 landscape; margin: 14mm; }
      header { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 8mm; border-bottom: 0.5pt solid #ccc; padding-bottom: 4mm; }
      header h1 { font-size: 20pt; font-weight: 600; margin: 0; letter-spacing: -0.02em; }
      header .meta { font-size: 10pt; color: #555; text-align: right; }
      header .meta div + div { margin-top: 1mm; }
      .plan { width: 100%; height: calc(100vh - 40mm); display: flex; align-items: center; justify-content: center; }
      .plan svg { max-width: 100%; max-height: 100%; }
      footer { position: fixed; bottom: 6mm; left: 14mm; right: 14mm; font-size: 8pt; color: #888; display: flex; justify-content: space-between; }
      @media screen {
        body { padding: 20px; }
        .hint { position: fixed; top: 12px; right: 12px; background: #111; color: #fff; padding: 8px 12px; border-radius: 8px; font-size: 12pt; box-shadow: 0 4px 12px rgba(0,0,0,0.15); }
      }
      @media print {
        .hint { display: none; }
      }
    </style>
  </head>
  <body>
    <div class="hint">Choose <b>Save as PDF</b> in the destination.</div>
    <header>
      <h1>${safe(meta.spaceName)}</h1>
      <div class="meta">
        <div>${meta.width_m.toFixed(2)} m × ${meta.length_m.toFixed(2)} m &nbsp;·&nbsp; ${(meta.width_m * meta.length_m).toFixed(1)} m²</div>
        ${meta.address ? `<div>${safe(meta.address)}</div>` : ""}
        ${dateLabel ? `<div>${safe(dateLabel)}</div>` : ""}
      </div>
    </header>
    <div class="plan">${svgMarkup}</div>
    <footer>
      <span>SQNR floor plan export</span>
      <span>Not for construction use</span>
    </footer>
    <script>
      // Wait a tick so the SVG lays out before the print dialog opens.
      window.addEventListener("load", function () {
        setTimeout(function () { window.focus(); window.print(); }, 250);
      });
      // Close the tab after the print dialog resolves (Chrome fires afterprint
      // for both "Save" and "Cancel"). Users on Safari can just close the tab.
      window.addEventListener("afterprint", function () { window.close(); });
    </script>
  </body>
</html>`;

  const printWin = window.open("", "_blank", "width=1000,height=800");
  if (!printWin) {
    // Popup blocker got us — write the doc into the current tab as a fallback
    // so the user still gets a useful result.
    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    window.location.assign(url);
    return;
  }
  printWin.document.open();
  printWin.document.write(html);
  printWin.document.close();
}
