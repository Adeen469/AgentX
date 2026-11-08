const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");

// Migrations are applied in filename order. Add new migrations to this
// list (and to apps/web/db/) in the same order — never reorder entries
// that have already shipped.
const MIGRATIONS = [
  "apps/web/db/001_initial.sql",
  "apps/web/db/002_test_runs.sql",
];

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
  try {
    for (const migration of MIGRATIONS) {
      const schema = fs.readFileSync(path.resolve(migration), "utf8");
      await client.query(schema);
      console.log(`Applied ${migration}`);
    }
  } finally {
    await client.end();
  }
  console.log("AgentX database schema is ready.");
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
