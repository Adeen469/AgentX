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
// AUTH_SECRET signs sessions and approval tokens: it must be long and
// random. This mirrors the runtime check in apps/web/lib/auth.ts
// (requireAuthSecret) so a weak secret fails fast at startup instead of
// at first sign-in.
const MIN_AUTH_SECRET_LENGTH = 32;
const weakAuthSecrets = new Set([
  "secret",
  "changeme",
  "change-me",
  "change_me",
  "password",
  "test",
  "testing",
  "dev",
  "development",
  "default",
  "agentx",
  "agentx-secret",
  "your_auth_secret",
  "your_secret",
  "replace-me",
  "replace_me",
  "placeholder",
]);
const authSecret = (values.AUTH_SECRET || "").trim();
const authSecretLower = authSecret.toLowerCase();
if (
  authSecret.length < MIN_AUTH_SECRET_LENGTH ||
  weakAuthSecrets.has(authSecretLower) ||
  authSecretLower.includes("your_") ||
  authSecretLower.includes("******") ||
  authSecretLower.includes("changeme") ||
  authSecretLower.includes("change-me") ||
  /^(.)\1+$/.test(authSecret) ||
  /^(.{1,8})\1+.{0,4}$/.test(authSecret) // e.g. "secretsecretsecretsecretsecret12"
) {
  console.error(
    `AUTH_SECRET must be a randomly generated value of at least ${MIN_AUTH_SECRET_LENGTH} characters (e.g. \`openssl rand -hex 32\`). ` +
    `A short, placeholder, or guessable secret lets anyone forge sessions and approval tokens.`
  );
  process.exit(1);
}
// GITHUB_CLIENT_SECRET is server-only too: reject placeholder values if set.
if (values.GITHUB_CLIENT_SECRET && (values.GITHUB_CLIENT_SECRET.includes("your_") || values.GITHUB_CLIENT_SECRET.includes("******"))) {
  console.error("GITHUB_CLIENT_SECRET looks like a placeholder value. Set the real GitHub OAuth client secret.");
  process.exit(1);
}
const configuredOptional = optional.filter((name) => values[name]);
console.log(`Required configuration is present. Optional integrations configured: ${configuredOptional.length}/${optional.length}.`);
