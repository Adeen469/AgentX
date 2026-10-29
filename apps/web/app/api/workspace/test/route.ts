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
    const message = error instanceof Error ? error.message : "Test execution failed.";
    // Docker / sandbox infrastructure failures are not test failures and
    // must not be mistaken for one: report them as unavailable, and never
    // let the caller retry them as a host run.
    const status = /docker|sandbox/i.test(message) ? 503 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
