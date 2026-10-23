const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");

function loadEnv() {
  const file = path.resolve(".env.local");
  if (!fs.existsSync(file)) throw new Error(".env.local was not found.");
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
}

async function main() {
  loadEnv();
  if (!process.env.DATABASE_URL || process.env.DATABASE_URL.includes("******")) throw new Error("Set DATABASE_URL to a real PostgreSQL connection string first.");
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const schema = fs.readFileSync(path.resolve("apps/web/db/001_initial.sql"), "utf8");
  await client.query(schema);
  await client.end();
  console.log("AgentX database schema is ready.");
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
