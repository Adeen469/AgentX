import { execFile } from "node:child_process";
import { NextResponse } from "next/server";
import { promisify } from "node:util";
import { logApi } from "../../../lib/agent";
import { tryDatabase } from "../../../lib/database";

export const runtime = "nodejs";

const exec = promisify(execFile);

type CheckState = "ok" | "unavailable";

/**
 * GET /api/health — no auth, no secrets in the response.
 * Returns { status: "ok" | "degraded",
 *           checks: { database, github, docker },
 *           checkedAt: string (ISO) }.
 * - status is "ok" only when every check is ok, otherwise "degraded".
 * - database: "ok" when a SELECT 1 succeeds within 2s; "unavailable"
 *   when DATABASE_URL is unset, the table/connection fails, or the check
 *   times out. A missing DATABASE_URL never crashes this endpoint.
 * - github: "ok" when api.github.com answers the rate-limit endpoint
 *   within 3s (any HTTP status below 500 means the service is reachable);
 *   "unavailable" on network failure or timeout.
 * - docker: "ok" when `docker info` exits 0 within 3s; "unavailable"
 *   when Docker is not installed, the daemon is down, or the check times
 *   out. On the Vercel deployment this is expected to be "unavailable".
 * Every check has a fast timeout so /api/health itself never hangs.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function checkDatabase(): Promise<CheckState> {
  const pool = tryDatabase();
  if (!pool) return "unavailable";
  try {
    await withTimeout(pool.query("SELECT 1"), 2_000, "database check");
    return "ok";
  } catch {
    return "unavailable";
  }
}

async function checkGithub(): Promise<CheckState> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3_000);
    try {
      const response = await withTimeout(
        fetch("https://api.github.com/rate_limit", {
          headers: { Accept: "application/vnd.github+json", "User-Agent": "AgentX" },
          signal: controller.signal,
        }),
        3_000,
        "github check",
      );
      return response.status < 500 ? "ok" : "unavailable";
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return "unavailable";
  }
}

async function checkDocker(): Promise<CheckState> {
  try {
    await withTimeout(
      exec("docker", ["info", "--format", "{{.ServerVersion}}"], {
        timeout: 3_000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      }),
      3_000,
      "docker check",
    );
    return "ok";
  } catch {
    return "unavailable";
  }
}

export async function GET() {
  const [database, github, docker] = await Promise.all([
    checkDatabase(),
    checkGithub(),
    checkDocker(),
  ]);
  const checks = { database, github, docker };
  const status = Object.values(checks).every((value) => value === "ok") ? "ok" : "degraded";
  logApi("/api/health", "info", "health check", { ...checks, status });
  return NextResponse.json({ status, checks, checkedAt: new Date().toISOString() });
}
