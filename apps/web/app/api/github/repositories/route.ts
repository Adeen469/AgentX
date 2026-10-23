import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { cookieNames, readSession } from "../../../../lib/auth";

export const runtime = "nodejs";

export async function GET() {
  const user = readSession(cookies().get(cookieNames().sessionCookie)?.value);
  if (!user?.githubAccessToken) return NextResponse.json({ error: "GitHub authorization required." }, { status: 401 });
  const response = await fetch("https://api.github.com/user/repos?sort=updated&per_page=50", {
    headers: { accept: "application/vnd.github+json", authorization: `Bearer ${user.githubAccessToken}`, "user-agent": "AgentX" }
  });
  if (!response.ok) return NextResponse.json({ error: "GitHub repository lookup failed." }, { status: response.status });
  const repositories = await response.json() as Array<{ id: number; full_name: string; private: boolean; default_branch: string; html_url: string }>;
  return NextResponse.json({ repositories: repositories.map(({ id, full_name, private: isPrivate, default_branch, html_url }) => ({ id, fullName: full_name, private: isPrivate, defaultBranch: default_branch, url: html_url })) });
}
