# AgentX

AgentX is a free, self-hostable, single-user bug-fix workspace for GitHub
repositories. You sign in with GitHub, pick a repository and an issue, get an
AI investigation plan, edit the code in an isolated workspace, run the tests
inside a Docker sandbox, review the diff, and — only after your explicit
approval — push a branch and open a pull request. AgentX never merges
anything, and it never runs untrusted test code on the host.

> Status: `main` `95acca4` (the 9+ pass: autonomous repro, server-stored
> test-pass proof, health endpoint, GitHub stats caching, security
> hardening) plus the uncommitted Tauri desktop migration in this working
> tree. The live Vercel deployment is web-only; the Docker sandbox does
> not run there (see [Vercel vs self-hosted](#vercel-vs-self-hosted)
> below).

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
- Autonomous reproduction, sandboxed: `POST /api/agent/repro` (and the
  plan step, which runs it first) executes one allowlisted test command
  in the Docker sandbox against the isolated workspace. A failing
  command is reported `reproduced`, a passing one `not-reproduced`, and
  Docker being unavailable is reported `not-run` — never silently
  upgraded into a claimed repro, and never blocking the plan. The
  reproduction is evidence about the test command, not a diagnosis: the
  agent does not find the cause or write the fix on its own (see below).
- Server-stored test-pass proof: every sandboxed test run is recorded by
  `POST /api/workspace/test` (`storeTestProof` → `recordTestRun`, table
  `test_runs`, migration `002_test_runs.sql`: run id, branch, command,
  exit code, output hash + excerpt) and the response carries
  `proof: { ..., stored: true/false }`. Proofs are readable via
  `GET /api/workspace/test?runId=<id>` or `?branch=<branch>`, and
  `GET /api/workspace/diff` returns the branch's recent proofs.
  `POST /api/agent/approval` verifies a stored proof when the caller
  supplies `testProof: { runId, outputHash? }` — approval is issued only
  if the stored row shows exit code 0 (and the hash matches when given),
  failing closed 503 if the database cannot be read. **Caveat:** the
  in-app UI does not send `testProof` yet, so an approval issued from
  the UI still rests on the client-reported `testPassed` flag; the
  server-side verification only binds approvals whose caller supplies a
  proof.
- Health endpoint: `GET /api/health` (no auth) returns
  `{ status: "ok" | "degraded", checks: { database, github, docker },
  checkedAt }`. On Vercel the docker check is expected to be
  `unavailable`.
- Live GitHub stats on the landing page via `GET /api/github/stats`:
  10-minute server cache, stale data served when GitHub fails, and
  `GITHUB_TOKEN` / `GITHUB_STATS_TOKEN` when set (5,000 req/hr instead
  of 60/hr unauthenticated).

**It does not do:**

- Autonomous diagnosis or autonomous fixes. The agent **plans** and can
  **reproduce** (run the allowlisted test command in the sandbox and
  report whether it fails), but it does not find the cause or write the
  fix on its own. You write the fix in the workspace editor, guided by
  the plan and the repro result. (The landing page's hero copy used to
  overstate this — "reproduces it in a sandbox, finds the cause, writes
  a fix" — and has been corrected.)
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
| 3. Plan | AI plan for the issue; provider fallback chain; no provider configured → error. Before planning, the server runs the autonomous repro (`POST /api/agent/repro` logic) against the workspace when one exists and attaches the `reproduction` result to the plan response | `POST /api/agent/plan` |
| 4. Workspace | Shallow clone, `agentx/issue-<n>` branch | `POST /api/workspace/create` |
| 5. Edit | Read / save files inside the workspace only | `GET/PUT /api/workspace/file`, `GET /api/workspace/files` |
| 6. Test | Allowlisted command in the Docker sandbox; result is `{ command, passed, stdout, stderr, sandboxed: true, image }` plus a stored `proof` (see above) | `POST /api/workspace/test` (+ `GET` for stored proofs) |
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
| Health / readiness endpoint | `GET /api/health` (no auth) — `{ status: "ok" \| "degraded", checks: { database, github, docker }, checkedAt }`. Docker check is `unavailable` on Vercel by design | Same — plus Docker `ok` when the daemon runs |

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

`apps/desktop` is a Tauri (Rust) shell that loads the web app
(`AGENTX_WEB_URL`, default `http://localhost:3000`) in the system
webview. Packaging is Tauri v2, Windows NSIS; the portable equivalent is
the bare executable from `npm run package:portable --workspace
@agentx/desktop` (`tauri build --no-bundle`), which runs without
installing. The packaged build bundles the web app's standalone output
(`apps/web/.next/standalone`, plus `.next/static`) as resources, and the
NSIS installer keeps the old Explorer "Open with AgentX" context-menu
entries via `src-tauri/installer-hooks.nsh`. The desktop app is a viewer
for the web app — it does not add its own server, auth, or sandbox.

Building the desktop app needs the Rust toolchain (`rustup`, stable)
as well as Node: `npm run build --workspace @agentx/desktop` runs
`tauri build` (which first runs `npm run build:web`), and `npm run dev
--workspace @agentx/desktop` runs `tauri dev` against the web dev
server. The Windows installer can also be built from Linux by
cross-compiling: install `cargo-xwin` (`cargo install cargo-xwin`), the
`x86_64-pc-windows-msvc` rustup target, `makensis` (`apt install nsis`),
`llvm-rc` (`apt install llvm`) and `clang-cl` (Ubuntu's clang package
does not ship it — symlink the clang driver:
`ln -s /usr/lib/llvm-18/bin/clang /usr/local/bin/clang-cl`), then run
`tauri build --target x86_64-pc-windows-msvc --runner cargo-xwin` from
`apps/desktop`. (Verified 2026-11-08: this produces a real NSIS
installer, `AgentX_0.1.0_x64-setup.exe`, 19.55 MiB.) The installer is
unsigned in that case — signing needs a Windows host or a custom
`sign_command` (`bundler > windows > sign_command`).

Getting the installer without a Windows machine: GitHub Actions builds
it — see `.github/workflows/build-windows.yml`. In the repo, open the
Actions tab → "Build Windows installer" → Run workflow (optional tag,
default `v0.1.0-tauri`); the run uploads the installer as the
`agentx-windows-installer` artifact, and a manual run also attaches it
to a GitHub Release with that tag. The workflow regenerates the PNG/ICO
icons from `src-tauri/icons/icon.svg` when they are missing (the binary
icon files cannot be committed to git; the SVG is the source of truth).

Unlike the old Electron shell, Tauri does not bundle Chromium: the app
renders in WebView2, which must be present on the user's Windows
machine. The NSIS installer downloads the WebView2 bootstrapper
automatically when it is missing (`webviewInstallMode:
downloadBootstrapper`, silent), so a normal install still works; a
machine with no WebView2 and no network cannot run the app.

## Known limits (not hidden)

1. **No stored test-pass proof in the UI approval path yet.** The
   server stores a proof for every sandboxed test run and verifies it
   when a caller supplies `testProof` to `POST /api/agent/approval`,
   but the in-app UI does not send `testProof`, so a UI approval still
   rests on the client-reported `testPassed` flag. Wiring the UI to
   send the proof (and surfacing the repro result) is the remaining
   step; the PR route likewise re-checks only the signed token's
   `testPassed` flag, not a stored row.
2. **No sandboxed dependency install.** The sandbox starts from a clean
   language image; a project needing `npm install` / `pip install` before
   its tests will fail in the sandbox. Dependencies already in the
   workspace copy are used as-is.
3. **PR base defaults to `main`.** The UI sends `base: "main"`; if the
   target repo's default branch is not `main`, the PR is opened against
   the wrong base.
4. **No repo test suite.** This repository has no automated tests of its
   own; nothing here is covered by CI.
5. **Code signing not configured.** No Authenticode certificate is set
   up for the Tauri Windows installer (`certificateThumbprint` /
   `signCommand` in `apps/desktop/src-tauri/tauri.conf.json` are unset),
   so SmartScreen may warn on install.
6. **"Always approve" is a UI label, not a bypass.** It is stored in
   `localStorage` and never read by the server.

## Docs

- [docs/PRODUCTION-READINESS.md](./docs/PRODUCTION-READINESS.md) —
  deployment checklist and remaining blockers, matched to the code.
- [docs/SANDBOX.md](./docs/SANDBOX.md) — Docker sandbox threat model,
  images, configuration, fail-closed behaviour.
- [docs/VERCEL.md](./docs/VERCEL.md) — Vercel deployment (web-only).
- [docs/E2E-RUN.md](./docs/E2E-RUN.md) — end-to-end run guide for the
  owner, on his own machine with Docker.
