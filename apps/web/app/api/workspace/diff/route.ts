import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { cookieNames, readSession } from "../../../../lib/auth";
import { logApi } from "../../../../lib/agent";
import { assertManagedWorkspace, getTestProofsForBranch } from "../../../../lib/workspace";

const exec = promisify(execFile);
export const runtime = "nodejs";

/**
 * GET /api/workspace/diff?workspace=<path>&branch=<branch>
 * Returns { diff, testProofs, testProofsStored }.
 * - `testProofs` is the review UI's evidence: the latest server-stored
 *   test runs for `branch` (newest first), each with run_id, command,
 *   exit_code, output_hash, output_excerpt, created_at. The Frontend
 *   agent should pass branch (e.g. "agentx/issue-3") and render the
 *   latest proof's exit_code/output_hash next to the diff.
 * - `testProofsStored` is false when no branch was supplied or the
 *   database is unavailable; the diff itself is still returned in that
 *   case — a missing proof store must never hide the patch. An empty
 *   testProofs array with testProofsStored === false means "unknown",
 *   NOT "no tests passed".
 */
export async function GET(request: Request) {
  if (!readSession((await cookies()).get(cookieNames().sessionCookie)?.value)) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }
  const params = new URL(request.url).searchParams;
  const workspace = params.get("workspace");
  const branch = params.get("branch")?.trim();
  if (!workspace) return NextResponse.json({ error: "Workspace is required." }, { status: 400 });
  try {
    const managedWorkspace = assertManagedWorkspace(workspace);
    const result = await exec("git", ["diff", "--no-ext-diff", "--", "."], {
      cwd: managedWorkspace,
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024
    });
    let testProofs: Awaited<ReturnType<typeof getTestProofsForBranch>> = [];
    let testProofsStored = false;
    if (branch) {
      try {
        testProofs = await getTestProofsForBranch(branch, 5);
        testProofsStored = true;
      } catch (error) {
        // Proof lookup is best-effort here: the diff is the primary
        // payload and must still be returned. Log it so a broken proof
        // store is visible instead of silently empty.
        logApi("/api/workspace/diff", "warn", "test proof lookup failed", {
          branch,
          error: error instanceof Error ? error.message : "lookup failed",
        });
      }
    }
    return NextResponse.json({ diff: result.stdout, testProofs, testProofsStored });
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string; message?: string };
    return NextResponse.json({ error: failed.stderr || failed.message || "Diff lookup failed." }, { status: 400 });
  }
}
