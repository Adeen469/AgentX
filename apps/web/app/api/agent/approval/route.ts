import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { assertSameOrigin, cookieNames, readSession } from "../../../../lib/auth";
import { logApi } from "../../../../lib/agent";
import { createApproval } from "../../../../lib/approval";
import { DatabaseUnavailableError } from "../../../../lib/database";
import { getTestProofByRunId } from "../../../../lib/workspace";

export const runtime = "nodejs";

/**
 * POST /api/agent/approval — unchanged approval gate, plus optional
 * server-side test-proof verification.
 *
 * Existing behaviour is intact: explicit confirmation + action payload
 * required; open_pull_request still requires testPassed === true and a
 * non-empty diff.
 *
 * NEW (optional, backwards compatible): when the payload carries
 * `testProof: { runId, outputHash? }`, the approval is issued ONLY if a
 * stored row in `test_runs` for that runId shows exit_code 0 (and, when
 * outputHash is supplied, the stored hash matches). This binds the
 * approval to server-stored evidence instead of a client-supplied
 * testPassed flag. When testProof is absent, the legacy client-claim
 * check applies exactly as before. When testProof is present but the
 * database cannot be read, the request fails closed with 503 — an
 * unverifiable proof is never treated as verified.
 */
export async function POST(request: Request) {
  const user = readSession(cookies().get(cookieNames().sessionCookie)?.value);
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  try {
    assertSameOrigin(request);
  } catch {
    return NextResponse.json({ error: "Cross-origin request rejected." }, { status: 403 });
  }
  const input = await request.json() as { action?: "push_branch" | "open_pull_request"; payload?: Record<string, unknown>; confirmation?: boolean };
  if (!input.confirmation || !input.action || !input.payload) return NextResponse.json({ error: "Explicit confirmation and action payload are required." }, { status: 400 });
  if (input.action === "open_pull_request" && (input.payload.testPassed !== true || typeof input.payload.diff !== "string" || !input.payload.diff.trim())) {
    return NextResponse.json({ error: "A pull request approval requires a passing test and a non-empty patch." }, { status: 400 });
  }
  const testProof = input.payload.testProof as { runId?: string; outputHash?: string } | undefined;
  if (testProof && typeof testProof === "object") {
    if (typeof testProof.runId !== "string" || !testProof.runId.trim()) {
      return NextResponse.json({ error: "testProof.runId is required when a test proof is supplied." }, { status: 400 });
    }
    try {
      const stored = await getTestProofByRunId(testProof.runId.trim());
      if (!stored) {
        return NextResponse.json({ error: "No stored test proof for the supplied runId; run the tests first." }, { status: 400 });
      }
      if (stored.exit_code !== 0) {
        return NextResponse.json({ error: `Stored test proof for this run did not pass (exit_code ${stored.exit_code}).` }, { status: 400 });
      }
      if (typeof testProof.outputHash === "string" && testProof.outputHash !== stored.output_hash) {
        return NextResponse.json({ error: "Stored test proof hash does not match the supplied proof." }, { status: 400 });
      }
      logApi("/api/agent/approval", "info", "approval issued with verified test proof", {
        action: input.action,
        runId: stored.run_id,
        branch: stored.branch,
      });
    } catch (error) {
      if (error instanceof DatabaseUnavailableError) {
        return NextResponse.json({ error: "Database is not configured, so the test proof cannot be verified." }, { status: 503 });
      }
      const message = error instanceof Error ? error.message : "Test proof verification failed.";
      if (/relation .* does not exist|test_runs/i.test(message)) {
        return NextResponse.json({ error: "The test_runs table is not set up yet (run apps/web/db/002_test_runs.sql)." }, { status: 503 });
      }
      logApi("/api/agent/approval", "error", "test proof verification failed", { error: message });
      return NextResponse.json({ error: message }, { status: 502 });
    }
  }
  return NextResponse.json({ approvalToken: createApproval(user, input.action, input.payload) });
}
