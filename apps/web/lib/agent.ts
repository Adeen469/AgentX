import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { ALLOWED_TEST_COMMANDS, runSandboxedTest, type SandboxBackend } from "./sandbox";
import { safeWorkspacePath } from "./workspace";

const exec = promisify(execFile);

// ---------------------------------------------------------------------------
// Structured logging (dependency-free JSON lines).
// Lives here — not in a new lib file — because this agent's file scope
// permits no new lib modules; API routes import logApi from here.
// One line per event: {"ts","level","route","message", ...ids}. Never pass
// secrets, tokens, or credentials as message/meta values.
// ---------------------------------------------------------------------------
export type LogLevel = "info" | "warn" | "error";

export function logApi(
  route: string,
  level: LogLevel,
  message: string,
  meta?: Record<string, string | number | boolean | null | undefined>,
): void {
  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    route,
    message,
  };
  if (meta) {
    for (const [key, value] of Object.entries(meta)) {
      if (value !== undefined) entry[key] = value;
    }
  }
  const line = JSON.stringify(entry);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

// ---------------------------------------------------------------------------
// Test / reproduction output evidence. The hash covers the FULL combined
// output so a stored proof can be re-checked; the excerpt is the bounded
// slice shown in the UI. Neither ever includes secrets: sandbox output is
// test output, and the staging copy excludes .env* / *.pem / *.key files.
// ---------------------------------------------------------------------------
export const OUTPUT_EXCERPT_MAX_CHARS = 2000;

export function hashOutput(stdout: string, stderr: string): string {
  return createHash("sha256").update(`${stdout}\n---stderr---\n${stderr}`, "utf8").digest("hex");
}

export function outputExcerpt(stdout: string, stderr: string, maxChars = OUTPUT_EXCERPT_MAX_CHARS): string {
  const combined = stdout ? `${stdout}${stderr ? `\n${stderr}` : ""}` : stderr;
  if (combined.length <= maxChars) return combined;
  return `${combined.slice(0, maxChars)}\n… [truncated, ${combined.length - maxChars} more chars]`;
}

// ---------------------------------------------------------------------------
// Autonomous reproduction.
// Given an issue, run ONE allowlisted command sandboxed through
// lib/sandbox.ts and capture the observed failure/success BEFORE a fix is
// proposed. The command is never taken verbatim from issue text: it must
// be an exact allowlist match, or the default "npm test". No host fallback,
// ever — when Docker is absent (or there is no workspace yet) the attempt
// is recorded as status "not-run" and the plan proceeds WITHOUT claiming
// a reproduction.
// ---------------------------------------------------------------------------
export type ReproStatus = "reproduced" | "not-reproduced" | "not-run";

export interface ReproAttempt {
  status: ReproStatus;
  /** Why the attempt ended this way; for "not-run" this is the honest cause. */
  reason: string;
  command: string;
  /** Raw exit code when the command ran; null when it never ran / timed out. */
  exitCode: number | null;
  outputExcerpt: string;
  sandboxed: boolean;
  /** Which backend ran the repro, or null when nothing ran. */
  sandboxBackend: SandboxBackend | null;
  /** False when Docker was probed and missing; null when never probed
   *  (e.g. the AppContainer backend ran instead, or no workspace). */
  dockerAvailable: boolean | null;
}

export const DEFAULT_REPRO_COMMAND = "npm test";

/** Pick the repro command: an explicit allowlisted command wins, then an
 *  exact allowlisted command named in the issue text, else the default. */
export function pickReproCommand(input: {
  command?: string;
  issueTitle?: string;
  issueBody?: string;
}): string {
  if (input.command && ALLOWED_TEST_COMMANDS.has(input.command)) return input.command;
  const text = `${input.issueTitle || ""}\n${input.issueBody || ""}`;
  for (const candidate of ALLOWED_TEST_COMMANDS) {
    // Exact command as a standalone token, not a substring of a longer
    // command (e.g. "npm test" inside "npm test:watch" must not match).
    const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(^|[^\\w-])${escaped}([^\\w-]|$)`, "m").test(text)) return candidate;
  }
  return DEFAULT_REPRO_COMMAND;
}

export async function attemptReproduction(input: {
  repository?: string;
  issueTitle?: string;
  issueBody?: string;
  workspace?: string;
  command?: string;
}): Promise<ReproAttempt> {
  const command = pickReproCommand(input);
  if (!input.workspace) {
    return {
      status: "not-run",
      reason:
        "Repro not run — no workspace exists yet. Create an isolated workspace for the issue, then run POST /api/agent/repro.",
      command,
      exitCode: null,
      outputExcerpt: "",
      sandboxed: false,
      sandboxBackend: null,
      dockerAvailable: null,
    };
  }
  try {
    const result = await runSandboxedTest(input.workspace, command);
    const reproduced = !result.passed;
    return {
      status: reproduced ? "reproduced" : "not-reproduced",
      reason: reproduced
        ? `Repro command failed in the sandbox (exit ${result.exitCode ?? "unknown"}), matching the reported issue.`
        : "Repro command passed in the sandbox; the reported failure did not reproduce with this command.",
      command: result.command,
      exitCode: result.exitCode,
      outputExcerpt: outputExcerpt(result.stdout, result.stderr),
      sandboxed: true,
      sandboxBackend: result.backend,
      dockerAvailable: result.backend === "docker" ? true : null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Reproduction failed.";
    // Only a failed Docker-availability probe means "Docker unavailable".
    // Any other failure (bad workspace, image error, cgroup limits, runc
    // errors) must keep its real message: classifying every error that
    // merely mentions "docker" as "Docker unavailable" hid the true cause
    // (seen 2026-11-08: a NanoCPUs/cgroup error was reported as Docker
    // missing while `docker info` worked fine).
    const dockerMissing =
      message.startsWith("Docker is not available.") ||
      /cannot connect to the docker daemon|docker daemon is not running/i.test(message);
    return {
      status: "not-run",
      reason: dockerMissing
        ? "Repro not run — Docker unavailable. Install and start Docker, then retry. Tests are never run on the host as a fallback."
        : `Repro not run — ${message}`,
      command,
      exitCode: null,
      outputExcerpt: "",
      sandboxed: false,
      sandboxBackend: null,
      dockerAvailable: dockerMissing ? false : null,
    };
  }
}

type PlanInput = { repository?: string; issueTitle: string; issueBody: string; reproduction?: ReproAttempt };

export type AgentPlan = {
  summary: string;
  steps: string[];
  likelyFiles: string[];
  validationCommands: string[];
  irreversibleActions: string[];
};

type Provider = { name: string; url: string; key?: string; model: string };

function configuredKeys(...names: string[]): string[] {
  const values: Array<string | undefined> = [];
  for (const name of names) {
    values.push(process.env[name], process.env[`${name}_1`], process.env[`${name}_2`]);
  }
  const envPaths = [
    path.resolve(process.cwd(), ".env.local"),
    path.resolve(process.cwd(), "..", "..", ".env.local"),
    path.resolve(process.cwd(), "..", "..", "..", ".env.local")
  ];
  const envPath = envPaths.find((candidate) => fs.existsSync(candidate));
  if (envPath) {
    for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
      for (const name of names) {
        const match = line.match(new RegExp(`^\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=\\s*(.*)\\s*$`));
        if (match?.[1]) values.push(match[1].replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1"));
      }
    }
  }
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}

const systemPrompt = [
  "You plan safe repository bug investigations.",
  "Return only JSON with keys summary, steps, likelyFiles, validationCommands, and irreversibleActions.",
  "summary must be a string. All other keys must be arrays of strings.",
  "Never propose pushing, merging, or opening a pull request without human approval.",
  "Do not claim that a bug was reproduced or fixed; provide an investigation plan.",
  "When reproduction evidence is supplied, ground the plan in it: if status is 'reproduced', treat the captured failure as observed fact; if status is 'not-reproduced' or 'not-run', say so and do not claim the bug was reproduced."
].join(" ");

function providers(): Provider[] {
  const configured: Provider[] = [];
  const addProvider = (name: string, url: string, model: string, ...keyNames: string[]) => {
    configuredKeys(...keyNames).forEach((key, index) => {
      configured.push({ name: `${name} ${index + 1}`, url, key, model });
    });
  };

  addProvider("Groq", "https://api.groq.com/openai/v1", process.env.GROQ_MODEL?.trim() || "llama-3.1-8b-instant", "GROQ_API_KEY", "GROQ2_API_KEY");
  addProvider("Gemini", "https://generativelanguage.googleapis.com/v1beta/openai", process.env.GEMINI_MODEL?.trim() || "gemini-2.0-flash", "GEMINI_API_KEY", "GEMINI2_API_KEY");
  addProvider("OpenRouter", "https://openrouter.ai/api/v1", process.env.OPENROUTER_MODEL?.trim() || "openrouter/free", "OPENROUTER_API_KEY", "OPENROUTER2_API_KEY");
  addProvider("NVIDIA", "https://integrate.api.nvidia.com/v1", process.env.NVIDIA_MODEL?.trim() || "nvidia/nemotron-3-ultra-550b-a55b", "NVIDIA_API_KEY", "NVIDIA2_API_KEY");
  return configured;
}

function normalizePlan(value: unknown): AgentPlan {
  if (!value || typeof value !== "object") throw new Error("The model returned an invalid plan.");
  const candidate = value as Record<string, unknown>;
  const array = (key: string) => {
    const value = candidate[key];
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
      throw new Error(`The model plan field "${key}" is invalid.`);
    }
    return value;
  };
  if (typeof candidate.summary !== "string" || !candidate.summary.trim()) throw new Error("The model plan has no summary.");
  return {
    summary: candidate.summary.trim(),
    steps: array("steps"),
    likelyFiles: array("likelyFiles"),
    validationCommands: array("validationCommands"),
    irreversibleActions: array("irreversibleActions")
  };
}

async function callProvider(
  provider: Provider,
  messages: Array<{ role: string; content: string }>,
  options?: { jsonMode?: boolean; timeoutMs?: number },
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options?.timeoutMs ?? 20_000);
  try {
    const response = await fetch(`${provider.url}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        ...(provider.key ? { Authorization: `Bearer ${provider.key}` } : {}),
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: provider.model,
        temperature: 0.1,
        ...(options?.jsonMode ? { response_format: { type: "json_object" } } : {}),
        messages
      })
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new Error("Provider credential was rejected. Rotate the key or configure another provider.");
      }
      throw new Error(`Provider returned HTTP ${response.status}.`);
    }
    const completion = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = completion.choices?.[0]?.message?.content;
    if (!content) throw new Error("Provider returned an empty response.");
    return content;
  } finally {
    clearTimeout(timeout);
  }
}

async function requestProvider(provider: Provider, input: Record<string, unknown>): Promise<AgentPlan> {
  const content = await callProvider(provider, [
    { role: "system", content: systemPrompt },
    { role: "user", content: JSON.stringify(input) }
  ], { jsonMode: true });
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return normalizePlan(JSON.parse(cleaned));
}

/** Raw-text provider call for the fix step: the model returns a unified
 *  diff, not JSON, so the response is returned as text (fences stripped)
 *  and validated by validateAndApplyDiff before anything is applied. */
async function requestProviderText(
  provider: Provider,
  input: Record<string, unknown>,
  system: string,
  timeoutMs: number,
): Promise<string> {
  const content = await callProvider(provider, [
    { role: "system", content: system },
    { role: "user", content: JSON.stringify(input) }
  ], { timeoutMs });
  return content.trim().replace(/^```(?:diff|patch)?\s*/i, "").replace(/\s*```$/, "").trim();
}

// ---------------------------------------------------------------------------
// AI fix: apply a model-produced patch to an isolated workspace.
//
// The agent plans; the fix step makes the model write the change. The
// model returns ONLY a unified diff, which is validated server-side
// before it touches the workspace:
// - every touched path must resolve inside the workspace (no absolute
//   paths, no "..", no renames);
// - `git apply --check` must pass, so a patch that does not apply cleanly
//   is rejected with the model's error instead of half-applied;
// - `git apply` itself is atomic (all hunks or none).
// A failed provider falls through to the next configured provider, exactly
// like planning. Nothing here runs code, merges, or opens a pull request:
// the diff still goes through the human review + approval gate.
// ---------------------------------------------------------------------------

/** At most this many planned files are sent to the model per fix attempt. */
export const FIX_MAX_FILES = 5;
/** Files larger than this are skipped — the model must fix without them. */
export const FIX_MAX_FILE_CHARS = 20_000;

const fixSystemPrompt = [
  "You fix a reported bug in a repository.",
  "Return ONLY a unified diff (git diff format) that fixes the issue. No explanations, no markdown fences, no text outside the diff.",
  "Diff headers must use a/<path> and b/<path> with paths relative to the repository root.",
  "Only modify the files listed in the input. Do not add new dependencies and do not change unrelated code.",
  "Keep the change minimal: the smallest diff that fixes the reported issue and keeps existing tests passing."
].join(" ");

/** The file paths a unified diff touches (b-side, or a-side for deletions). */
export function diffTouchedFiles(diff: string): string[] {
  const files: string[] = [];
  for (const line of diff.split("\n")) {
    const plus = line.match(/^\+\+\+ b\/(.+?)\s*$/);
    if (plus?.[1] && !files.includes(plus[1])) files.push(plus[1]);
    else {
      const minus = line.match(/^--- a\/(.+?)\s*$/);
      if (minus?.[1] && minus[1] !== "/dev/null" && !files.includes(minus[1])) files.push(minus[1]);
    }
  }
  return files.filter((file) => file !== "/dev/null");
}

/**
 * Validate a model-produced unified diff and apply it to a managed
 * workspace. Throws (applying nothing) when the text is not a diff, a
 * path escapes the workspace, a file is renamed, or the patch does not
 * apply cleanly. Returns the touched file paths on success.
 */
export async function validateAndApplyDiff(workspace: string, diff: string): Promise<string[]> {
  const cleaned = diff.trim().replace(/^```(?:diff|patch)?\s*/i, "").replace(/\s*```$/, "").trim();
  if (!cleaned) throw new Error("The model returned an empty patch.");
  for (const line of cleaned.split("\n")) {
    const header = line.match(/^diff --git a\/(.+?) b\/(.+?)\s*$/);
    if (header && header[1] !== header[2]) {
      throw new Error("The patch renames a file, which is not supported; keep paths identical on both sides.");
    }
  }
  const files = diffTouchedFiles(cleaned);
  if (files.length === 0) throw new Error("The model did not return a unified diff.");
  for (const file of files) {
    if (path.isAbsolute(file) || file.split("/").includes("..")) {
      throw new Error(`The patch touches a path outside the workspace: ${file}`);
    }
  }
  const root = safeWorkspacePath(workspace, ".");
  // execFile has no stdin `input` option in this @types/node, so the patch
  // goes through a temp file (removed afterwards, whatever happens). The
  // patch text must end with a newline: a context line at EOF without one
  // is a corrupt patch ("corrupt patch at line N"), and model output
  // routinely arrives trimmed.
  const patchText = cleaned.endsWith("\n") ? cleaned : `${cleaned}\n`;
  const patchFile = path.join(os.tmpdir(), `agentx-patch-${randomUUID()}.diff`);
  try {
    await writeFile(patchFile, patchText, "utf8");
    try {
      await exec("git", ["apply", "--check", "--whitespace=nowarn", patchFile], {
        cwd: root, windowsHide: true, timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
      });
    } catch (error) {
      const failed = error as { stderr?: string; message?: string };
      throw new Error(`The model returned a patch that does not apply cleanly: ${(failed.stderr || failed.message || "unknown git apply error").trim()}`);
    }
    await exec("git", ["apply", "--whitespace=nowarn", patchFile], {
      cwd: root, windowsHide: true, timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
    });
  } finally {
    await rm(patchFile, { force: true }).catch(() => undefined);
  }
  return files;
}

export async function createAgentFix(input: {
  workspace: string;
  repository?: string;
  issueTitle: string;
  issueBody: string;
  plan?: AgentPlan;
}): Promise<{ diff: string; filesChanged: string[]; provider: string; fallbackUsed: boolean }> {
  const configured = providers();
  if (configured.length === 0) {
    throw new Error("No AI provider is configured. Add keys for Groq, Gemini, OpenRouter, or NVIDIA.");
  }
  const candidatePaths = (input.plan?.likelyFiles || []).slice(0, FIX_MAX_FILES);
  const files: Array<{ path: string; content: string }> = [];
  for (const candidate of candidatePaths) {
    try {
      const content = await readFile(safeWorkspacePath(input.workspace, candidate), "utf8");
      if (content.length > FIX_MAX_FILE_CHARS) continue;
      files.push({ path: candidate, content });
    } catch {
      // Planned file does not exist in the workspace — skip it; the
      // model works with the files that are actually there.
    }
  }
  if (files.length === 0) {
    throw new Error("No planned file could be read from the workspace. Create the workspace first and make sure the plan lists files that exist in it.");
  }
  const modelInput: Record<string, unknown> = {
    repository: input.repository,
    issueTitle: input.issueTitle,
    issueBody: input.issueBody,
    plan: input.plan
      ? { summary: input.plan.summary, steps: input.plan.steps, likelyFiles: input.plan.likelyFiles }
      : undefined,
    files,
  };
  const failures: string[] = [];
  for (const provider of configured) {
    try {
      // A diff is longer than a plan summary: allow 60s per provider.
      const raw = await requestProviderText(provider, modelInput, fixSystemPrompt, 60_000);
      const filesChanged = await validateAndApplyDiff(input.workspace, raw);
      const diff = raw.trim().replace(/^```(?:diff|patch)?\s*/i, "").replace(/\s*```$/, "").trim();
      return { diff, filesChanged, provider: provider.name, fallbackUsed: failures.length > 0 };
    } catch (error) {
      failures.push(`${provider.name}: ${error instanceof Error ? error.message : "request failed"}`);
    }
  }
  throw new Error(`All configured AI providers failed. ${failures.join(" ")}`);
}

export async function createAgentPlan(input: PlanInput) {
  const configured = providers();
  if (configured.length === 0) {
    throw new Error("No AI provider is configured. Add keys for Groq, Gemini, OpenRouter, or NVIDIA.");
  }
  // The reproduction evidence (when present) travels to the model as part
  // of the user message so the plan is grounded in what was observed —
  // including the honest "not-run" case, which must never be upgraded
  // into a claimed reproduction.
  const modelInput: Record<string, unknown> = {
    repository: input.repository,
    issueTitle: input.issueTitle,
    issueBody: input.issueBody,
  };
  if (input.reproduction) {
    modelInput.reproduction = {
      status: input.reproduction.status,
      reason: input.reproduction.reason,
      command: input.reproduction.command,
      exitCode: input.reproduction.exitCode,
      outputExcerpt: input.reproduction.outputExcerpt,
      sandboxed: input.reproduction.sandboxed,
    };
  }
  const failures: string[] = [];
  for (const provider of configured) {
    try {
      return { plan: await requestProvider(provider, modelInput), provider: provider.name, fallbackUsed: failures.length > 0 };
    } catch (error) {
      failures.push(`${provider.name}: ${error instanceof Error ? error.message : "request failed"}`);
    }
  }
  throw new Error(`All configured AI providers failed. ${failures.join(" ")}`);
}
