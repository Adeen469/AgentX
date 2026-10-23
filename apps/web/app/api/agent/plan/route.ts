import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { cookieNames, readSession } from "../../../../lib/auth";
import { createAgentPlan } from "../../../../lib/agent";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const user = readSession(cookies().get(cookieNames().sessionCookie)?.value);
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const input = await request.json() as { issueTitle?: string; issueBody?: string; repository?: string };
  if (!input.issueTitle?.trim()) return NextResponse.json({ error: "Issue title is required." }, { status: 400 });
  try {
    return NextResponse.json(await createAgentPlan({
      repository: input.repository,
      issueTitle: input.issueTitle.trim(),
      issueBody: input.issueBody || ""
    }));
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : "All configured AI providers failed."
    }, { status: 503 });
  }
}
