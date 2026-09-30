// The web app shares two packages with the platform repo (SQNR-new):
// @spatial/contracts (API wire schemas) and @spatial/domain (pure geometry and
// capture logic). They are vendored here, unchanged, under packages/. The
// platform repo is the source of truth: edit them there, then sync.
//
//   pnpm shared:sync    copy from ../spatial-capture-platform (or $SPATIAL_PLATFORM_DIR)
//   pnpm shared:check   fail if a vendored file was edited here (runs in CI)
//
// packages/shared.lock.json records the platform commit and a hash per file.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES = ["contracts", "domain"];
const lockPath = join(root, "packages", "shared.lock.json");

const isSource = (name) => name.endsWith(".ts") && !name.endsWith(".test.ts");

function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return files(path);
    return isSource(entry.name) ? [path] : [];
  });
}

const hash = (path) =>
  createHash("sha256")
    .update(readFileSync(path, "utf8").replace(/\r\n/g, "\n"))
    .digest("hex")
    .slice(0, 16);

function hashes() {
  const out = {};
  for (const pkg of PACKAGES) {
    for (const file of files(join(root, "packages", pkg, "src")).sort()) {
      out[relative(root, file).replaceAll("\\", "/")] = hash(file);
    }
  }
  return out;
}

function sync() {
  const platform = resolve(
    process.env.SPATIAL_PLATFORM_DIR ?? join(root, "..", "spatial-capture-platform"),
  );
  if (!existsSync(join(platform, "packages", "contracts"))) {
    throw new Error(`No platform checkout at ${platform}; set SPATIAL_PLATFORM_DIR`);
  }
  for (const pkg of PACKAGES) {
    const target = join(root, "packages", pkg, "src");
    rmSync(target, { recursive: true, force: true });
    cpSync(join(platform, "packages", pkg, "src"), target, {
      recursive: true,
      filter: (src) => !src.endsWith(".test.ts"),
    });
  }
  let commit = "unknown";
  try {
    commit = execFileSync("git", ["-C", platform, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
  } catch {
    // not a git checkout
  }
  writeFileSync(
    lockPath,
    `${JSON.stringify({ platformCommit: commit, files: hashes() }, null, 2)}\n`,
  );
  console.log(`synced @spatial/contracts and @spatial/domain from ${platform} (${commit})`);
}

function check() {
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  const now = hashes();
  const problems = [];
  for (const [file, digest] of Object.entries(lock.files)) {
    if (!(file in now)) problems.push(`missing: ${file}`);
    else if (now[file] !== digest) problems.push(`edited: ${file}`);
  }
  for (const file of Object.keys(now)) if (!(file in lock.files)) problems.push(`added: ${file}`);
  if (problems.length) {
    console.error(
      `Vendored shared packages differ from platform commit ${lock.platformCommit}:\n  ${problems.join("\n  ")}\n` +
        "Change them in the platform repo, then run pnpm shared:sync.",
    );
    process.exit(1);
  }
  console.log(`shared packages match platform commit ${lock.platformCommit}`);
}

if (process.argv[2] === "sync") sync();
else if (process.argv[2] === "check") check();
else {
  console.error("usage: node scripts/shared.mjs sync|check");
  process.exit(2);
}
