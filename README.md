# AgentX

AgentX is a free, self-hostable, single-user bug-fix workspace for GitHub
repositories. You sign in with GitHub, pick a repository and an issue, get an
AI investigation plan, edit the code in an isolated workspace, run the tests
inside a Docker sandbox, review the diff, and — only after your explicit
approval — push a branch and open a pull request. AgentX never merges
anything, and it never runs untrusted test code on the host.

> Status: working tree at `main` `a910f72` ("Fix duplicate Settings in the
> sidebar") plus the uncommitted changes of this 9+ pass. The live Vercel
> deployment is web-only; the Docker sandbox does not run there (see
> [Vercel vs self-hosted](#vercel-vs-self-hosted) below).

## What AgentX does — and does not do

**It does:**

- GitHub-only sign-in (OAuth, scopes `read:user user:email repo`). There is
  no Google sign-in and no other provider.
- AI investigation plans for a GitHub issue, from Groq, Gemini, OpenRouter,
  or NVIDIA — tried in that order, first success wins, 20 s per provider.
  A plan is a JSON summary, steps, likely files, validation commands, and
  irreversible actions. At least one AI key must be set or planning fails.
- Isolated workspaces: a shallow (`--depth 1`) clone of the repo's default
  branch into `WORKSPACE_ROOT` (default `workspaces/`), on a new branch
  `agentx/issue-<number>`. Paths are confined to the workspace root; a path
  that escapes it is rejected.
- In-app file editing and `git diff` review of the patch.
- Sandboxed tests: `POST /api/workspace/test` runs one allowlisted command
  (`npm test`, `npm run test`, `npm run lint`, `pytest`, `dotnet test`,
  `cargo test`, `go test ./...`) inside a disposable Docker container with
  no network, dropped capabilities, a read-only root filesystem, and CPU /
  memory / process limits. If Docker is missing or down, the endpoint
  returns **503** — tests are never run on the host as a fallback.
- A human approval gate: push / pull-request creation requires an HMAC-signed
  approval token (15-minute expiry, bound to you and to the exact action).
  For a pull request the server additionally requires a passing test
  (`testPassed: true`) and a non-empty diff, and re-checks both when the PR
  is opened. The "Always approve" setting in Settings is a UI preference
  only — it changes nothing server-side; every PR still needs your explicit
  confirmation.
- Server-stored test-run records: migration `002_test_runs.sql` adds a
  `test_runs` table, and `apps/web/lib/database.ts` provides
  `recordTestRun` / `listTestRuns` (run id, branch, command, exit code,
  output hash + excerpt). **Not yet wired end to end:** no API route calls
  `recordTestRun` yet, and there is no endpoint to read the records — the
  proof today is the sandboxed test result plus the signed approval payload
  (see [Known limits](#known-limits)). Do not claim a stored proof exists
  for a run until a row is visible in `test_runs`.

**It does not do:**

- Autonomous reproduction or autonomous fixes. The agent **plans**; it does
  not reproduce the bug, find the cause, or write the fix on its own. You
  write the fix in the workspace editor, guided by the plan. (The landing
  page's hero copy — "reproduces it in a sandbox, finds the cause, writes a
  fix" — overstates this and is a known copy bug, not the behaviour.)
- Auto-merge, auto-push, or any irreversible action without your approval.
- Collaboration. Collaborative rooms, the `/collab` route, the WebSocket
  collaboration server, and the multi-service Vercel config were removed on
  2026-10-30. AgentX is single-user.
- Edge middleware. Auth routing guards are plain redirects in
  `apps/web/next.config.mjs`, not `middleware.ts` — Vercel rejects Edge
  middleware output in this project, and every deployment that included
  `middleware.ts` failed. Do not reintroduce it.

## The PS-05 pipeline, step by step

| Step | What happens | Where |
| --- | --- | --- |
| 1. Sign in | GitHub OAuth; session is an HMAC-signed cookie (`agentx_session`, HttpOnly, `SameSite=Lax`, `Secure` in production, 7-day expiry with 24 h sliding rotation) | `GET /api/auth/github`, `GET /api/auth/callback/github` |
| 2. Pick repo + issue | Lists your repos and their open issues via the GitHub API with your token | `GET /api/github/repositories`, `GET /api/github/issues` |
| 3. Plan | AI plan for the issue; provider fallback chain; no provider configured → error | `POST /api/agent/plan` |
| 4. Workspace | Shallow clone, `agentx/issue-<n>` branch | `POST /api/workspace/create` |
| 5. Edit | Read / save files inside the workspace only | `GET/PUT /api/workspace/file`, `GET /api/workspace/files` |
| 6. Test | Allowlisted command in the Docker sandbox; result is `{ command, passed, stdout, stderr, sandboxed: true, image }` | `POST /api/workspace/test` |
| 7. Review | `git diff` of the workspace | `GET /api/workspace/diff` |
| 8. Approve | Explicit confirmation → signed approval token (15 min). PR approval requires `testPassed: true` + non-empty diff | `POST /api/agent/approval` |
| 9. Open PR | Token verified, test + diff re-checked, branch pushed with your GitHub token, PR opened (base `main` unless overridden in the payload) | `POST /api/github/pull-request` |

There is no automated test suite in this repository itself — no `*.test.*`
files and no test runner script. The "tests" above are the target
repository's tests, run in the sandbox.

## Vercel vs self-hosted

| Capability | Vercel (live site) | Self-hosted (your machine) |
| --- | --- | --- |
| Web UI, sign-in, repos, issues, AI plan | Works | Works |
| Workspace clone + file edit + diff | Works, but workspaces are ephemeral on serverless functions | Works, persistent under `WORKSPACE_ROOT` |
| Sandboxed tests | **503 by design** — no Docker daemon on Vercel; nothing runs on the host instead | Works, with Docker installed and running |
| Approval + PR opening | Works (approval is a signed token, no Docker needed) | Works |
| Database (`DATABASE_URL`) | Recommended — Supabase Transaction pooler, port **6543** (see below) | Any PostgreSQL; pooler URL also fine |
| Health / readiness endpoint | **None exists.** There is no `GET /health` or `GET /ready` route in the app. Do not document or probe one. | Same — none exists |

`vercel.json` deploys a single `web` service (`apps/web`, Next.js) with a
catch-all rewrite. There is no collaboration service any more.

## Environment variables

Copy `.env.example` to `.env.local` (repo root; Next.js loads it, and
`apps/web/next.config.mjs` also reads the root `.env.local`). Never commit
`.env.local` and never paste a secret value in chat or in the repo.

| Variable | Required | Notes |
| --- | --- | --- |
| `AUTH_SECRET` | Yes | Signs sessions and approval tokens. **At least 32 random characters** (e.g. `openssl rand -hex 32`); the working tree rejects short, placeholder, or repeated-character values. Rotate it and all sessions + approval tokens become invalid. |
| `DATABASE_URL` | Yes for persistence; app degrades without it | PostgreSQL connection string. **Use the Supabase Transaction pooler URL, port 6543** (`postgres://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres`). A direct port-5432 URL works but logs a warning — serverless functions open a fresh connection per invocation and can exhaust Supabase's direct-connection limit. Pool: max 10, 5 s connect timeout, 30 s idle timeout. |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | Yes for sign-in | GitHub OAuth app. Callback must match exactly: `http://localhost:3000/api/auth/callback/github` locally, `https://<your-domain>/api/auth/callback/github` on Vercel. `GITHUB_REDIRECT_URI` overrides the derived callback if set. |
| `GROQ_API_KEY` (+ `GROQ2_API_KEY`) | At least one AI key | Default model `llama-3.1-8b-instant` (`GROQ_MODEL` overrides). |
| `GEMINI_API_KEY` (+ `GEMINI2_API_KEY`) | — | Default model `gemini-2.0-flash` (`GEMINI_MODEL` overrides). |
| `OPENROUTER_API_KEY` (+ `OPENROUTER2_API_KEY`) | — | Default model `openrouter/free` (`OPENROUTER_MODEL` overrides). |
| `NVIDIA_API_KEY` (+ `NVIDIA2_API_KEY`) | — | Default model `nvidia/nemotron-3-ultra-550b-a55b` (`NVIDIA_MODEL` overrides). |
| `WORKSPACE_ROOT` | No | Default `workspaces/` under the working directory. |
| `AGENTX_SANDBOX_*` | No | Sandbox CPU / memory / timeout / image overrides — see [docs/SANDBOX.md](./docs/SANDBOX.md). |

`npm run validate:env` checks that `AUTH_SECRET` and `DATABASE_URL` are
present and not placeholders in `.env.local`. It does not check any other
value, and its optional-key list uses mismatched names — treat its
"optional integrations configured" count as unreliable.

## Run it locally

```powershell
npm install
npm run validate:env
npm run db:setup        # applies apps/web/db/001_initial.sql + 002_test_runs.sql
npm run dev             # starts the web app on http://localhost:3000
```

`npm run dev` starts only the web service. There is no separate server
process any more. See [docs/E2E-RUN.md](./docs/E2E-RUN.md) for a full
end-to-end run (issue → plan → fix → sandboxed test → approval → PR)
against a small test repo, including how to verify the test result.

## Desktop (Windows)

`apps/desktop` is an Electron shell that loads the web app
(`AGENTX_WEB_URL`, default `http://localhost:3000`) with context isolation
on and Node integration off. Packaging is electron-builder, Windows NSIS +
portable, one-click off, licence page, custom install directory, desktop /
Start-menu shortcuts, run-after-install. The packaged build bundles the
web app's standalone output (`apps/web/.next/standalone`). The desktop app
is a viewer for the web app — it does not add its own server, auth, or
sandbox.

## Known limits (not hidden)

1. **No health / readiness endpoint.** `GET /ready` and `GET /health` do
   not exist. Verify a deployment by loading the homepage and signing in.
2. **No stored test-pass proof wired end to end yet.** `test_runs` table
   and `recordTestRun` / `listTestRuns` exist, but no route records a run
   and no endpoint reads them. The approval gate trusts the
   client-reported `testPassed` flag — the server checks the flag and the
   diff, it does not independently verify that a sandbox run passed for
   that branch. (The `test_runs` design exists precisely to close this
   gap; the wiring is the remaining step.)
3. **No sandboxed dependency install.** The sandbox starts from a clean
   language image; a project needing `npm install` / `pip install` before
   its tests will fail in the sandbox. Dependencies already in the
   workspace copy are used as-is.
4. **PR base defaults to `main`.** The UI sends `base: "main"`; if the
   target repo's default branch is not `main`, the PR is opened against
   the wrong base.
5. **No repo test suite.** This repository has no automated tests of its
   own; nothing here is covered by CI.
6. **Code signing not configured.** No `CSC_LINK` / signing certificate
   is set up for the Windows installer, so SmartScreen may warn on
   install.
7. **"Always approve" is a UI label, not a bypass.** It is stored in
   `localStorage` and never read by the server.

## Docs

- [docs/PRODUCTION-READINESS.md](./docs/PRODUCTION-READINESS.md) —
  deployment checklist and remaining blockers, matched to the code.
- [docs/SANDBOX.md](./docs/SANDBOX.md) — Docker sandbox threat model,
  images, configuration, fail-closed behaviour.
- [docs/VERCEL.md](./docs/VERCEL.md) — Vercel deployment (web-only).
- [docs/E2E-RUN.md](./docs/E2E-RUN.md) — end-to-end run guide for the
  owner, on his own machine with Docker.
