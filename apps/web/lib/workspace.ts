import { execFile } from "node:child_process";
import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { AuthUser } from "./auth";
import { githubRequest, type GithubIssue, type GithubRepository } from "./github";

const exec = promisify(execFile);

export function workspaceRoot() {
  return path.resolve(process.env.WORKSPACE_ROOT || path.join(process.cwd(), "workspaces"));
}

function safeRepositoryName(repository: string) {
  if (!/^[^/]+\/[^/]+$/.test(repository)) throw new Error("Invalid repository name.");
  return repository.replace("/", "__");
}

export async function createWorkspace(user: AuthUser, repository: string, issueNumber: number) {
  const repo = await githubRequest<GithubRepository>(user, `/repos/${repository}`);
  const issue = await githubRequest<GithubIssue>(user, `/repos/${repository}/issues/${issueNumber}`);
  const root = workspaceRoot();
  await mkdir(root, { recursive: true });
  const target = path.join(root, `${safeRepositoryName(repository)}-${Date.now()}`);
  if (repo.private && !user.githubAccessToken) {
    throw new Error("This is a private repository. Connect GitHub with access to it before creating a workspace.");
  }
  try {
    const cloneArgs = ["clone", "--depth", "1", "--branch", repo.default_branch, repo.clone_url, target];
    if (repo.private && user.githubAccessToken) {
      cloneArgs.unshift(`http.extraheader=AUTHORIZATION: bearer ${user.githubAccessToken}`, "-c");
    }
    await exec("git", cloneArgs, { windowsHide: true });
  } catch (error) {
    const failed = error as { stderr?: string; message?: string };
    const output = `${failed.stderr || ""} ${failed.message || ""}`;
    if (/authentication failed|invalid credentials|could not read Username|remote: forbidden/i.test(output)) {
      throw new Error("GitHub rejected the saved access token while cloning. Sign out, reconnect GitHub, and try again.");
    }
    throw error;
  }
  const resolvedRoot = await realpath(root);
  const resolvedTarget = await realpath(target);
  if (!resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error("Workspace escaped configured root.");
  await exec("git", ["checkout", "-b", `agentx/issue-${issueNumber}`], { cwd: target, windowsHide: true });
  return { workspace: target, repository, issue: { number: issue.number, title: issue.title, body: issue.body, url: issue.html_url } };
}

export function assertManagedWorkspace(workspace: string) {
  const root = path.resolve(workspace);
  const managedRoot = workspaceRoot();
  if (!root.startsWith(`${managedRoot}${path.sep}`)) throw new Error("Workspace is outside the configured workspace root.");
  return root;
}

export function safeWorkspacePath(workspace: string, filePath: string) {
  const root = assertManagedWorkspace(workspace);
  const target = path.resolve(root, filePath);
  if (!target.startsWith(`${root}${path.sep}`)) throw new Error("File path escapes workspace.");
  return target;
}

export async function runWorkspaceTest(workspace: string, command: string) {
  assertManagedWorkspace(workspace);
  const allowed = new Set(["npm test", "npm run test", "npm run lint", "pytest", "dotnet test", "cargo test", "go test ./..."]);
  if (!allowed.has(command)) throw new Error("Test command is not allowlisted.");
  const [executable, ...args] = command.split(" ");
  try {
    const result = await exec(executable, args, { cwd: workspace, windowsHide: true, timeout: 10 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 });
    return { command, passed: true, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string; message?: string };
    return { command, passed: false, stdout: failed.stdout || "", stderr: failed.stderr || failed.message || "Test failed." };
  }
}
