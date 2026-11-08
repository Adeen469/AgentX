/**
 * Sandboxed test execution: Docker backend (Phase 2) + Windows
 * AppContainer backend (AgentXWorker). The dispatcher
 * (`runSandboxedTest`) picks a backend at runtime — AppContainer first
 * on Windows when the worker binary is present (the desktop user runs
 * only AgentX.exe: no Docker, no WSL, no console), Docker otherwise —
 * and fails closed when neither exists. There is intentionally NO host
 * fallback: if no backend is available, the test fails with an
 * infrastructure error instead of silently running on the host.
 *
 * Threat model, in plain terms:
 * - Test code in a target repository is untrusted. It must never run on the
 *   AgentX host, must never see host files, host environment variables, or
 *   host secrets, and must never reach the network.
 * - The only host directory a sandbox ever sees is a disposable copy of
 *   the workspace. The original workspace is never exposed, so a test
 *   cannot rewrite the user's checked-out branch directly, and a symlink
 *   inside the copy resolves inside the sandbox, not on the host.
 *   Docker mounts the copy at /work; the AppContainer worker grants its
 *   container SID access to the copy only.
 * - There is intentionally NO host fallback. If Docker is missing, the
 *   daemon is down, or no image can be chosen for the command, the test
 *   fails with an infrastructure error instead of silently running on the
 *   host. That failure is the safe behaviour.
 *
 * What this module does NOT do yet (honest limits, see docs/SANDBOX.md):
 * - It does not install project dependencies inside the sandbox. The
 *   container starts from a clean language image (Docker) or the host's
 *   machine-wide toolchains (AppContainer), so a project whose tests
 *   need `npm install` / `pip install` first will fail until a sandboxed
 *   dependency-install step is added in a later phase. Dependencies that
 *   are already present in the workspace copy are used as-is.
 * - It does not verify the test result server-side for the approval gate.
 *   That binding is Phase 1 / Phase 5 work, not Phase 2.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readdir, realpath, rm, stat } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export const ALLOWED_TEST_COMMANDS = new Set([
  "npm test",
  "npm run test",
  "npm run lint",
  "pytest",
  "dotnet test",
  "cargo test",
  "go test ./...",
]);

export type SandboxRuntime = "node" | "python" | "dotnet" | "rust" | "go";

/** Which sandbox backend ran a test: Docker, or the Windows AppContainer worker. */
export type SandboxBackend = "docker" | "appcontainer";

export interface SandboxTestResult {
  command: string;
  /** Which backend ran the test. */
  backend: SandboxBackend;
  passed: boolean;
  /** Raw process exit code when known (0 on pass). null when the run timed
   *  out before an exit code existed. Callers that store a test-pass proof
   *  use this value; they must NOT infer a pass from anything else. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** Always true for results produced by this module. */
  sandboxed: true;
  /** The Docker image the test actually ran in, or
   *  `appcontainer:<runtime>` for the AppContainer backend. */
  image: string;
}

export interface SandboxConfig {
  cpus: string;
  memory: string;
  memorySwap: string;
  pidsLimit: string;
  timeoutMs: number;
  user: string;
  images: Record<SandboxRuntime, string>;
}

export type SandboxExec = (
  file: string,
  args: string[],
  options: { timeout?: number; maxBuffer?: number; windowsHide?: boolean },
) => Promise<{ stdout: string; stderr: string }>;

const defaultExec: SandboxExec = (file, args, options) =>
  exec(file, args, { windowsHide: true, ...options }) as Promise<{
    stdout: string;
    stderr: string;
  }>;

/** Workspace root, using the same rule as workspace.ts (kept local here so
 *  sandbox.ts never imports workspace.ts and creates an import cycle). */
export function sandboxWorkspaceRoot(): string {
  return path.resolve(
    process.env.WORKSPACE_ROOT || path.join(process.cwd(), "workspaces"),
  );
}

export function defaultSandboxUser(): string {
  if (process.platform === "win32") return "10001:10001";
  const getuid = (process as { getuid?: () => number }).getuid;
  const getgid = (process as { getgid?: () => number }).getgid;
  if (typeof getuid === "function" && typeof getgid === "function") {
    // Never run the container as root, even if the AgentX server itself
    // runs as root: fall back to 10001 in that case (see
    // ensureStagingWritable below, which loosens only the disposable copy).
    // Otherwise, running as the host user keeps file ownership on the
    // mounted staging copy correct on Linux/macOS.
    if (getuid() === 0) return "10001:10001";
    return `${getuid()}:${getgid()}`;
  }
  return "10001:10001";
}

function envOr(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value ? value : fallback;
}

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(
      `Sandbox configuration is invalid: ${name} must be an integer between ${min} and ${max}.`,
    );
  }
  return value;
}

function envSize(name: string, fallback: string): string {
  const value = envOr(name, fallback);
  if (!/^\d+(\.\d+)?(m|g)$/i.test(value)) {
    throw new Error(
      `Sandbox configuration is invalid: ${name} must look like "512m" or "1g".`,
    );
  }
  return value.toLowerCase();
}

export function sandboxConfig(): SandboxConfig {
  const cpusRaw = envOr("AGENTX_SANDBOX_CPUS", "2");
  const cpus = Number(cpusRaw);
  if (!Number.isFinite(cpus) || cpus <= 0 || cpus > 32) {
    throw new Error(
      "Sandbox configuration is invalid: AGENTX_SANDBOX_CPUS must be a number between 0 and 32.",
    );
  }
  return {
    cpus: cpusRaw,
    memory: envSize("AGENTX_SANDBOX_MEMORY", "1g"),
    memorySwap: envSize("AGENTX_SANDBOX_MEMORY_SWAP", "1g"),
    pidsLimit: String(envInt("AGENTX_SANDBOX_PIDS_LIMIT", 256, 16, 4096)),
    timeoutMs: envInt("AGENTX_SANDBOX_TIMEOUT_MS", 10 * 60 * 1000, 60 * 1000, 60 * 60 * 1000),
    user: envOr("AGENTX_SANDBOX_USER", defaultSandboxUser()),
    images: {
      node: envOr("AGENTX_SANDBOX_IMAGE_NODE", "node:20-bookworm-slim"),
      python: envOr("AGENTX_SANDBOX_IMAGE_PYTHON", "python:3.12-slim"),
      dotnet: envOr(
        "AGENTX_SANDBOX_IMAGE_DOTNET",
        "mcr.microsoft.com/dotnet/sdk:8.0",
      ),
      rust: envOr("AGENTX_SANDBOX_IMAGE_RUST", "rust:1.82-bookworm"),
      go: envOr("AGENTX_SANDBOX_IMAGE_GO", "golang:1.22-bookworm"),
    },
  };
}

/**
 * The runtime follows the test command, not a guess from file names: the
 * command the user selected is what will actually run, so it must decide
 * the image. Unknown commands are rejected before Docker is ever invoked.
 */
export function pickSandboxImage(
  command: string,
  config: SandboxConfig,
): { image: string; runtime: SandboxRuntime } {
  if (command === "npm test" || command === "npm run test" || command === "npm run lint") {
    return { image: config.images.node, runtime: "node" };
  }
  if (command === "pytest") return { image: config.images.python, runtime: "python" };
  if (command === "dotnet test") return { image: config.images.dotnet, runtime: "dotnet" };
  if (command === "cargo test") return { image: config.images.rust, runtime: "rust" };
  if (command === "go test ./...") return { image: config.images.go, runtime: "go" };
  throw new Error("Test command is not allowlisted.");
}

/**
 * AppContainer backend (Windows desktop only).
 *
 * The worker is a small Rust helper
 * (apps/desktop/src-tauri/src/bin/agentx-worker.rs) that runs the test
 * command inside a Windows AppContainer — the OS-native low-integrity
 * sandbox Microsoft Edge uses. No Docker, no WSL, no visible console:
 * the end user runs only AgentX.exe. The worker creates (once) / opens
 * the "AgentXWorker" profile, grants its SID access ONLY to the
 * disposable staging copy of the workspace, spawns the command with a
 * hidden cmd.exe /c inside the container, caps memory/CPU with a Job
 * Object, and returns one JSON result. No network capability is granted,
 * so tests run offline.
 */

/** Locate the AppContainer worker binary, or null when it is absent.
 *  Windows-only: on any other platform there is no AppContainer, so this
 *  always returns null and the backend is never selected. Resolution
 *  order: AGENTX_WORKER_PATH first, then the installed app's resources
 *  (the server runs from <install>\resources\web, the worker ships at
 *  <install>\resources\agentx-worker.exe), then the Tauri crate (dev). */
export function resolveWorkerPath(): string | null {
  if (process.platform !== "win32") return null;
  const candidates: Array<string | undefined> = [
    process.env.AGENTX_WORKER_PATH?.trim(),
    path.join(process.cwd(), "resources", "agentx-worker.exe"),
    path.join(process.cwd(), "agentx-worker.exe"),
    path.join(process.cwd(), "..", "agentx-worker.exe"),
    path.join(
      process.cwd(),
      "..",
      "desktop",
      "src-tauri",
      "resources",
      "agentx-worker.exe",
    ),
    path.join(
      process.cwd(),
      "..",
      "desktop",
      "src-tauri",
      "target",
      "release",
      "agentx-worker.exe",
    ),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      // A broken candidate is skipped, never fatal: resolution failing
      // closed just means this backend is unavailable.
    }
  }
  return null;
}

/**
 * Pick a backend at runtime. AGENTX_SANDBOX_BACKEND forces one
 * ("docker" | "appcontainer" | "auto", default "auto"). Auto prefers
 * the AppContainer worker on Windows — the desktop user runs only
 * AgentX.exe — and Docker everywhere else; when the preferred backend
 * is missing it falls through to the other one, and "unavailable" when
 * neither exists. A forced backend that is missing also yields
 * "unavailable" (never a host run).
 */
export async function detectSandboxBackend(
  run: SandboxExec = defaultExec,
): Promise<SandboxBackend | "unavailable"> {
  const forced = (process.env.AGENTX_SANDBOX_BACKEND || "auto").trim().toLowerCase();
  if (forced === "docker") {
    try {
      await checkDockerAvailable(run);
      return "docker";
    } catch {
      return "unavailable";
    }
  }
  if (forced === "appcontainer") {
    return resolveWorkerPath() ? "appcontainer" : "unavailable";
  }
  if (forced !== "auto") {
    throw new Error(
      'Sandbox configuration is invalid: AGENTX_SANDBOX_BACKEND must be "auto", "docker" or "appcontainer".',
    );
  }
  if (process.platform === "win32" && resolveWorkerPath()) return "appcontainer";
  try {
    await checkDockerAvailable(run);
    return "docker";
  } catch {
    return "unavailable";
  }
}

/** "512m" / "1g" config values → megabytes for the worker's Job Object cap. */
export function sandboxMemoryMb(memory: string): number {
  const match = /^(\d+(?:\.\d+)?)(m|g)$/i.exec(memory.trim());
  if (!match) {
    throw new Error(`Sandbox configuration is invalid: memory must look like "512m" or "1g", got "${memory}".`);
  }
  const value = Number(match[1]);
  return match[2].toLowerCase() === "g" ? Math.round(value * 1024) : Math.round(value);
}

/** "2" CPUs → 200 (percent of one CPU) for the worker's Job Object cap. */
export function sandboxCpuPercent(cpus: string): number {
  const value = Number(cpus.trim());
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Sandbox configuration is invalid: CPUs must be a positive number, got "${cpus}".`);
  }
  return Math.round(value * 100);
}

interface WorkerResultJson {
  runId?: string;
  branch?: string;
  command?: string;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
  workerError?: string;
}

function workerErrorFromOutput(
  stdout: string,
  stderr: string,
  fallback: string,
): string {
  try {
    const parsed = JSON.parse(stdout) as WorkerResultJson;
    if (parsed.workerError) return parsed.workerError;
  } catch {
    // Not JSON — fall through to the raw output.
  }
  return (stderr || fallback).trim() || "unknown worker error";
}

/**
 * Run an allowlisted test command inside the Windows AppContainer worker.
 * Mirrors the Docker backend's contract exactly: same staging-copy
 * discipline (the original workspace is never exposed), same allowlist,
 * same timeout behaviour (a timed-out run is a result with exitCode null,
 * not an exception), and it throws only on infrastructure failures
 * (worker missing, worker crash, invalid worker output) so callers never
 * mistake those for a test failure — and never fall back to the host.
 */
export async function runAppContainerTest(
  workspace: string,
  command: string,
  config: SandboxConfig,
  deps: { run?: SandboxExec } = {},
): Promise<SandboxTestResult> {
  const run = deps.run ?? defaultExec;
  const worker = resolveWorkerPath();
  if (!worker) {
    throw new Error(
      "AppContainer sandbox is not available: agentx-worker.exe was not found. " +
        "Set AGENTX_WORKER_PATH to the worker binary, or install the AgentX desktop app. " +
        "Tests are not run on the host as a fallback.",
    );
  }
  const resolvedWorkspace = await assertManagedWorkspacePath(workspace);
  const { runtime } = pickSandboxImage(command, config);
  const runsRoot = path.join(sandboxWorkspaceRoot(), ".sandbox-runs");
  await mkdir(runsRoot, { recursive: true });
  const staging = await mkdtemp(path.join(runsRoot, "run-"));
  const runId = `run-${randomBytes(8).toString("hex")}`;
  try {
    await cp(resolvedWorkspace, staging, {
      recursive: true,
      filter: (source: string) => !isStagingExcluded(resolvedWorkspace, source),
    });
    const args = [
      "--workspace",
      staging,
      "--command",
      command,
      "--run-id",
      runId,
      "--branch",
      "unknown",
      "--timeout-ms",
      String(config.timeoutMs),
      "--memory-mb",
      String(sandboxMemoryMb(config.memory)),
      "--cpu-percent",
      String(sandboxCpuPercent(config.cpus)),
      "--output-max-bytes",
      String(4 * 1024 * 1024),
    ];
    let stdout = "";
    let stderr = "";
    try {
      const result = await run(worker, args, {
        timeout: config.timeoutMs + 30_000,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
      });
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (error) {
      const failed = error as {
        stdout?: string;
        stderr?: string;
        message?: string;
        killed?: boolean;
      };
      if (failed.killed || /timed out|ETIMEDOUT/i.test(failed.message || "")) {
        return {
          command,
          backend: "appcontainer",
          passed: false,
          exitCode: null,
          stdout: failed.stdout || "",
          stderr: "Test timed out inside the sandbox.",
          sandboxed: true,
          image: `appcontainer:${runtime}`,
        };
      }
      throw new Error(
        `AppContainer sandbox failed before the test could run: ${workerErrorFromOutput(
          failed.stdout || "",
          failed.stderr || "",
          failed.message || "unknown worker error",
        )}`,
      );
    }
    let parsed: WorkerResultJson;
    try {
      parsed = JSON.parse(stdout) as WorkerResultJson;
    } catch {
      throw new Error(
        `AppContainer sandbox failed before the test could run: the worker did not return a valid JSON result.` +
          (stderr ? ` Worker stderr: ${stderr.slice(0, 500)}` : ""),
      );
    }
    if (parsed.workerError || typeof parsed.exitCode === "undefined") {
      throw new Error(
        `AppContainer sandbox failed before the test could run: ${parsed.workerError || "worker returned no exit code"}`,
      );
    }
    return {
      command,
      backend: "appcontainer",
      passed: parsed.exitCode === 0,
      exitCode: parsed.exitCode,
      stdout: parsed.stdout ?? "",
      stderr: parsed.stderr ?? "",
      sandboxed: true,
      image: `appcontainer:${runtime}`,
    };
  } finally {
    // Always remove the staging copy, even on failure, so no test output
    // or modified file lingers on the host next to the real workspace.
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

export interface DockerRunOptions {
  image: string;
  stagingPath: string;
  containerName: string;
  commandParts: string[];
  config: SandboxConfig;
}

/**
 * Pure argument builder, so the exact isolation flags can be unit-tested
 * without Docker installed. Deliberately:
 * - no `--env-file`, no host environment is passed at all; only HOME and
 *   CI are set inside the container, and no other `-e` flags exist;
 * - `--network none` (no outbound network from the container);
 * - `--cap-drop ALL` + `no-new-privileges` (no privilege escalation);
 * - `--read-only` root filesystem, with only /work (the staging copy) and
 *   a tmpfs /tmp writable;
 * - CPU / memory / swap / process-count limits;
 * - `--mount` (not `-v`) so the source path is explicit and only the
 *   staging copy, never the original workspace or the workspace root, is
 *   exposed.
 */
export function buildDockerRunArgs(options: DockerRunOptions): string[] {
  const { image, stagingPath, containerName, commandParts, config } = options;
  return [
    "run",
    "--rm",
    "--name",
    containerName,
    "--network",
    "none",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--read-only",
    "--tmpfs",
    "/tmp",
    "--user",
    config.user,
    "--workdir",
    "/work",
    "--mount",
    `type=bind,source=${stagingPath},target=/work`,
    "--cpus",
    config.cpus,
    "--memory",
    config.memory,
    "--memory-swap",
    config.memorySwap,
    "--pids-limit",
    config.pidsLimit,
    "--env",
    "HOME=/tmp",
    "--env",
    "CI=true",
    image,
    ...commandParts,
  ];
}

export async function checkDockerAvailable(
  run: SandboxExec = defaultExec,
): Promise<void> {
  try {
    await run("docker", ["info", "--format", "{{.ServerVersion}}"], {
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    });
  } catch {
    throw new Error(
      "Docker is not available. Install and start Docker, then retry. " +
        "Tests are not run on the host as a fallback, so this is a hard failure by design.",
    );
  }
}

async function assertManagedWorkspacePath(workspace: string): Promise<string> {
  const root = sandboxWorkspaceRoot();
  const resolvedRoot = await realpath(root).catch(() => root);
  const resolved = await realpath(workspace).catch(() => {
    throw new Error("Workspace does not exist.");
  });
  if (!resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error("Workspace is outside the configured workspace root.");
  }
  const info = await stat(resolved);
  if (!info.isDirectory()) throw new Error("Workspace is not a directory.");
  return resolved;
}

function isStagingExcluded(workspace: string, source: string): boolean {
  const relative = path.relative(workspace, source);
  if (!relative) return false;
  const first = relative.split(path.sep)[0];
  if (first === ".git") return true;
  const base = path.basename(source);
  // Never copy local secrets or private keys into a container, even a
  // network-isolated one: test output can leak file contents.
  if (base === ".env" || base.startsWith(".env.")) return true;
  if (base.endsWith(".pem") || base.endsWith(".key")) return true;
  return false;
}

/**
 * When the container user is not the host user, the staging copy must be
 * writable by that user, or most tests fail on permission errors. This
 * loosens permissions on the disposable staging copy only — never on the
 * original workspace — and is skipped when the container already runs as
 * the host user. Directories get 777 (create files) and files 666 (read /
 * overwrite); executables are not needed because the test command is
 * invoked by name inside the container, not by executing workspace files.
 */
async function ensureStagingWritable(staging: string, user: string): Promise<void> {
  if (process.platform === "win32") return;
  const getuid = (process as { getuid?: () => number }).getuid;
  const getgid = (process as { getgid?: () => number }).getgid;
  if (
    typeof getuid === "function" &&
    typeof getgid === "function" &&
    user === `${getuid()}:${getgid()}`
  ) {
    return;
  }
  const walk = async (dir: string): Promise<void> => {
    await chmod(dir, 0o777).catch(() => undefined);
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(target);
      else if (entry.isFile()) await chmod(target, 0o666).catch(() => undefined);
    }
  };
  await walk(staging);
}

function isDockerInfraError(stderr: string, code: unknown): boolean {
  if (code === 125) return true;
  return /cannot connect to the docker daemon|docker daemon|unable to find image|no such image|permission denied while trying to connect|failed to create task|error during connect/i.test(
    stderr,
  );
}

/**
 * Run an allowlisted test command inside a disposable Docker container.
 * Throws on infrastructure failures (Docker missing, bad config, image
 * problems, staging problems) so callers never mistake those for a test
 * failure, and never falls back to running the command on the host.
 * This is the Docker backend; see runSandboxedTest for the dispatcher.
 */
async function runDockerTest(
  workspace: string,
  command: string,
  config: SandboxConfig,
  deps: { run?: SandboxExec } = {},
): Promise<SandboxTestResult> {
  const run = deps.run ?? defaultExec;
  const resolvedWorkspace = await assertManagedWorkspacePath(workspace);
  const { image } = pickSandboxImage(command, config);
  await checkDockerAvailable(run);

  const runsRoot = path.join(sandboxWorkspaceRoot(), ".sandbox-runs");
  await mkdir(runsRoot, { recursive: true });
  const staging = await mkdtemp(path.join(runsRoot, "run-"));
  const containerName = `agentx-sandbox-${randomBytes(8).toString("hex")}`;
  const commandParts = command.split(" ");
  let timedOut = false;
  try {
    await cp(resolvedWorkspace, staging, {
      recursive: true,
      filter: (source: string) => !isStagingExcluded(resolvedWorkspace, source),
    });
    await ensureStagingWritable(staging, config.user);
    const args = buildDockerRunArgs({
      image,
      stagingPath: staging,
      containerName,
      commandParts,
      config,
    });
    try {
      const result = await run("docker", args, {
        timeout: config.timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
      });
      return {
        command,
        backend: "docker",
        passed: true,
        exitCode: 0,
        stdout: result.stdout,
        stderr: result.stderr,
        sandboxed: true,
        image,
      };
    } catch (error) {
      const failed = error as {
        stdout?: string;
        stderr?: string;
        message?: string;
        code?: unknown;
        killed?: boolean;
      };
      const stdout = failed.stdout || "";
      const stderr = failed.stderr || "";
      if (failed.killed || /timed out|ETIMEDOUT/i.test(failed.message || "")) {
        timedOut = true;
      }
      if (timedOut) {
        return {
          command,
          backend: "docker",
          passed: false,
          exitCode: null,
          stdout,
          stderr: "Test timed out inside the sandbox.",
          sandboxed: true,
          image,
        };
      }
      if (isDockerInfraError(stderr, failed.code)) {
        throw new Error(
          `Docker sandbox failed before the test could run: ${stderr.trim() || failed.message || "unknown Docker error"}`,
        );
      }
      return {
        command,
        backend: "docker",
        passed: false,
        // execFile reports a non-zero exit as error.code; fall back to 1
        // when the runner gives no numeric code, so a failure is never
        // recorded as exit 0.
        exitCode: typeof failed.code === "number" ? failed.code : 1,
        stdout,
        stderr:
          stderr ||
          failed.message ||
          (timedOut ? "Test timed out inside the sandbox." : "Test failed."),
        sandboxed: true,
        image,
      };
    }
  } finally {
    if (timedOut) {
      // `docker run`'s timeout kills the CLI, not necessarily the container.
      // Remove it explicitly; --rm only covers a normal exit.
      await run("docker", ["rm", "-f", containerName], {
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      }).catch(() => undefined);
    }
    // Always remove the staging copy, even on failure, so no test output
    // or modified file lingers on the host next to the real workspace.
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Backend dispatcher — the only entry point callers use. Validates the
 * command, picks a backend at runtime, and delegates. Throws on
 * infrastructure failures (no backend available, bad config, workspace
 * problems) so callers never mistake those for a test failure, and never
 * falls back to running the command on the host.
 */
export async function runSandboxedTest(
  workspace: string,
  command: string,
  deps: { run?: SandboxExec } = {},
): Promise<SandboxTestResult> {
  const config = sandboxConfig();
  if (!ALLOWED_TEST_COMMANDS.has(command)) {
    throw new Error("Test command is not allowlisted.");
  }
  const backend = await detectSandboxBackend(deps.run);
  if (backend === "docker") return runDockerTest(workspace, command, config, deps);
  if (backend === "appcontainer") return runAppContainerTest(workspace, command, config, deps);
  throw new Error(
    "No sandbox backend is available. On Windows, the AppContainer worker " +
      "(agentx-worker.exe) was not found and Docker is also unavailable; on " +
      "other systems Docker is required. Tests are not run on the host as a " +
      "fallback, so this is a hard failure by design.",
  );
}
