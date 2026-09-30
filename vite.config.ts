// A static SPA (migration plan §13): TanStack Router's file-based routes,
// React and Tailwind. No SSR, no server functions: all data comes from the
// Spatial Capture API.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin } from "vite";

const origin = (url: string | undefined) => {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};

/**
 * Content-Security-Policy for the built app (plan §13.2). Development runs
 * without it, since Vite's dev server needs inline scripts and a websocket.
 *
 * `VITE_BLOB_ORIGIN` must be set for a build: frames are uploaded to and read
 * from the Blob endpoint directly (create-only and read SAS URLs), so it has
 * to be allowed for both `connect-src` and `img-src`.
 */
export function contentSecurityPolicy(
  env: Record<string, string>,
  options: { meta?: boolean } = {},
): string {
  const api = origin(env["VITE_API_BASE_URL"]);
  const blob = origin(env["VITE_BLOB_ORIGIN"]);
  const list = (...sources: (string | null)[]) => sources.filter(Boolean).join(" ");
  return [
    "default-src 'self'",
    "script-src 'self'",
    // Tailwind and Radix set inline styles at runtime.
    "style-src 'self' 'unsafe-inline'",
    // Frames and thumbnails come from the Blob endpoint; floor-plan exports are blob: URLs.
    `img-src ${list("'self'", "blob:", "data:", blob)}`,
    "media-src 'self' blob:",
    "font-src 'self' data:",
    `connect-src ${list("'self'", api, blob)}`,
    "worker-src 'self' blob:",
    // The Map tab embeds OpenStreetMap.
    "frame-src https://www.openstreetmap.org",
    // Only honoured as a header, so the meta tag leaves it out.
    options.meta ? null : "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ]
    .filter(Boolean)
    .join("; ");
}

/**
 * Puts the policy in index.html, and writes staticwebapp.config.json (Azure
 * Static Web Apps, plan §13.2) with the same policy as a header, SPA fallback
 * routing, and caching: hashed assets forever, index.html and the service
 * worker never.
 */
function csp(env: Record<string, string>): Plugin {
  return {
    name: "sqnr-csp",
    apply: "build",
    buildStart() {
      if (!origin(env["VITE_BLOB_ORIGIN"])) {
        this.warn(
          "VITE_BLOB_ORIGIN is not set: the Content-Security-Policy will block frame uploads and images",
        );
      }
    },
    transformIndexHtml: () => [
      {
        tag: "meta",
        attrs: {
          "http-equiv": "Content-Security-Policy",
          content: contentSecurityPolicy(env, { meta: true }),
        },
        injectTo: "head-prepend",
      },
    ],
    generateBundle() {
      const noCache = { "cache-control": "no-cache" };
      this.emitFile({
        type: "asset",
        fileName: "staticwebapp.config.json",
        source: `${JSON.stringify(
          {
            navigationFallback: {
              rewrite: "/index.html",
              exclude: ["/assets/*", "/*.{png,svg,ico,json,txt,js}"],
            },
            routes: [
              {
                route: "/assets/*",
                headers: { "cache-control": "public, max-age=31536000, immutable" },
              },
              { route: "/sw.js", headers: noCache },
              { route: "/index.html", headers: noCache },
            ],
            globalHeaders: {
              "content-security-policy": contentSecurityPolicy(env),
              "x-content-type-options": "nosniff",
              "referrer-policy": "strict-origin-when-cross-origin",
              "permissions-policy": "camera=(self), microphone=(self), geolocation=(self)",
            },
          },
          null,
          2,
        )}\n`,
      });
    },
  };
}

/** Stamps APP_VERSION (src/lib/version.ts) into index.html, e.g. the touch icon URL. */
function appVersion(): Plugin {
  const source = readFileSync(new URL("./src/lib/version.ts", import.meta.url), "utf8");
  const version = /APP_VERSION = "([^"]+)"/.exec(source)?.[1] ?? "dev";
  return {
    name: "sqnr-app-version",
    transformIndexHtml: (html) => html.replaceAll("__APP_VERSION__", version),
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiTarget = env["VITE_API_PROXY_TARGET"] ?? "http://localhost:3000";
  return {
    plugins: [
      // Must come before the React plugin.
      tanstackRouter({ target: "react", autoCodeSplitting: true }),
      react(),
      tailwindcss(),
      csp(env),
      appVersion(),
    ],
    resolve: {
      alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
    },
    server: {
      port: 5173,
      strictPort: true,
      // Same-origin API in development: the refresh cookie (path /v1/auth)
      // and SSE work exactly as they will behind Front Door.
      proxy: {
        "/v1": { target: apiTarget, changeOrigin: false },
        "/.well-known": { target: apiTarget },
      },
    },
    build: {
      target: "es2022",
      sourcemap: true,
      chunkSizeWarningLimit: 1200,
    },
  };
});
