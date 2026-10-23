import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { cookieNames, readSession } from "../../../../lib/auth";
import { githubRequest, type GithubIssue } from "../../../../lib/github";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const user = readSession(cookies().get(cookieNames().sessionCookie)?.value);
  const { searchParams } = new URL(request.url);
  const repository = searchParams.get("repository");
  if (!repository || !/^[^/]+\/[^/]+$/.test(repository)) return NextResponse.json({ error: "Use an owner/name repository." }, { status: 400 });
  try {
    const issues = await githubRequest<GithubIssue[]>(user, `/repos/${repository}/issues?state=open&per_page=50`);
    return NextResponse.json({ issues: issues.filter((issue) => !("pull_request" in issue)) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "GitHub issue lookup failed." }, { status: 502 });
  }
}
