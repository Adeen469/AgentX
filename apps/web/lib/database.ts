import { Pool } from "pg";

let pool: Pool | undefined;

export function database(): Pool {
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString || connectionString.includes("******")) {
    throw new Error("DATABASE_URL is not configured with a real PostgreSQL connection string.");
  }
  pool = new Pool({ connectionString, max: 10 });
  return pool;
}

export async function recordAgentAction(input: {
  userId: string;
  repository: string;
  action: string;
  details: unknown;
}) {
  await database().query(
    "INSERT INTO agent_actions (user_id, repository, action, details) VALUES ($1, $2, $3, $4)",
    [input.userId, input.repository, input.action, JSON.stringify(input.details)]
  );
}
