import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { cookieNames, readSession } from "../../../../lib/auth";
import { githubRequest, type GithubRepository } from "../../../../lib/github";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const user = readSession(cookies().get(cookieNames().sessionCookie)?.value);
  const query = new URL(request.url).searchParams.get("q")?.trim();
  if (!query) return NextResponse.json({ repositories: [] });
  if (query.length > 100) return NextResponse.json({ error: "Search query is too long." }, { status: 400 });
  try {
    const result = await githubRequest<{ items: GithubRepository[] }>(user, `/search/repositories?q=${encodeURIComponent(query)}&per_page=50`);
    return NextResponse.json({
      repositories: result.items.map((item) => ({
        id: item.id,
        fullName: item.full_name,
        private: item.private,
        defaultBranch: item.default_branch,
        url: item.html_url || `https://github.com/${item.full_name}`
      }))
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "GitHub repository search failed." }, { status: 502 });
  }
}
