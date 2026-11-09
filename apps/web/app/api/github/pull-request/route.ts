import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { assertSameOrigin, cookieNames, readSession, type AuthUser } from "../../../../lib/auth";
import { verifyApproval } from "../../../../lib/approval";
import { githubRequest } from "../../../../lib/github";

const exec = promisify(execFile);
export const runtime = "nodejs";

/** The repo's real default branch (not a hardcoded "main") — a repo
 *  whose default branch is `master` or `develop` would otherwise fail
 *  PR creation with a 422. Falls back to "main" when GitHub cannot be
 *  reached for the lookup. */
async function defaultBranch(user: AuthUser, repository: string): Promise<string> {
  try {
    const repo = await githubRequest<{ default_branch?: string }>(user, `/repos/${repository}`);
    return repo.default_branch || "main";
  } catch {
    return "main";
  }
}

async function githubLogin(user: AuthUser): Promise<string> {
  if (user.login) return user.login;
  const profile = await githubRequest<{ login: string }>(user, "/user");
  return profile.login;
}

/** Push a branch, retrying once after a short wait (used for a fresh
 *  fork, which GitHub creates asynchronously and may not accept a push
 *  in the first seconds). */
async function pushWithRetry(args: string[], cwd: string, attempts = 3): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      await exec("git", args, { cwd, windowsHide: true, timeout: 120000 });
      return;
    } catch (error) {
      lastError = error;
      if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
  throw lastError;
}

export async function POST(request: Request) {
  const user = readSession((await cookies()).get(cookieNames().sessionCookie)?.value);
  if (!user?.githubAccessToken) return NextResponse.json({ error: "GitHub authorization required." }, { status: 401 });
  try {
    assertSameOrigin(request);
  } catch {
    return NextResponse.json({ error: "Cross-origin request rejected." }, { status: 403 });
  }
  const input = await request.json() as { approvalToken?: string };
  if (!input.approvalToken) return NextResponse.json({ error: "Human approval is required." }, { status: 400 });
  try {
    const payload = verifyApproval(input.approvalToken, user, "open_pull_request") as { workspace: string; repository: string; branch: string; base?: string; title: string; body: string; testPassed?: boolean; diff?: string };
    if (payload.testPassed !== true || typeof payload.diff !== "string" || !payload.diff.trim()) {
      throw new Error("Approval does not cover a passing test and a non-empty patch. Re-run the tests and re-approve.");
    }
    if (!/^[^/]+\/[^/]+$/.test(payload.repository) || !/^[A-Za-z0-9._/-]+$/.test(payload.branch)) throw new Error("Invalid pull request payload.");
    const base = payload.base?.trim() || (await defaultBranch(user, payload.repository));
    const pushArgs = ["-c", `http.extraheader=AUTHORIZATION: bearer ${user.githubAccessToken}`, "push", "origin", payload.branch];
    let head = payload.branch;
    let forked = false;
    try {
      await pushWithRetry(pushArgs, payload.workspace, 1);
    } catch (error) {
      const output = `${(error as { stderr?: string }).stderr || ""} ${(error as Error).message || ""}`;
      if (!/403|permission denied|forbidden/i.test(output)) throw error;
      // No push access to the owner's repo: fork it, push the branch to
      // the fork, and open the PR from the fork. The approval still
      // covers this action — only the head repository changes.
      const login = await githubLogin(user);
      const fork = await githubRequest<{ clone_url: string; full_name: string }>(user, `/repos/${payload.repository}/forks`, { method: "POST" });
      try {
        await exec("git", ["remote", "add", "agentx-fork", fork.clone_url], { cwd: payload.workspace, windowsHide: true, timeout: 30000 });
      } catch {
        // Remote already exists from an earlier attempt — reuse it.
      }
      await pushWithRetry(
        ["-c", `http.extraheader=AUTHORIZATION: bearer ${user.githubAccessToken}`, "push", "agentx-fork", payload.branch],
        payload.workspace,
      );
      head = `${login}:${payload.branch}`;
      forked = true;
    }
    const pr = await githubRequest<{ html_url: string; number: number }>(user, `/repos/${payload.repository}/pulls`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: payload.title, body: payload.body, head, base })
    });
    return NextResponse.json({ pullRequest: pr, forked });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Pull request creation failed." }, { status: 400 });
  }
}
