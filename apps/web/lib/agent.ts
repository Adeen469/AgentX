import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ALLOWED_TEST_COMMANDS, runSandboxedTest, type SandboxBackend } from "./sandbox";

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

async function requestProvider(provider: Provider, input: Record<string, unknown>): Promise<AgentPlan> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
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
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: JSON.stringify(input) }
        ]
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
    if (!content) throw new Error("Provider returned an empty plan.");
    const cleaned = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    return normalizePlan(JSON.parse(cleaned));
  } finally {
    clearTimeout(timeout);
  }
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
