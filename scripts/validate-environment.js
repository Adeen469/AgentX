const fs = require("node:fs");
const path = require("node:path");

const required = ["AUTH_SECRET", "DATABASE_URL"];
const optional = [
  "GITHUB_Client_ID",
  "GITHUB_Client_Secret",
  "GROQ_API_KEY",
  "GROQ2_API_KEY",
  "GEMINI_API_KEY",
  "GEMINI2_API_KEY",
  "OPENROUTER_API_KEY",
  "OPENROUTER2_API_KEY",
  "NVIDIA_API_KEY",
  "NVIDIA2_API_KEY"
];
const file = path.resolve(".env.local");
if (!fs.existsSync(file)) {
  console.error("Missing .env.local. Copy .env.example and configure it before starting AgentX.");
  process.exit(1);
}
const values = Object.fromEntries(fs.readFileSync(file, "utf8").split(/\r?\n/).filter((line) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(line)).map((line) => {
  const split = line.indexOf("=");
  return [line.slice(0, split), line.slice(split + 1)];
}));
const missing = required.filter((name) => !values[name] || values[name].includes("your_") || values[name].includes("******"));
if (missing.length) {
  console.error(`Missing valid configuration: ${missing.join(", ")}`);
  process.exit(1);
}
const configuredOptional = optional.filter((name) => values[name]);
console.log(`Required configuration is present. Optional integrations configured: ${configuredOptional.length}/${optional.length}.`);
