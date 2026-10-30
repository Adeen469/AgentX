import type { AuthUser } from "./auth";

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
