import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { assertSameOrigin, cookieNames, readSession } from "../../../../lib/auth";
import { createAgentFix, logApi, type AgentPlan } from "../../../../lib/agent";

export const runtime = "nodejs";

/**
 * POST /api/agent/fix — have the AI write the fix for an issue into an
 * isolated workspace.
 *
 * Body: { workspace, repository?, issueTitle, issueBody?, plan? }
 * - `plan` is the AgentPlan from POST /api/agent/plan; its likelyFiles
 *   decide which files are sent to the model (at most 5, each ≤ 20KB).
 * - The model returns ONLY a unified diff. The server validates it
 *   (paths inside the workspace, no renames, `git apply --check`) and
 *   applies it with `git apply` — a patch that does not apply cleanly
 *   is rejected, never half-applied.
 * - Response: { diff, filesChanged, provider, fallbackUsed }. The diff
 *   still goes through the human review page and the approval gate
 *   before any branch push or pull request; this endpoint never merges
 *   or opens a PR.
 * - 503 when no AI provider is configured or all of them fail; 400
 *   when no planned file could be read or the model returned no usable
 *   patch.
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
    repository?: string;
    issueTitle?: string;
    issueBody?: string;
    plan?: AgentPlan;
  };
  if (!input.workspace || !input.issueTitle?.trim()) {
    return NextResponse.json({ error: "Workspace and issue title are required." }, { status: 400 });
  }
  try {
    const result = await createAgentFix({
      workspace: input.workspace,
      repository: input.repository,
      issueTitle: input.issueTitle.trim(),
      issueBody: input.issueBody || "",
      plan: input.plan,
    });
    logApi("/api/agent/fix", "info", "AI fix applied", {
      repository: input.repository ?? null,
      filesChanged: result.filesChanged.length,
      provider: result.provider,
    });
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "AI fix failed.";
    logApi("/api/agent/fix", "error", "AI fix failed", {
      repository: input.repository ?? null,
      error: message,
    });
    const status = /No AI provider is configured|All configured AI providers failed/.test(message) ? 503 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
