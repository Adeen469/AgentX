# Production readiness and remaining blockers

> Scope: `main` `95acca4` (the 9+ pass) plus the uncommitted Tauri
> desktop migration in this working tree. Collaboration is gone
> (removed 2026-10-30): there is no collaboration service, no `/collab`
> route, no WebSocket server, and no multi-instance / Redis concern any
> more. Do not re-add any of it on the basis of an old doc.

## What is true now

- **Single service.** `vercel.json` deploys one `web` service (`apps/web`,
  Next.js) with a catch-all rewrite. Auth guards are plain redirects in
  `apps/web/next.config.mjs` — there is no Edge middleware (`middleware.ts`
  failed every Vercel deployment that included it).
- **GitHub-only auth.** Sessions are HMAC-signed cookies (HttpOnly,
  `SameSite=Lax`, `Secure` in production), 7-day expiry with 24 h sliding
  rotation (working tree). Non-GitHub sessions are rejected.
- **Approval gate is server-enforced for PRs.** `POST /api/agent/approval`
  requires explicit confirmation, and for `open_pull_request` requires
  `testPassed: true` plus a non-empty diff; `POST /api/github/pull-request`
  re-verifies the signed token and re-checks both conditions. Approval
  tokens expire after 15 minutes and are bound to the user and action.
- **Sandbox fails closed.** No Docker → 503 from `POST /api/workspace/test`;
  the old host-exec path is removed, not kept as a fallback. See
  [docs/SANDBOX.md](./SANDBOX.md).
- **Database layer degrades gracefully.** Importing `lib/database.ts`
  never throws and never connects; `database()` throws
  `DatabaseUnavailableError` only on first use without a real
  `DATABASE_URL`. Pool: max 10, 5 s connect timeout, 30 s idle timeout,
  `allowExitOnIdle` for serverless.
- **Health endpoint exists.** `GET /api/health` (no auth) returns
  `{ status: "ok" | "degraded", checks: { database, github, docker },
  checkedAt }`, each check with a fast timeout so the endpoint never
  hangs. On Vercel the docker check is expected to be `unavailable`.
  (Earlier docs that said "confirm `GET /ready` returns 200" were
  wrong — that endpoint belonged to the removed collaboration server;
  the live signal is `GET /api/health` plus the homepage and sign-in.)

## Required before a real release

### 1. PostgreSQL database

- Create a PostgreSQL database (Supabase is the documented target).
- Set `DATABASE_URL` to the **Supabase Transaction pooler URL, port
  6543** — e.g.
  `postgres://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres`.
  A direct port-5432 URL still works but logs a server warning: serverless
  functions open a fresh connection per invocation and can exhaust
  Supabase's direct-connection limit.
- Run `npm run db:setup` from the repo root. It applies, in order,
  `apps/web/db/001_initial.sql` (users, collaboration_rooms [legacy,
  unused], agent_actions, approval_requests) and
  `apps/web/db/002_test_runs.sql` (test_runs + indexes). Both files are
  idempotent (`IF NOT EXISTS`) and safe to re-run.
- **Do not treat the database as optional on Vercel.** Without it there
  is no durable record of anything (users, actions, test runs) — the app
  runs, but nothing is persisted.

### 2. Secrets

- `AUTH_SECRET`: a fresh random value of **at least 32 characters**
  (e.g. `openssl rand -hex 32`). The working tree rejects short,
  placeholder, or repeated-character values at first use — the server
  will fail to sign sessions rather than start with a weak secret.
  Rotating it invalidates every session and approval token.
- `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`: from a GitHub OAuth app.
  Register the exact callback for the deployed domain:
  `https://<your-domain>/api/auth/callback/github` (locally
  `http://localhost:3000/api/auth/callback/github`). A mismatch fails
  sign-in at GitHub's side.
- At least one AI key: `GROQ_API_KEY`, `GEMINI_API_KEY`,
  `OPENROUTER_API_KEY`, or `NVIDIA_API_KEY` (each also accepts a `_2`
  alias; `GROQ2_API_KEY`, `GEMINI2_API_KEY`, etc.). Without any key,
  planning fails with "No AI provider is configured."
- Move secrets out of `.env.local` into the deployment secret store
  (Vercel environment variables). Never ship `GITHUB_CLIENT_SECRET` or
  any AI key in client-side code — all of them are read server-side only.
- Rotate any credential that was exposed during development.

### 3. HTTPS and cookies

- Serve the app over HTTPS in production. Session cookies are
  `Secure` only when `NODE_ENV=production` and `SameSite=Lax`, HttpOnly
  always. There is no WebSocket service any more, so there is no WSS
  configuration to do — any doc mentioning WebSocket TLS is obsolete.

### 4. Tauri release signing (desktop only)

- No code-signing certificate is configured (`certificateThumbprint` /
  `signCommand` in `apps/desktop/src-tauri/tauri.conf.json` are not
  set anywhere). Without signing, Windows SmartScreen may warn users on
  install. Obtain an Authenticode certificate and configure Tauri's
  Windows signing (see the Tauri signing docs) before distributing the
  installer outside the team.
- Installer build (on Windows, with the Rust toolchain installed):
  `npm install`, then `npm run build:web`, then
  `npm run package --workspace @agentx/desktop` (or
  `npm run release:windows` for both steps). The packaged app bundles
  the web standalone output and loads it at `AGENTX_WEB_URL` (default
  `http://localhost:3000`) — the desktop shell is a viewer, not a
  second server. The NSIS installer needs WebView2 on the target
  machine; it downloads the bootstrapper automatically when missing
  (see README "Desktop (Windows)"), unlike the old Electron shell,
  which bundled Chromium and needed no runtime.

## Operational expectations — verified vs not

| Area | Status |
| --- | --- |
| Connection pooling | Implemented: `pg` Pool, max 10, timeouts above. |
| Rate limits / request limits | **Not implemented.** No rate limiting exists on any API route. Do not claim otherwise. |
| Load testing | **Not done.** No load test has been run against the Vercel deployment or a self-hosted instance. |
| Bounded payloads / timeouts | Partial: AI provider calls time out at 20 s; `git diff` capped at 2 MB / 30 s; PR push at 120 s; sandbox runs time out (default 10 min). |
| Persistence | PostgreSQL via `DATABASE_URL`; `test_runs` rows are written on every sandboxed test run (`storeTestProof` → `recordTestRun`) and readable via `GET /api/workspace/test` and `GET /api/workspace/diff`. **But:** no route calls `recordAgentAction`, and `approval_requests` is never written either — the approval flow uses signed tokens, not the table. The action audit trail does not exist yet. |
| Test-pass proof | Storage + read path + optional approval verification are wired: `POST /api/workspace/test` stores the proof, `GET /api/workspace/test?runId=` / `?branch=` reads it, and `POST /api/agent/approval` verifies a stored proof when the caller supplies `testProof` (exit code 0 + optional hash match, 503 fail-closed). **Remaining gap:** the in-app UI does not send `testProof`, so UI approvals still rest on the client-reported `testPassed` flag, and the PR route re-checks only the signed token's flag. See README "Known limits". |
| Error responses | Explicit: 401 unauthenticated, 400 bad input / failed approval check, 503 Docker or database unavailable, 502 workspace creation failure. |
| Availability | Single web service. No multi-instance design is needed any more (no shared room state), but workspaces on Vercel are ephemeral per invocation — a clone made in one request may not exist in the next. Self-hosted is the only deployment where workspaces persist. |
| Backups | PostgreSQL backups are the deployer's job (Supabase: point-in-time recovery / daily backups per plan). Nothing in the repo backs anything up. |

## Installer behaviour (verified against `apps/desktop/src-tauri/tauri.conf.json`)

NSIS installer, user-level install (`installMode: currentUser`):
licence file (`LICENSE.txt`), English installer, LZMA compression,
desktop + Start-menu shortcuts and launch-after-install from Tauri's
default NSIS template, and the Explorer context-menu entries from
`src-tauri/installer-hooks.nsh` (`NSIS_HOOK_POSTINSTALL` /
`NSIS_HOOK_POSTUNINSTALL`). There is no portable installer target in
Tauri — the portable equivalent is the bare executable from `tauri
build --no-bundle` (`npm run package:portable --workspace
@agentx/desktop`). WebView2 is downloaded by the installer when missing
(`webviewInstallMode: downloadBootstrapper`, silent).

## Remaining blockers (in order)

1. **Wire the test-pass proof into the UI.** The server side is done
   (storage, read path, optional approval verification). The in-app UI
   still does not send `testProof` with its approval request and does
   not surface the repro result, so UI approvals rest on the
   client-reported `testPassed` flag. Send the stored proof's
   `runId`/`outputHash` from the UI, and have the PR route verify a
   stored row instead of (or in addition to) the token's flag.
2. **No automated tests in this repo.** Add at least unit tests for
   `lib/approval.ts` (token expiry / wrong-user / wrong-action),
   `lib/sandbox.ts` (allowlist, image selection, config validation), and
   `lib/auth.ts` (`requireAuthSecret` rejection cases). Nothing here is
   covered by CI today.
3. **Rate limiting.** At least on `/api/agent/plan` (AI cost) and
   `/api/workspace/test` (Docker cost).
4. **Load test** the Vercel deployment (sign-in → repos → plan) before
   calling it production-ready.
5. **Code signing** for the Windows installer (see §4 above).
6. **PR base defaults to `main`.** Send the repo's actual default branch
   as `base` instead of hard-coding `main` in the UI.
7. **Fix `npm run validate:env`.** Its optional-key list uses wrong
   names (`GITHUB_Client_ID` instead of `GITHUB_CLIENT_ID`, `GROQ2_API_KEY`
   is listed but `GEMINI2_API_KEY` etc. are inconsistently named), so its
   "optional integrations configured" count is unreliable. Required
   checks (`AUTH_SECRET`, `DATABASE_URL` present and not placeholders)
   do work.
