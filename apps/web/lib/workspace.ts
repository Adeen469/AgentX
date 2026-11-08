import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { AuthUser } from "./auth";
import { database, listTestRuns, recordTestRun, type TestRunRow } from "./database";
import { githubRequest, type GithubIssue, type GithubRepository } from "./github";
import { runSandboxedTest, type SandboxTestResult } from "./sandbox";

export type { TestRunRow };

/**
 * Server-stored test-pass proofs (table `test_runs`, migration 002 —
 * owned by the Database agent; this module only uses its exported
 * interface and never edits database.ts).
 *
 * Table shape (agreed): test_runs(run_id TEXT PRIMARY KEY, branch TEXT
 * NOT NULL, command TEXT NOT NULL, exit_code INTEGER NOT NULL,
 * output_hash TEXT, output_excerpt TEXT, created_at TIMESTAMPTZ NOT NULL
 * DEFAULT now()).
 *
 * run_id is unique per TEST EXECUTION (not per workspace): the table keys
 * on run_id with ON CONFLICT DO NOTHING, so reusing an id would silently
 * drop the new proof. Callers pass a runId or one is generated as
 * `run-<uuid>`. Proofs are looked up by branch (latest first) or by
 * run_id (single row).
 *
 * exit_code comes from the sandbox result: 0 on pass, the raw process
 * exit code on failure, null on timeout. A stored proof with exit_code 0
 * is the server-side evidence that tests passed on that branch — the
 * approval gate can verify it instead of trusting a client claim.
 */
export const OUTPUT_HASH_EXCERPT_MAX_CHARS = 2000;

export function newTestRunId(): string {
  return `run-${randomUUID()}`;
}

export function hashTestOutput(stdout: string, stderr: string): string {
  return createHash("sha256").update(`${stdout}\n---stderr---\n${stderr}`, "utf8").digest("hex");
}

export function testOutputExcerpt(stdout: string, stderr: string): string {
  const combined = stdout ? `${stdout}${stderr ? `\n${stderr}` : ""}` : stderr;
  if (combined.length <= OUTPUT_HASH_EXCERPT_MAX_CHARS) return combined;
  return `${combined.slice(0, OUTPUT_HASH_EXCERPT_MAX_CHARS)}\n… [truncated, ${combined.length - OUTPUT_HASH_EXCERPT_MAX_CHARS} more chars]`;
}

export interface TestProof {
  runId: string;
  branch: string;
  command: string;
  exitCode: number | null;
  passed: boolean;
  outputHash: string;
  outputExcerpt: string;
  /** True when the row was written to test_runs. False when the database
   *  is unavailable — the test result itself is still returned, but no
   *  server-side proof exists, so the approval gate must not treat a
   *  client claim as proven. */
  stored: boolean;
  storedError?: string;
}

/** Build + store the proof for a finished sandboxed test run. Never
 *  throws for a missing/unreachable database: it reports stored: false
 *  so callers can degrade honestly instead of crashing. */
export async function storeTestProof(input: {
  runId?: string;
  branch: string;
  result: SandboxTestResult;
}): Promise<TestProof> {
  const runId = input.runId || newTestRunId();
  const outputHash = hashTestOutput(input.result.stdout, input.result.stderr);
  const outputExcerpt = testOutputExcerpt(input.result.stdout, input.result.stderr);
  const proof: TestProof = {
    runId,
    branch: input.branch,
    command: input.result.command,
    exitCode: input.result.exitCode,
    passed: input.result.passed,
    outputHash,
    outputExcerpt,
    stored: false,
  };
  try {
    await recordTestRun({
      runId,
      branch: input.branch,
      command: input.result.command,
      // A timed-out run has no exit code; store -1 so the integer column
      // still records "did not complete" distinctly from a pass (0).
      exitCode: input.result.exitCode ?? -1,
      outputHash,
      outputExcerpt,
    });
    proof.stored = true;
  } catch (error) {
    proof.storedError =
      error instanceof Error ? error.message : "Test proof could not be stored.";
  }
  return proof;
}

/** Latest stored proofs for a branch, newest first. Throws
 *  DatabaseUnavailableError (503 at the route) when the DB is not
 *  configured — callers that can degrade should catch it. */
export async function getTestProofsForBranch(branch: string, limit = 20): Promise<TestRunRow[]> {
  return listTestRuns(branch, limit);
}

/** Single stored proof by run_id, or null when no such run was recorded. */
export async function getTestProofByRunId(runId: string): Promise<TestRunRow | null> {
  const { rows } = await database().query<TestRunRow>(
    `SELECT run_id, branch, command, exit_code, output_hash, output_excerpt, created_at
     FROM test_runs WHERE run_id = $1 LIMIT 1`,
    [runId],
  );
  return rows[0] ?? null;
}

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
      // git -c <option> clone ... : the -c flag must come before the subcommand.
      cloneArgs.unshift("-c", `http.extraheader=AUTHORIZATION: bearer ${user.githubAccessToken}`);
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
  // The root itself is valid (the file-tree listing asks for "."); anything
  // under it is valid; anything outside it is rejected.
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error("File path escapes workspace.");
  return target;
}

export async function runWorkspaceTest(workspace: string, command: string) {
  // Phase 2: test code is untrusted and must never run on the host.
  // runSandboxedTest re-validates the workspace, enforces the same
  // allowlist, and fails closed (throws) when Docker is unavailable
  // instead of falling back to a host exec. The old host exec path is
  // deliberately removed, not kept as a fallback.
  assertManagedWorkspace(workspace);
  return runSandboxedTest(workspace, command);
}
