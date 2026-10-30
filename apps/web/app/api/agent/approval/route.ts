import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { cookieNames, readSession } from "../../../../lib/auth";
import { createApproval } from "../../../../lib/approval";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const user = readSession(cookies().get(cookieNames().sessionCookie)?.value);
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const input = await request.json() as { action?: "push_branch" | "open_pull_request"; payload?: Record<string, unknown>; confirmation?: boolean };
  if (!input.confirmation || !input.action || !input.payload) return NextResponse.json({ error: "Explicit confirmation and action payload are required." }, { status: 400 });
  if (input.action === "open_pull_request" && (input.payload.testPassed !== true || typeof input.payload.diff !== "string" || !input.payload.diff.trim())) {
    return NextResponse.json({ error: "A pull request approval requires a passing test and a non-empty patch." }, { status: 400 });
  }
  return NextResponse.json({ approvalToken: createApproval(user, input.action, input.payload) });
}
