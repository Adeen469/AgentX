import type { AuthUser } from "./auth";

export interface GithubRepository {
  id: number;
  full_name: string;
  default_branch: string;
  clone_url: string;
  private: boolean;
  html_url?: string;
}

export interface GithubIssue {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  state: string;
}

// ---------------------------------------------------------------------------
// Public repository stats for the landing page.
//
// ROOT CAUSE of "Live GitHub stats are unavailable right now" (verified
// 2026-11-08): the landing page fetched api.github.com directly, WITHOUT
// any token. Unauthenticated GitHub API calls are limited to 60 requests
// per hour PER EGRESS IP — and Vercel serverless functions share egress
// IPs across many deployments, so the quota is routinely exhausted by
// other tenants. A 403 rate-limit response made repoRes.ok false, the
// page rendered repo: null, and there was no cached/stale fallback and
// no token to raise the limit. The failure is intermittent: the same
// fetch succeeds from an IP with quota left (confirmed live 2026-11-08,
// stats rendered 1 star / 1 fork / 0 open issues from this VM's IP).
//
// FIX (this module + GET /api/github/stats):
// - Server-side in-memory cache, TTL 10 minutes, shared across requests
//   in the same function instance, so one live fetch serves many renders.
// - Stale-while-error: when GitHub fails or rate-limits, the last good
//   data is served with stale: true instead of showing nothing.
// - Optional GITHUB_TOKEN / GITHUB_STATS_TOKEN (a fine-grained PAT with
//   public-repo read-only scope, or any token with repo read): raises the
//   limit from 60/hr to 5,000/hr. The token is sent only server-side and
//   never appears in any response or log.
// - 8s timeout so a slow GitHub never hangs the landing page.
// The frontend should call GET /api/github/stats (same repo/commit field
// names the page already renders) instead of api.github.com directly.
// ---------------------------------------------------------------------------

/** Field names match the landing page's RepoData type exactly. */
export interface PublicRepoStats {
  full_name: string;
  html_url: string;
  description: string | null;
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  updated_at: string;
}

/** Field names match the landing page's CommitData type exactly. */
export interface PublicCommit {
  sha: string;
  html_url: string;
  commit: { message: string; author: { name: string; date: string } };
}

export interface PublicStatsResult {
  repo: PublicRepoStats | null;
  commits: PublicCommit[];
  /** True when this response came from the in-memory cache. */
  cached: boolean;
  /** True when the data is older than the TTL and a fresh fetch failed. */
  stale: boolean;
  fetchedAt: string;
}

export const GITHUB_STATS_TTL_MS = 10 * 60 * 1000;
export const GITHUB_STATS_REPO = "Adeen469/AgentX";

const statsCache = new Map<string, { data: PublicStatsResult; fetchedAtMs: number }>();

function githubStatsToken(): string | undefined {
  const token = process.env.GITHUB_TOKEN?.trim() || process.env.GITHUB_STATS_TOKEN?.trim();
  return token || undefined;
}

function githubStatsHeaders(): HeadersInit {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "AgentX",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const token = githubStatsToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function fetchJsonWithTimeout<T>(url: string, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers: githubStatsHeaders(), signal: controller.signal });
    if (response.status === 403) {
      const remaining = response.headers.get("x-ratelimit-remaining");
      throw new Error(
        remaining === "0"
          ? "GitHub API rate limit exhausted (unauthenticated limit is 60 requests/hour per egress IP; set GITHUB_TOKEN to raise it to 5,000/hour)."
          : "GitHub API request was forbidden (403).",
      );
    }
    if (response.status === 404) throw new Error("GitHub repository was not found (404).");
    if (!response.ok) throw new Error(`GitHub API request failed with status ${response.status}.`);
    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("GitHub API request timed out.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function getPublicRepoStats(
  repository: string = GITHUB_STATS_REPO,
): Promise<PublicStatsResult> {
  const nowMs = Date.now();
  const cached = statsCache.get(repository);
  if (cached && nowMs - cached.fetchedAtMs < GITHUB_STATS_TTL_MS) {
    return { ...cached.data, cached: true, stale: false };
  }
  try {
    const [repo, commits] = await Promise.all([
      fetchJsonWithTimeout<PublicRepoStats>(`https://api.github.com/repos/${repository}`, 8_000),
      // Commits are best-effort: a repo card without commits is still
      // useful, so a commits failure degrades to [] instead of failing
      // the whole stats response.
      fetchJsonWithTimeout<PublicCommit[]>(
        `https://api.github.com/repos/${repository}/commits?per_page=5`,
        8_000,
      ).catch(() => [] as PublicCommit[]),
    ]);
    const fresh: PublicStatsResult = {
      repo,
      commits,
      cached: false,
      stale: false,
      fetchedAt: new Date(nowMs).toISOString(),
    };
    statsCache.set(repository, { data: fresh, fetchedAtMs: nowMs });
    return fresh;
  } catch (error) {
    // Stale-while-error: serve the last good data rather than nothing.
    if (cached) {
      return { ...cached.data, cached: true, stale: true };
    }
    throw error;
  }
}

function githubHeaders(user?: AuthUser | null): HeadersInit {
  if (!user?.githubAccessToken) return { accept: "application/vnd.github+json", "user-agent": "AgentX" };
  return { accept: "application/vnd.github+json", authorization: `Bearer ${user.githubAccessToken}`, "user-agent": "AgentX" };
}

export async function githubRequest<T>(user: AuthUser | null, endpoint: string, init?: RequestInit): Promise<T> {
  let response = await fetch(`https://api.github.com${endpoint}`, {
    ...init,
    headers: { ...githubHeaders(user), ...(init?.headers || {}) }
  });
  if (response.status === 401) {
    // Do not fall back to an unauthenticated request here: it would return
    // public data (or an empty list) and hide the fact that the saved token
    // was rejected, so a later private-repo, clone, or PR step would fail
    // with no clear cause. Surface the expired token now.
    throw new Error(user?.githubAccessToken
      ? "GitHub authorization was rejected or expired. Sign out and reconnect GitHub."
      : "This repository requires GitHub authorization.");
  }
  if (response.status === 403) {
    throw new Error("GitHub rate limit or permission denied. Connect GitHub and try again.");
  }
  if (!response.ok) throw new Error(`GitHub request failed with status ${response.status}.`);
  return response.json() as Promise<T>;
}
