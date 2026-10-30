import fs from "node:fs";
import path from "node:path";

type PlanInput = { repository?: string; issueTitle: string; issueBody: string };

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
  "Do not claim that a bug was reproduced or fixed; provide an investigation plan."
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

async function requestProvider(provider: Provider, input: PlanInput): Promise<AgentPlan> {
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
  const failures: string[] = [];
  for (const provider of configured) {
    try {
      return { plan: await requestProvider(provider, input), provider: provider.name, fallbackUsed: failures.length > 0 };
    } catch (error) {
      failures.push(`${provider.name}: ${error instanceof Error ? error.message : "request failed"}`);
    }
  }
  throw new Error(`All configured AI providers failed. ${failures.join(" ")}`);
}
