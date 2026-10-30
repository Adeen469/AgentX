import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { cookieNames, readSession } from "../../../../lib/auth";
import { verifyApproval } from "../../../../lib/approval";
import { githubRequest } from "../../../../lib/github";

const exec = promisify(execFile);
export const runtime = "nodejs";

export async function POST(request: Request) {
  const user = readSession(cookies().get(cookieNames().sessionCookie)?.value);
  if (!user?.githubAccessToken) return NextResponse.json({ error: "GitHub authorization required." }, { status: 401 });
  const input = await request.json() as { approvalToken?: string };
  if (!input.approvalToken) return NextResponse.json({ error: "Human approval is required." }, { status: 400 });
  try {
    const payload = verifyApproval(input.approvalToken, user, "open_pull_request") as { workspace: string; repository: string; branch: string; base?: string; title: string; body: string; testPassed?: boolean; diff?: string };
    if (payload.testPassed !== true || typeof payload.diff !== "string" || !payload.diff.trim()) {
      throw new Error("Approval does not cover a passing test and a non-empty patch. Re-run the tests and re-approve.");
    }
    if (!/^[^/]+\/[^/]+$/.test(payload.repository) || !/^[A-Za-z0-9._/-]+$/.test(payload.branch)) throw new Error("Invalid pull request payload.");
    await exec("git", ["-c", `http.extraheader=AUTHORIZATION: bearer ${user.githubAccessToken}`, "push", "origin", payload.branch], { cwd: payload.workspace, windowsHide: true, timeout: 120000 });
    const pr = await githubRequest<{ html_url: string; number: number }>(user, `/repos/${payload.repository}/pulls`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: payload.title, body: payload.body, head: payload.branch, base: payload.base || "main" })
    });
    return NextResponse.json({ pullRequest: pr });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Pull request creation failed." }, { status: 400 });
  }
}
