# End-to-end run guide (owner, self-hosted)

> **Read this first: this guide has not been run.** Docker is not available
> in the VM where these docs were written, so no end-to-end run has been
> executed or verified here. Nothing below claims a run happened. This is
> the procedure for the owner to run on his own machine, where Docker is
> installed. If any step fails, stop at that step and fix it there — do not
> skip ahead and do not claim the later steps passed.

## What the run proves

One real pass through the PS-05 pipeline against a small test repository:

issue → AI plan → human fix in an isolated workspace → sandboxed test →
diff review → explicit approval → branch push + pull request — with the
test result and the approval re-check visible at each step.

What it does **not** prove: autonomous reproduction or an autonomous fix.
The agent plans; **you** write the fix. That is the design, not a gap in
the run.

## Prerequisites (owner's machine)

- [ ] **Node.js 20+** and npm. Check: `node --version` (≥ 20), `npm --version`.
- [ ] **Git** installed and on `PATH`. Check: `git --version`.
- [ ] **Docker Engine or Docker Desktop installed and running.** Check:
      `docker info` exits 0. On Windows, WSL2-backed Docker Desktop is
      fine — the server only invokes the `docker` CLI.
- [ ] **A GitHub OAuth app** (github.com → Settings → Developer settings →
      OAuth Apps → New OAuth App):
      - Homepage URL: `http://localhost:3000`
      - Authorization callback URL: `http://localhost:3000/api/auth/callback/github`
      - Copy the Client ID and generate a Client Secret. Keep them out of
        chat and out of the repo.
- [ ] **A PostgreSQL database** with the AgentX schema. Supabase is the
      documented target — use the **Transaction pooler** connection string
      (port **6543**), not the direct port-5432 URL. A local PostgreSQL
      also works for this run.
- [ ] **At least one AI key**: Groq, Gemini, OpenRouter, or NVIDIA.
- [ ] **A small test repository** on GitHub that you own, with a real
      failing test and an open issue describing it. Suggested shape: a
      tiny Node repo with one test file (`npm test` runs it) and one
      open issue, e.g. "add returns wrong result for negative numbers".
      The repo must have a `main` branch (see the known limit on PR base
      below) and a test command in the sandbox allowlist (`npm test` is
      the simplest). Make sure its tests can run from a clean
      `node:20-bookworm-slim` image **without** `npm install` — either
      commit `node_modules` (not recommended) or use a repo with zero
      dependencies — because the sandbox has no dependency-install step
      yet. A zero-dependency repo with a built-in test runner (Node's
      `node:test`) is the reliable choice.

## 1. Configure

From the repo root:

```powershell
Copy-Item .env.example .env.local
```

Edit `.env.local` (never commit it) and set at minimum:

```text
AUTH_SECRET=<at least 32 random characters, e.g. openssl rand -hex 32>
DATABASE_URL=postgres://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres
GITHUB_CLIENT_ID=<your OAuth app client ID>
GITHUB_CLIENT_SECRET=<your OAuth app client secret>
GITHUB_REDIRECT_URI=http://localhost:3000/api/auth/callback/github
GROQ_API_KEY=<your key>        # or GEMINI_API_KEY / OPENROUTER_API_KEY / NVIDIA_API_KEY
```

Then:

```powershell
npm install
npm run validate:env
```

Expected: `Required configuration is present.` If it complains about
`.env.local` or a missing value, fix that before continuing. (Its
"optional integrations configured" count is unreliable — ignore it.)

## 2. Set up the database

```powershell
npm run db:setup
```

Expected: `Applied apps/web/db/001_initial.sql`,
`Applied apps/web/db/002_test_runs.sql`, then
`AgentX database schema is ready.` This creates `users`,
`agent_actions`, `approval_requests`, and `test_runs` (plus indexes).
Re-running is safe — every statement is `IF NOT EXISTS`.

Verify with `psql` (or the Supabase SQL editor):

```sql
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('users', 'agent_actions', 'approval_requests', 'test_runs');
```

Expected: all four rows.

## 3. Start the web server

```powershell
npm run dev
```

Expected: Next.js starts and serves `http://localhost:3000`. If the port
is taken, Next.js picks another port — note the actual port and use it in
the callback URL instead (the GitHub OAuth callback must match exactly).

Pre-pull the sandbox image so the first test run is not a pull:

```powershell
docker pull node:20-bookworm-slim
```

## 4. The run (in the browser)

1. Open `http://localhost:3000`, click **Sign in with GitHub**, authorize
   the OAuth app. You should land on `/app` signed in.
   - If GitHub shows a redirect mismatch, the callback URL in the OAuth
     app does not exactly match `http://localhost:3000/api/auth/callback/github`.
2. Pick your test repository, then pick the open issue.
3. Click **Analyze issue**. Expected: an AI plan appears (summary, steps,
   likely files, validation commands). Note which provider produced it —
   the notice says so if a fallback was used.
   - If planning fails with "No AI provider is configured", an AI key is
     missing or misspelled in `.env.local`; restart `npm run dev` after
     fixing it (Next.js reads `.env.local` at start).
4. Click **Create isolated workspace**. Expected: a workspace is created
   on branch `agentx/issue-<number>` (shallow clone of the repo's default
   branch). The file list loads.
5. Open the file the plan points at, make the fix the issue describes,
   and save. Then open the **Review** view and confirm `git diff` shows
   exactly your change — nothing else.
6. Pick the test command (`npm test`) and click **Run test**. Expected:
   a sandboxed result — `{ command: "npm test", passed: true, …,
   sandboxed: true, image: "node:20-bookworm-slim" }` — with the test
   output visible.
   - If it returns 503 / "Docker is not available", Docker is not
     running or not on `PATH` for this shell. Start Docker Desktop (or
     the engine), run `docker info` in the same shell, and retry. **Do
     not work around this by running the tests on the host — there is no
     host fallback by design.**
   - If the test fails (`passed: false`), read the output, fix the code,
     and re-run. Only a passing run unlocks approval.
7. Click **Approve reviewed patch** and confirm. Expected: an approval
   token is created. (The button stays disabled until a test has passed
   and a diff exists — that is the gate, working.)
8. Click **Confirm & open pull request**. Expected: a PR URL appears.
   Open it on GitHub and confirm: the branch is `agentx/issue-<number>`,
   the diff matches what you reviewed, and the PR body says the tests
   passed.
   - If the PR opens against the wrong base branch, the target repo's
     default branch is not `main` — the UI sends `base: "main"`. That is
     a known limit; close the PR and note it.

## 5. Verify the stored test-pass proof

**Status: the server-side proof chain IS wired end to end in code
(verified 2026-11-08 in `apps/web/lib/workspace.ts`,
`apps/web/app/api/workspace/test/route.ts`,
`apps/web/app/api/agent/approval/route.ts`).** The chain is:

1. `POST /api/workspace/test` runs the command in the Docker sandbox,
   then calls `storeTestProof()` → `recordTestRun()` → one row in
   `test_runs` (`run_id`, `branch`, `command`, `exit_code`, `output_hash`,
   `output_excerpt`). The response carries `proof: { runId, …, stored }`;
   `stored: false` + `storedError` when the database is unavailable —
   the test result is still returned, but no proof exists.
2. `GET /api/workspace/test?runId=<id>` / `?branch=<branch>` reads the
   stored rows back (503 when the database is not configured — never an
   empty list pretending no proofs exist).
3. `POST /api/agent/approval` with `payload.testProof: { runId,
   outputHash? }` issues the token ONLY if the stored row for that
   `runId` has `exit_code = 0` (and the hash matches when supplied).
   With `testProof` present but the database unreachable it fails
   closed with 503 — an unverifiable proof is never treated as verified.
4. `GET /api/workspace/diff` returns the branch's latest stored proofs
   (`testProofs`, `testProofsStored`) for the Review UI.

**Known gap (UI wiring, not server wiring): the Review UI does not
yet send the proof.** `AgentXApp.tsx` `runTests()` posts to
`/api/workspace/test` **without `branch`** (so the proof is stored
under branch `"unknown"`) and discards the returned `proof` object;
`requestApproval()` then sends only the client claim
`testPassed: testResult.passed` — no `testProof: { runId, outputHash }`.
So today an approval still goes through the legacy client-claim path
even though the server can verify a stored proof. Until the UI passes
`branch` and `testProof`, the stored-proof verification is available
to API callers but is not what the button uses. Verify what exists, in
this order:

1. **Sandboxed result (exists today).** The test step returned
   `sandboxed: true` with the image name, command, `passed`, and
   stdout/stderr. That result is the proof the approval was based on.
2. **Stored row (exists today, server-side).** After step 4.6, check
   that a row was recorded:

   ```sql
   SELECT run_id, branch, command, exit_code, created_at
   FROM test_runs ORDER BY created_at DESC LIMIT 5;
   ```

   Expect one row per test run, `exit_code = 0` for the passing run.
   **Caveat while the UI gap above is open:** the row's `branch` will
   be `"unknown"` (the UI does not send it) — match it by `run_id`
   from the test response's `proof.runId`, not by branch. Once the UI
   sends `branch`, a row with `exit_code = 0` for branch
   `agentx/issue-<number>` is the stored proof, and `output_hash` lets
   a verifier re-check the output excerpt.
3. **Approval re-check (exists today, server-side).** The server
   refused approval without `testPassed: true` + a non-empty diff, and
   the PR route re-checked both before pushing. You can confirm the
   negative case: with a failing test, the approve button is disabled
   and a direct `POST /api/agent/approval` with `testPassed: false` is
   rejected with 400. (Do this with `curl` and your session cookie
   only if you are comfortable — it is optional.) To exercise the
   stored-proof path directly, `POST /api/agent/approval` with
   `payload.testProof: { runId: "<runId from step 2>", outputHash:
   "<output_hash from step 2>" }` and a passing stored row: expect a
   200 with an approval token. With a bogus `runId`, expect 400 ("No
   stored test proof"); with no database, expect 503.

## 6. Clean up

- Close or merge the test PR on GitHub as you prefer; the
  `agentx/issue-<number>` branch can be deleted after merge.
- Workspaces live under `workspaces/` in the repo root; delete the run's
  directory if you do not need it.
- Never commit `.env.local`, and never paste `AUTH_SECRET`,
  `GITHUB_CLIENT_SECRET`, or any AI key into chat, an issue, or the repo.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Sign-in redirects to GitHub with an error | OAuth callback URL mismatch — must be exactly `http://localhost:3000/api/auth/callback/github`. |
| "No AI provider is configured" | No AI key set, or `.env.local` edited after the server started — restart `npm run dev`. |
| Test returns 503 / Docker unavailable | Docker not running, or not on `PATH` in this shell. `docker info` must exit 0 first. |
| `/api/health` says `docker: "ok"` but tests fail with `NanoCPUs` / `setns` | Health only probes `docker info`. The daemon can be up while no container can start (kernel/cgroup limits in this VM). Run on a Docker-capable machine. |
| Approval succeeds but no `test_runs` row, or proof is under branch `"unknown"` | The Review UI sends only the client `testPassed` claim and no `branch` — see §5. The server stores the proof and can verify it, but the button does not use it yet. |
| Test fails with "cannot find module" | The repo needs `npm install` first — the sandbox has no install step. Use a zero-dependency test repo for this run. |
| Workspace creation fails with 502 | Clone failed — check the repo is reachable and, for a private repo, that the GitHub token has `repo` scope (re-sign-in if needed). |
| Approval button disabled | No passing test result or no diff yet — run the test to green first, and make sure a file change is saved. |
| `npm run db:setup` fails to connect | `DATABASE_URL` wrong or unreachable — for Supabase, confirm it is the pooler URL (port 6543) and the password is right. |

## Verified in this VM — 2026-11-08 (partial run, honest record)

A partial end-to-end run was executed against the working tree in this VM
(`next dev`, Docker daemon up, no DATABASE_URL, no AI key, no GitHub token).
What passed live (exact responses recorded by the coordinator):
- `GET /api/health` → 200 `{"status":"degraded","database":"unavailable","github":"ok","docker":"ok"}`
- `POST /api/workspace/create` (Adeen469/ERROR_404_AYAN issue 4) → real GitHub
  clone + `agentx/issue-4` branch checked out
- `PUT /api/workspace/file` → `{"ok":true}` (fix applied in workspace)
- `GET /api/workspace/diff` → real diff + `testProofsStored: false`
- `POST /api/agent/approval` (legacy) → 200, approval token minted
- `POST /api/agent/approval` with `testProof` → 503 fail-closed (no DB)
- `POST /api/github/pull-request` → 401 (no GitHub token on session)
- `POST /api/agent/plan` → 503 "No AI provider is configured" with the
  reproduction attached
- `GET /api/workspace/test?branch=…` → 503 "Database is not configured…"

What could NOT run here (environment, not code): the Docker sandbox cannot
start ANY container in this VM — `docker run` fails with
`setns: operation not permitted` (and `NanoCPUs can not be set, as your
kernel does not support CPU CFS scheduler`). The sandbox correctly fails
closed (no host fallback). The repro/test steps therefore returned honest
`not-run`/infra errors. Run those two steps on your own machine per the
guide above, where Docker can start containers.

## Verified in this VM — 2026-11-08 ~19:41 IST (second check, Tauri tree)

HEAD `95acca4` confirmed. Tauri migration is uncommitted in the same
tree (`apps/desktop/src-tauri/`) but does not touch the web E2E path:
`vercel.json` is still web-only (`services.web.root: apps/web`,
Next.js, no desktop/Electron references).

Docker re-verified, same result as the first check — containers still
cannot start in this VM (exact outputs):

```text
$ docker ps
CONTAINER ID   IMAGE     COMMAND   CREATED   STATUS    PORTS     NAMES
(exit 0 — daemon is up, no containers)

$ docker run --rm hello-world
WARNING: IPv4 forwarding is disabled. Networking will not work.
docker: Error response from daemon: failed to create task for container:
failed to create shim task: OCI runtime create failed: runc create failed:
unable to start container process: error spawning mount remapping thread:
mount source thread: join container mntns: setns: operation not permitted
(exit 125)
```

The real sandbox code path was exercised directly (compiled
`apps/web/lib/sandbox.ts` + `lib/agent.ts` with `tsc`, real workspace
under `WORKSPACE_ROOT`, no mocks, no AI key, no GitHub token):

- `runSandboxedTest(ws, "npm test")` threw:
  `Docker sandbox failed before the test could run: docker: Error
  response from daemon: NanoCPUs can not be set, as your kernel does
  not support CPU CFS scheduler or the cgroup is not mounted` — the
  `docker run` failure surfaces with its real message (exit 125 is
  classified as an infra error, not a test failure), no host fallback,
  no fake pass. Note the error varies by invocation (`setns` vs
  `NanoCPUs`); both are the same underlying kernel/cgroup limitation.
- `attemptReproduction()` with a real workspace + broken Docker
  returned `status: "not-run"` with that same Docker error as the
  reason, `exitCode: null`, `sandboxed: false` — never a claimed repro.
- `attemptReproduction()` with no workspace returned `status:
  "not-run"` ("Repro not run — no workspace exists yet…").
- `pickReproCommand()`: a non-allowlisted explicit command falls back
  to the default `npm test` (never runs an arbitrary command); an
  allowlisted explicit command is honoured. Minor note: issue text
  mentioning `npm test:watch` matches `npm test` — harmless, because
  only the allowlisted command ever runs, but the code comment in
  `agent.ts` claims that match must not happen.
- `createAgentPlan()` with no AI key threw `No AI provider is
  configured. Add keys for Groq, Gemini, OpenRouter, or NVIDIA.` —
  plan fails closed without a key.

Live dev server (`next dev`, no DATABASE_URL, no AI key, no GitHub
token), exact responses:

- `GET /api/health` → 200
  `{"status":"degraded","checks":{"database":"unavailable","github":"ok","docker":"ok"},…}`
  — **trap:** `docker: "ok"` here means only that `docker info`
  succeeds; it does NOT mean containers can start in this VM. Do not
  read it as "sandbox works".
- `POST /api/agent/plan`, `/api/agent/repro`, `/api/agent/approval`,
  `/api/workspace/test`, and `GET /api/workspace/test?runId=…` without a
  session → all `401 {"error":"Authentication required."}`.
- Authenticated no-key / no-DB behaviours (`POST /api/agent/plan` →
  503 "No AI provider is configured"; `POST /api/agent/approval` with
  `testProof` → 503 fail-closed) were verified in the first partial run
  above and re-confirmed at the library level this run; they were NOT
  re-run over HTTP this time because there is no GitHub session in this
  VM.

What still could NOT run here: any step needing a container, an AI key,
a GitHub token, or a database — i.e. a real repro, a real sandboxed
test, a stored `test_runs` row, and the stored-proof approval. Those
need the owner's Docker-capable machine per the guide above.
