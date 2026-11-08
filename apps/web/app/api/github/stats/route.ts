import { NextResponse } from "next/server";
import { getPublicRepoStats, GITHUB_STATS_REPO } from "../../../../lib/github";
import { logApi } from "../../../../lib/agent";

export const runtime = "nodejs";

/**
 * GET /api/github/stats — public repository stats for the landing page.
 * No auth required: Adeen469/AgentX is a public repository.
 *
 * Response shape (repo/commit field names are the ones the landing page
 * already renders; the three metadata fields are new):
 * {
 *   repo: { full_name, html_url, description, stargazers_count,
 *           forks_count, open_issues_count, updated_at } | null,
 *   commits: [{ sha, html_url, commit: { message, author: { name, date } } }],
 *   cached: boolean,   // true when served from the 10-minute server cache
 *   stale: boolean,    // true when the cache is past TTL and a fresh GitHub
 *                      // fetch failed — data is the last good copy
 *   fetchedAt: string  // ISO timestamp of the data served
 * }
 * Old behaviour (no endpoint existed): the landing page fetched
 * api.github.com directly, unauthenticated, with no token, no shared
 * cache and no stale fallback — so a 403 rate-limit on Vercel's shared
 * egress IPs rendered "Live GitHub stats are unavailable right now".
 * New behaviour: this endpoint caches for 10 minutes, serves stale data
 * on GitHub failure, and uses GITHUB_TOKEN / GITHUB_STATS_TOKEN when set
 * (5,000 req/hr instead of 60/hr unauthenticated). It returns 503 with
 * { error, repo: null, commits: [] } only when GitHub fails AND no
 * cached copy exists. The token, when set, is never in the response.
 */
export async function GET() {
  try {
    const stats = await getPublicRepoStats(GITHUB_STATS_REPO);
    const response = NextResponse.json(stats);
    response.headers.set("Cache-Control", "public, s-maxage=600, stale-while-revalidate=600");
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : "GitHub stats lookup failed.";
    logApi("/api/github/stats", "error", "github stats unavailable", { error: message });
    return NextResponse.json(
      { error: "GitHub stats are unavailable right now.", repo: null, commits: [], cached: false, stale: false, fetchedAt: new Date().toISOString() },
      { status: 503 },
    );
  }
}
