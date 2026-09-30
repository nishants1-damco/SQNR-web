// End-to-end smoke test in a real browser against a running stack (plan §17,
// phase 4 exit): sign up → capture data → analysis → catalog → space page
// (plan, frames, export) → session survives a reload → delete → sign out.
//
//   pnpm dev            (this app, with the API proxied to :3000)
//   + the platform's API and worker running (pnpm dev in the platform repo)
//   pnpm e2e
//
// The capture step calls the same modules the capture page uses (create,
// direct-to-Blob upload, analysis) from inside the page: a headless browser
// has no compass or motion sensors to walk the capture wizard with. Against a
// production build (`pnpm preview`), where the source modules aren't served,
// it makes the same API calls from Node instead.
//
// Env: E2E_BASE_URL (default http://localhost:5173), E2E_BROWSER (a Chrome or
// Edge executable; default: the usual install paths), E2E_HEADED=1.
import { existsSync } from "node:fs";
import jpeg from "jpeg-js";
import { chromium } from "playwright-core";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:5173";
const browserPath =
  process.env.E2E_BROWSER ??
  [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "/usr/bin/google-chrome",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].find((p) => existsSync(p));
if (!browserPath) throw new Error("No Chrome or Edge found; set E2E_BROWSER");

const browser = await chromium.launch({
  executablePath: browserPath,
  headless: process.env.E2E_HEADED !== "1",
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
});
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
const problems = [];
page.on("pageerror", (err) => problems.push(`page error: ${err.message}`));
page.on("console", (msg) => {
  // Signed-out refreshes answer 401 by design; the browser logs them.
  if (msg.type() === "error" && !/status of 401/.test(msg.text())) {
    problems.push(`console: ${msg.text()}`);
  }
});

let failed = false;
async function step(name, run) {
  const started = Date.now();
  try {
    await run();
    console.log(`  ok    ${name} (${Date.now() - started} ms)`);
  } catch (err) {
    failed = true;
    console.log(`  FAIL  ${name}: ${err instanceof Error ? err.message : String(err)}`);
    const text = await page
      .locator("body")
      .innerText()
      .catch(() => "");
    console.log(`        at ${page.url()}, page shows: ${text.replace(/\s+/g, " ").slice(0, 400)}`);
    await page.screenshot({ path: "e2e-failure.png" }).catch(() => undefined);
    throw err;
  }
}

const email = `e2e-${Date.now()}@example.test`;
let spaceId = null;
let spaceName = null;

try {
  await step("signed-out visitors land on sign-in", async () => {
    await page.goto(BASE);
    await page.waitForURL(/\/auth$/);
  });

  await step("sign up signs straight in to an empty catalog", async () => {
    await page.getByRole("button", { name: "No account? Sign up" }).click();
    await page.fill("#email", email);
    await page.fill("#password", "e2e-password-123");
    await page.getByRole("button", { name: "Create account" }).click();
    await page.waitForURL(`${BASE}/`);
    await page.getByText("No spaces captured yet.").waitFor();
  });

  await step("capture: create, upload frames to Blob Storage, analyse", async () => {
    const devServer = await page.evaluate(async () => {
      const res = await fetch("/src/api/client.ts");
      return /javascript/.test(res.headers.get("content-type") ?? "");
    });
    const result = devServer ? await captureInPage() : await captureFromNode();
    spaceId = result.id;
    if (result.frames !== 4) throw new Error(`uploaded ${result.frames} frames`);
    if (result.error) throw new Error(`analysis failed: ${result.error}`);
    console.log(`        ${devServer ? "in the page" : "from Node"}: ${result.stages.join(" → ")}`);
  });

  async function captureInPage() {
    return page.evaluate(async () => {
      const { api } = await import("/src/api/client.ts");
      const { spaces } = await import("/src/api/spaces.ts");
      const { uploadToScan } = await import("/src/api/uploads.ts");
      const { runAnalysis } = await import("/src/api/analysis.ts");
      const frame = async (hue) => {
        const canvas = new OffscreenCanvas(640, 480);
        const g = canvas.getContext("2d");
        g.fillStyle = `hsl(${hue} 60% 50%)`;
        g.fillRect(0, 0, 640, 480);
        g.fillStyle = "#fff";
        g.fillRect(100 + hue / 2, 100, 120, 200);
        return canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 });
      };
      const created = await spaces.create({
        captureId: crypto.randomUUID(),
        name: "E2E room",
        acoustics: {},
        analysisNotes: { capture_mode: "manual", stations: 1 },
      });
      const id = created.scan.id;
      const uploads = [];
      for (let i = 0; i < 4; i++) {
        uploads.push({
          kind: "frame",
          blob: await frame(i * 90),
          headingDeg: i * 90,
          capturedAt: new Date().toISOString(),
          sensorPayload: {},
        });
      }
      const uploaded = await uploadToScan(api, id, uploads);
      const stages = [];
      let error = null;
      try {
        await runAnalysis(api, id, { onProgress: (p) => stages.push(p.stage) });
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
      return { id, frames: uploaded.photos.length, stages, error };
    });
  }

  async function captureFromNode() {
    const call = async (method, path, token, body) => {
      const res = await fetch(`${BASE}${path}`, {
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
      return res.status === 204 ? null : res.json();
    };
    const { accessToken: token } = await call("POST", "/v1/auth/sign-in", null, {
      email,
      password: "e2e-password-123",
    });
    const { scan } = await call("POST", "/v1/scans", token, {
      captureId: crypto.randomUUID(),
      name: "E2E room",
      acoustics: {},
      analysisNotes: { capture_mode: "manual", stations: 1 },
    });
    const frames = [0, 90, 180, 270].map((hue) => {
      const data = new Uint8Array(640 * 480 * 4).fill(60 + hue / 2);
      return new Uint8Array(jpeg.encode({ width: 640, height: 480, data }, 85).data);
    });
    const session = await call("POST", `/v1/scans/${scan.id}/uploads`, token, {
      files: frames.map((f) => ({ kind: "frame", contentType: "image/jpeg", sizeBytes: f.length })),
    });
    for (const file of session.files) {
      const res = await fetch(file.upload.url, {
        method: "PUT",
        headers: file.upload.headers,
        body: frames[file.index],
      });
      if (!res.ok) throw new Error(`PUT frame ${file.index}: ${res.status}`);
    }
    const done = await call(
      "POST",
      `/v1/scans/${scan.id}/uploads/${session.sessionId}/complete`,
      token,
      { frames: frames.map((_, i) => ({ fileIndex: i, headingDeg: i * 90, sensorPayload: {} })) },
    );
    await call("POST", `/v1/scans/${scan.id}/analysis`, token, {});
    const stages = [];
    for (let i = 0; i < 120; i++) {
      const status = await call("GET", `/v1/scans/${scan.id}/analysis`, token);
      if (status.stage && stages.at(-1) !== status.stage) stages.push(status.stage);
      if (status.scanStatus === "ready") break;
      if (status.scanStatus === "failed") {
        return { id: scan.id, frames: done.photos.length, stages, error: status.error };
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return { id: scan.id, frames: done.photos.length, stages, error: null };
  }

  await step("the catalog shows the reconstructed space", async () => {
    await page.goto(BASE);
    const card = page.locator(`a[href="/space/${spaceId}"]`);
    await card.waitFor();
    spaceName = (await card.locator("h3").innerText()).trim();
    await card.getByText("ready").waitFor();
  });

  await step("the space page shows the plan, objects and shell", async () => {
    await page.locator(`a[href="/space/${spaceId}"]`).click();
    await page.waitForURL(`${BASE}/space/${spaceId}`);
    await page.getByRole("heading", { name: spaceName }).waitFor();
    await page.getByText("Detected objects").waitFor();
    await page.getByText("Width").first().waitFor();
  });

  await step("frames load from Blob Storage through read URLs", async () => {
    await page.getByRole("tab", { name: "Frames" }).click();
    const images = page.locator("figure img");
    await images.first().waitFor();
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll("figure img")].length === 4 &&
        [...document.querySelectorAll("figure img")].every(
          (img) => img.complete && img.naturalWidth > 0,
        ),
      null,
      { timeout: 15_000 },
    );
  });

  await step("the export loads (GeoJSON, IMDF, USD)", async () => {
    await page.getByRole("tab", { name: "Data" }).click();
    await page.getByText("FeatureCollection").first().waitFor({ timeout: 15_000 });
  });

  await step("re-running from the space page follows the run to the end", async () => {
    await page.getByRole("button", { name: "Re-run" }).click();
    await page.getByText("Reconstruction complete").waitFor({ timeout: 60_000 });
  });

  await step("the privacy sweep screens every frame and reports back", async () => {
    await page.getByRole("tab", { name: "Frames" }).click();
    await page.getByRole("button", { name: "Purge frames with people" }).click();
    await page.getByText(/Screened 4 frames: no people in the room/).waitFor({ timeout: 60_000 });
  });

  await step("a reload keeps the session (refresh cookie)", async () => {
    await page.reload();
    await page.getByRole("heading", { name: spaceName }).waitFor();
    if (page.url().includes("/auth")) throw new Error("signed out by a reload");
  });

  await step("deleting a frame removes it", async () => {
    await page.getByRole("tab", { name: "Frames" }).click();
    await page.getByRole("button", { name: "Delete this frame" }).first().click();
    await page.getByText("Frame deleted").waitFor();
    await page.waitForFunction(() => document.querySelectorAll("figure img").length === 3);
  });

  await step("deleting the space returns to an empty catalog", async () => {
    await page.getByRole("button", { name: "Delete this space" }).first().click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
    await page.waitForURL(`${BASE}/`);
    await page.getByText("No spaces captured yet.").waitFor();
  });

  await step("the capture page opens", async () => {
    await page.goto(`${BASE}/capture`);
    await page.waitForLoadState("networkidle");
    if (page.url().includes("/auth")) throw new Error("redirected to sign-in");
  });

  await step("sign out returns to sign-in", async () => {
    await page.goto(BASE);
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Sign out" }).click();
    await page.waitForURL(/\/auth$/);
    await page.reload();
    await page.waitForURL(/\/auth$/);
  });
} catch {
  // reported by step()
} finally {
  if (problems.length) {
    console.log("Browser errors:");
    for (const p of problems) console.log(`  - ${p}`);
  }
  await browser.close();
}
process.exit(failed || problems.length ? 1 : 0);
