import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { assertSameOrigin, cookieNames, readSession } from "../../../../lib/auth";
import { createWorkspace } from "../../../../lib/workspace";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const user = readSession((await cookies()).get(cookieNames().sessionCookie)?.value);
  if (!user) return NextResponse.json({ error: "Sign in before creating a workspace." }, { status: 401 });
  try {
    assertSameOrigin(request);
  } catch {
    return NextResponse.json({ error: "Cross-origin request rejected." }, { status: 403 });
  }
  const input = await request.json() as { repository?: string; issueNumber?: number };
  if (!input.repository || !/^[^/]+\/[^/]+$/.test(input.repository) || typeof input.issueNumber !== "number" || !Number.isInteger(input.issueNumber)) {
    return NextResponse.json({ error: "Repository and issue number are required." }, { status: 400 });
  }
  const issueNumber = input.issueNumber;
  try {
    return NextResponse.json(await createWorkspace(user, input.repository, issueNumber));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Workspace creation failed.";
    // On the Vercel deployment the filesystem is read-only outside /tmp,
    // so the workspace root cannot be created at all. Say so plainly
    // instead of surfacing a raw EROFS error.
    if (/EROFS|read-only file system/i.test(message)) {
      return NextResponse.json({ error: "Workspaces need a writable workspace root. Run AgentX locally (see docs/E2E-RUN.md) — the Vercel deployment cannot create workspaces." }, { status: 503 });
    }
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
