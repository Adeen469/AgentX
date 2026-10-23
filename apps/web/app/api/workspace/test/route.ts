import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { cookieNames, readSession } from "../../../../lib/auth";
import { runWorkspaceTest } from "../../../../lib/workspace";

export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!readSession(cookies().get(cookieNames().sessionCookie)?.value)) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const input = await request.json() as { workspace?: string; command?: string };
  if (!input.workspace || !input.command) return NextResponse.json({ error: "Workspace and command are required." }, { status: 400 });
  try {
    return NextResponse.json(await runWorkspaceTest(input.workspace, input.command));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Test execution failed." }, { status: 400 });
  }
}
