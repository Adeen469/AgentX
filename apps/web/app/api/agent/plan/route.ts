import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { assertSameOrigin, cookieNames, readSession } from "../../../../lib/auth";
import { attemptReproduction, createAgentPlan, logApi } from "../../../../lib/agent";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const user = readSession((await cookies()).get(cookieNames().sessionCookie)?.value);
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  try {
    assertSameOrigin(request);
  } catch {
    return NextResponse.json({ error: "Cross-origin request rejected." }, { status: 403 });
  }
  const input = await request.json() as {
    issueTitle?: string;
    issueBody?: string;
    repository?: string;
    /** Optional: an existing isolated workspace to reproduce against. */
    workspace?: string;
    /** Optional: an exact allowlisted repro command (default "npm test"). */
    command?: string;
  };
  if (!input.issueTitle?.trim()) return NextResponse.json({ error: "Issue title is required." }, { status: 400 });

  // Autonomous reproduction FIRST: run the allowlisted command sandboxed
  // and attach the observed result to the plan. A repro that cannot run
  // (no workspace yet, Docker absent) is recorded as status "not-run" —
  // it never blocks planning and is never upgraded into a claimed repro.
  const reproduction = await attemptReproduction({
    repository: input.repository,
    issueTitle: input.issueTitle.trim(),
    issueBody: input.issueBody || "",
    workspace: input.workspace,
    command: input.command,
  });
  logApi("/api/agent/plan", "info", "reproduction attempted", {
    repository: input.repository ?? null,
    reproStatus: reproduction.status,
    reproCommand: reproduction.command,
    reproExitCode: reproduction.exitCode,
    dockerAvailable: reproduction.dockerAvailable,
  });

  try {
    const result = await createAgentPlan({
      repository: input.repository,
      issueTitle: input.issueTitle.trim(),
      issueBody: input.issueBody || "",
      reproduction,
    });
    return NextResponse.json({ ...result, reproduction });
  } catch (error) {
    const message = error instanceof Error ? error.message : "All configured AI providers failed.";
    logApi("/api/agent/plan", "error", "plan failed", { repository: input.repository ?? null, error: message });
    return NextResponse.json({
      error: message,
      reproduction,
    }, { status: 503 });
  }
}
