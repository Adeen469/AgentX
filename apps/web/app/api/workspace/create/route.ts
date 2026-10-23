import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { cookieNames, readSession } from "../../../../lib/auth";
import { createWorkspace } from "../../../../lib/workspace";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const user = readSession(cookies().get(cookieNames().sessionCookie)?.value);
  if (!user) return NextResponse.json({ error: "Sign in before creating a workspace." }, { status: 401 });
  const input = await request.json() as { repository?: string; issueNumber?: number };
  if (!input.repository || !/^[^/]+\/[^/]+$/.test(input.repository) || typeof input.issueNumber !== "number" || !Number.isInteger(input.issueNumber)) {
    return NextResponse.json({ error: "Repository and issue number are required." }, { status: 400 });
  }
  const issueNumber = input.issueNumber;
  try {
    return NextResponse.json(await createWorkspace(user, input.repository, issueNumber));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Workspace creation failed." }, { status: 502 });
  }
}
