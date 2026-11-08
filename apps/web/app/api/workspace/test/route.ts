import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { assertSameOrigin, cookieNames, readSession } from "../../../../lib/auth";
import { logApi } from "../../../../lib/agent";
import { DatabaseUnavailableError } from "../../../../lib/database";
import {
  getTestProofByRunId,
  getTestProofsForBranch,
  runWorkspaceTest,
  storeTestProof,
} from "../../../../lib/workspace";

export const runtime = "nodejs";

/**
 * POST /api/workspace/test — run an allowlisted test command in the Docker
 * sandbox, then store a server-side test-pass proof in `test_runs` and
 * return it alongside the test result.
 *
 * Body: { workspace, command, branch?, runId? }
 * - `branch` is the agent branch under test (e.g. "agentx/issue-3"); the
 *   frontend already knows it. When omitted the proof is stored under
 *   branch "unknown" — pass it whenever the branch is known.
 * - `runId` is a caller-supplied unique id for this execution; one is
 *   generated (`run-<uuid>`) when omitted. Reusing an id is a silent
 *   no-op in the table (ON CONFLICT DO NOTHING), so never reuse ids.
 * - Response: { command, passed, exitCode, stdout, stderr, sandboxed,
 *   image, proof: { runId, branch, command, exitCode, passed, outputHash,
 *   outputExcerpt, stored, storedError? } }
 * - When the database is unavailable the test result is still returned
 *   (HTTP 200) with proof.stored === false and proof.storedError set:
 *   the test ran, but NO server-side proof exists, so the approval gate
 *   must not treat the client's "passed" claim as proven. Proof storage
 *   failing must never hide a test result, and must never be reported as
 *   stored when it was not.
 */
export async function POST(request: Request) {
  if (!readSession(cookies().get(cookieNames().sessionCookie)?.value)) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  try {
    assertSameOrigin(request);
  } catch {
    return NextResponse.json({ error: "Cross-origin request rejected." }, { status: 403 });
  }
  const input = await request.json() as { workspace?: string; command?: string; branch?: string; runId?: string };
  if (!input.workspace || !input.command) return NextResponse.json({ error: "Workspace and command are required." }, { status: 400 });
  try {
    const result = await runWorkspaceTest(input.workspace, input.command);
    const branch = input.branch?.trim() || "unknown";
    const proof = await storeTestProof({ runId: input.runId?.trim() || undefined, branch, result });
    logApi("/api/workspace/test", "info", "test run finished", {
      branch,
      runId: proof.runId,
      command: result.command,
      passed: result.passed,
      exitCode: result.exitCode,
      proofStored: proof.stored,
    });
    if (!proof.stored) {
      logApi("/api/workspace/test", "warn", "test proof NOT stored", {
        branch,
        runId: proof.runId,
        storedError: proof.storedError ?? null,
      });
    }
    return NextResponse.json({ ...result, proof });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Test execution failed.";
    // Docker / sandbox infrastructure failures are not test failures and
    // must not be mistaken for one: report them as unavailable, and never
    // let the caller retry them as a host run.
    const status = /docker|sandbox/i.test(message) ? 503 : 400;
    logApi("/api/workspace/test", "error", "test run failed", { error: message });
    return NextResponse.json({ error: message }, { status });
  }
}

/**
 * GET /api/workspace/test?runId=<id> | ?branch=<branch>&limit=<n>
 * Fetch stored test-pass proofs. Exactly one of runId / branch is required.
 * - runId: the single stored proof for that execution, or 404.
 * - branch: latest proofs for the branch, newest first (default limit 20).
 * Returns 503 with a clear message when the database is not configured
 * or unreachable — never a crash, never an empty list pretending no
 * proofs exist.
 */
export async function GET(request: Request) {
  if (!readSession(cookies().get(cookieNames().sessionCookie)?.value)) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const params = new URL(request.url).searchParams;
  const runId = params.get("runId")?.trim();
  const branch = params.get("branch")?.trim();
  if (!runId && !branch) {
    return NextResponse.json({ error: "Provide runId or branch." }, { status: 400 });
  }
  try {
    if (runId) {
      const proof = await getTestProofByRunId(runId);
      if (!proof) return NextResponse.json({ error: "No stored test proof for this run." }, { status: 404 });
      return NextResponse.json({ proof });
    }
    const limitRaw = Number(params.get("limit") || "20");
    const limit = Number.isInteger(limitRaw) && limitRaw > 0 && limitRaw <= 100 ? limitRaw : 20;
    const proofs = await getTestProofsForBranch(branch as string, limit);
    return NextResponse.json({ branch, proofs });
  } catch (error) {
    if (error instanceof DatabaseUnavailableError) {
      return NextResponse.json({ error: "Database is not configured, so stored test proofs are unavailable." }, { status: 503 });
    }
    const message = error instanceof Error ? error.message : "Test proof lookup failed.";
    // A missing table (migration 002 not run yet) is a configuration
    // failure, not a proof: surface it as 503, never as "no proofs".
    if (/relation .* does not exist|test_runs/i.test(message)) {
      return NextResponse.json({ error: "The test_runs table is not set up yet (run apps/web/db/002_test_runs.sql)." }, { status: 503 });
    }
    logApi("/api/workspace/test", "error", "test proof lookup failed", { error: message });
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
