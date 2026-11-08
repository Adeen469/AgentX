import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { assertSameOrigin, cookieNames, readSession } from "../../../../lib/auth";
import { attemptReproduction, logApi } from "../../../../lib/agent";
import { ALLOWED_TEST_COMMANDS } from "../../../../lib/sandbox";

export const runtime = "nodejs";

/**
 * POST /api/agent/repro — run the autonomous reproduction step against an
 * existing isolated workspace and return the captured evidence.
 *
 * Body: { workspace, command?, issueTitle?, issueBody?, repository? }
 * - `command` must be an exact allowlisted command (default "npm test");
 *   anything else is rejected 400 — issue text never supplies a raw command.
 * - The response is ALWAYS the ReproAttempt object (HTTP 200): the
 *   `status` field carries the outcome — "reproduced" | "not-reproduced" |
 *   "not-run". A "not-run" status (Docker absent, workspace problem) is
 *   an honest report, not an endpoint failure, so it is not a 5xx; the
 *   caller must check `status` and must never treat "not-run" as a repro.
 */
export async function POST(request: Request) {
  const user = readSession((await cookies()).get(cookieNames().sessionCookie)?.value);
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  try {
    assertSameOrigin(request);
  } catch {
    return NextResponse.json({ error: "Cross-origin request rejected." }, { status: 403 });
  }
  const input = await request.json() as {
    workspace?: string;
    command?: string;
    issueTitle?: string;
    issueBody?: string;
    repository?: string;
  };
  if (!input.workspace) return NextResponse.json({ error: "Workspace is required." }, { status: 400 });
  if (input.command && !ALLOWED_TEST_COMMANDS.has(input.command)) {
    return NextResponse.json({ error: "Test command is not allowlisted." }, { status: 400 });
  }
  const reproduction = await attemptReproduction({
    repository: input.repository,
    issueTitle: input.issueTitle,
    issueBody: input.issueBody,
    workspace: input.workspace,
    command: input.command,
  });
  logApi("/api/agent/repro", "info", "reproduction attempted", {
    repository: input.repository ?? null,
    reproStatus: reproduction.status,
    reproCommand: reproduction.command,
    reproExitCode: reproduction.exitCode,
    sandboxBackend: reproduction.sandboxBackend ?? null,
    dockerAvailable: reproduction.dockerAvailable,
  });
  return NextResponse.json(reproduction);
}
