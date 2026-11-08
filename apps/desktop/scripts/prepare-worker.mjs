// Build agentx-worker and stage it as a Tauri resource.
//
// The AppContainer worker (apps/desktop/agentx-worker) must exist at
// src-tauri/resources/agentx-worker.exe before `tauri build` — it is
// listed in tauri.conf.json `bundle.resources`, and the Tauri build
// script fails when a resource path is missing (same as the
// .next/standalone resource, which needs `npm run build` first). The
// worker is a separate crate (not a [[bin]] of the Tauri crate) precisely
// so it can be built standalone: building it as a bin of the Tauri crate
// would run that crate's build script first, which deadlocks on the
// missing resource.
//
// - On Windows: `cargo build --release` in the worker crate (host target).
// - Elsewhere: cross-compile with cargo-xwin when available (Linux
//   dev/CI); without it, keep an already-staged copy if one exists, else
//   fail with a clear message instead of a cryptic bundler error.
//
// Called automatically by tauri.conf.json `beforeBuildCommand`, and
// manually as `npm run build:worker --workspace @agentx/desktop`.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workerDir = path.join(desktopDir, "agentx-worker");
const resourcesDir = path.join(desktopDir, "src-tauri", "resources");
const staged = path.join(resourcesDir, "agentx-worker.exe");

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (result.error) return { ok: false, error: result.error };
  return { ok: result.status === 0, status: result.status };
}

const isWindows = process.platform === "win32";
let built = null;

if (isWindows) {
  console.log("[prepare-worker] Building agentx-worker for Windows (host target)...");
  const r = run("cargo", ["build", "--release"], { cwd: workerDir });
  if (r.ok) built = path.join(workerDir, "target", "release", "agentx-worker.exe");
} else {
  const xwin = spawnSync("cargo", ["xwin", "--version"], { stdio: "pipe" });
  if (xwin.status === 0) {
    console.log("[prepare-worker] Cross-compiling agentx-worker for x86_64-pc-windows-msvc via cargo-xwin...");
    const r = run(
      "cargo",
      ["xwin", "build", "--release", "--target", "x86_64-pc-windows-msvc"],
      { cwd: workerDir },
    );
    if (r.ok) {
      built = path.join(
        workerDir,
        "target",
        "x86_64-pc-windows-msvc",
        "release",
        "agentx-worker.exe",
      );
    }
  } else {
    console.log("[prepare-worker] cargo-xwin not found; skipping worker cross-compile.");
  }
}

if (built && existsSync(built)) {
  mkdirSync(resourcesDir, { recursive: true });
  copyFileSync(built, staged);
  console.log(`[prepare-worker] Staged worker at ${staged}`);
  process.exit(0);
}
if (existsSync(staged)) {
  console.log("[prepare-worker] No fresh worker built, but a staged copy already exists; keeping it.");
  process.exit(0);
}
console.error(
  "[prepare-worker] ERROR: no agentx-worker.exe could be built or found. " +
    "Build it first (Windows: cargo build --release in apps/desktop/agentx-worker) — tauri build needs it as a resource.",
);
process.exit(1);
