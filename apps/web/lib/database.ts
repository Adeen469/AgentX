import { Pool } from "pg";

/**
 * Database layer — AgentX (GitHub-only, no Edge middleware).
 *
 * Graceful degradation when DATABASE_URL is missing/unset:
 * - Importing this module NEVER throws and NEVER opens a connection; the
 *   pool is created lazily on first use.
 * - `database()` throws DatabaseUnavailableError (an Error subclass) when
 *   no real connection string is configured. API routes MUST catch it and
 *   answer 503 with a clear message, e.g.:
 *       import { database, DatabaseUnavailableError } from "@/lib/database";
 *       try {
 *         const { rows } = await database().query("SELECT ...");
 *         return NextResponse.json(rows);
 *       } catch (error) {
 *         if (error instanceof DatabaseUnavailableError) {
 *           return NextResponse.json(
 *             { error: "Database is not configured." },
 *             { status: 503 }
 *           );
 *         }
 *         throw error;
 *       }
 * - `tryDatabase()` returns the pool, or null when the database is not
 *   configured — use it when a route can degrade gracefully instead of
 *   failing (e.g. audit logging that is best-effort).
 * - `isDatabaseConfigured()` reports whether a real connection string is
 *   set, without creating a pool.
 *
 * Connection-string shape: DATABASE_URL is expected to be the Supabase
 * Transaction pooler URL (port 6543), e.g.
 *   postgres://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres
 * A direct (non-pooler) URL (port 5432 / db.<ref>.supabase.co) still works
 * but logs a one-time warning: serverless functions open a fresh connection
 * per invocation and can exhaust Supabase's direct-connection limit.
 */

export class DatabaseUnavailableError extends Error {
  constructor(message = "DATABASE_URL is not configured with a real PostgreSQL connection string.") {
    super(message);
    this.name = "DatabaseUnavailableError";
  }
}

/** True when DATABASE_URL looks like a real (non-placeholder) connection string. */
export function isDatabaseConfigured(): boolean {
  const connectionString = process.env.DATABASE_URL;
  return !!connectionString && !connectionString.includes("******");
}

/**
 * True when the connection string points at the Supabase Transaction
 * pooler (port 6543 or a *.pooler.supabase.com host). Anything else —
 * notably a direct port-5432 URL — is treated as non-pooler.
 */
export function isPoolerConnectionString(connectionString: string): boolean {
  try {
    const url = new URL(connectionString);
    return url.port === "6543" || url.hostname.endsWith("pooler.supabase.com");
  } catch {
    return false;
  }
}

let pool: Pool | undefined;
let poolerWarningLogged = false;

export function database(): Pool {
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString || connectionString.includes("******")) {
    throw new DatabaseUnavailableError();
  }
  if (!isPoolerConnectionString(connectionString) && !poolerWarningLogged) {
    poolerWarningLogged = true;
    console.warn(
      "[database] DATABASE_URL does not look like a Supabase Transaction pooler URL " +
        "(expected port 6543, e.g. postgres://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres). " +
        "A direct connection (port 5432) can exhaust Supabase's connection limit under serverless load; switch DATABASE_URL to the pooler URL."
    );
  }
  pool = new Pool({
    connectionString,
    // Vercel Hobby/serverless: keep the pool small; each function instance
    // holds its own pool, so a large `max` here multiplies fast.
    max: 10,
    // Fail fast instead of hanging a request on a dead/unreachable database.
    connectionTimeoutMillis: 5_000,
    // Return idle clients promptly so connections are not held across
    // cold serverless invocations.
    idleTimeoutMillis: 30_000,
    // Recycle clients periodically to avoid stale pooled connections.
    maxUses: 7_500,
    // Let the process exit when the pool is idle (serverless-friendly).
    allowExitOnIdle: true,
  });
  // A pool-level error (e.g. an idle client dying) must never crash the
  // process as an unhandled 'error' event; the failing query still rejects.
  pool.on("error", (error) => {
    console.error("[database] idle pool client error:", error);
  });
  return pool;
}

/**
 * Safe accessor: returns the pool, or null when the database is not
 * configured. Never throws for a missing DATABASE_URL.
 */
export function tryDatabase(): Pool | null {
  if (!isDatabaseConfigured()) return null;
  return database();
}

/** Close the pool (scripts/tests). No-op when no pool was created. */
export async function closeDatabase(): Promise<void> {
  if (pool) {
    const closing = pool;
    pool = undefined;
    await closing.end();
  }
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

export type TestRunInput = {
  runId: string;
  branch: string;
  command: string;
  exitCode: number;
  /** e.g. sha256 of the full command output; lets a verifier re-check integrity. */
  outputHash?: string;
  /** Short tail/head excerpt of the output for display (keep small). */
  outputExcerpt?: string;
};

export type TestRunRow = {
  run_id: string;
  branch: string;
  command: string;
  exit_code: number;
  output_hash: string | null;
  output_excerpt: string | null;
  created_at: string;
};

/**
 * Record a server-stored test-pass proof (table: test_runs, migration 002).
 * Re-recording the same run_id is a no-op — the first record wins.
 */
export async function recordTestRun(input: TestRunInput): Promise<void> {
  await database().query(
    `INSERT INTO test_runs (run_id, branch, command, exit_code, output_hash, output_excerpt)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (run_id) DO NOTHING`,
    [
      input.runId,
      input.branch,
      input.command,
      input.exitCode,
      input.outputHash ?? null,
      input.outputExcerpt ?? null,
    ]
  );
}

/** Latest test runs for a branch, newest first (proof lookup / history). */
export async function listTestRuns(branch: string, limit = 20): Promise<TestRunRow[]> {
  const { rows } = await database().query<TestRunRow>(
    `SELECT run_id, branch, command, exit_code, output_hash, output_excerpt, created_at
     FROM test_runs WHERE branch = $1 ORDER BY created_at DESC LIMIT $2`,
    [branch, limit]
  );
  return rows;
}
