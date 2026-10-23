import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { cookieNames, readSession } from "../../../../lib/auth";
import { assertManagedWorkspace } from "../../../../lib/workspace";

const exec = promisify(execFile);
export const runtime = "nodejs";

export async function GET(request: Request) {
  if (!readSession(cookies().get(cookieNames().sessionCookie)?.value)) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }
  const workspace = new URL(request.url).searchParams.get("workspace");
  if (!workspace) return NextResponse.json({ error: "Workspace is required." }, { status: 400 });
  try {
    const managedWorkspace = assertManagedWorkspace(workspace);
    const result = await exec("git", ["diff", "--no-ext-diff", "--", "."], {
      cwd: managedWorkspace,
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024
    });
    return NextResponse.json({ diff: result.stdout });
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string; message?: string };
    return NextResponse.json({ error: failed.stderr || failed.message || "Diff lookup failed." }, { status: 400 });
  }
}
