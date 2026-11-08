# Production readiness and remaining blockers

> Scope: `main` `a910f72` plus the uncommitted changes of this 9+ pass.
> Anything marked "working tree" below is in the working tree but not yet
> committed — re-check it after the pass lands. Collaboration is gone
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
- **No health / readiness endpoint.** There is no `GET /health` or
  `GET /ready` route anywhere in the app. Earlier docs that said "confirm
  `GET /ready` returns 200" were wrong — that endpoint belonged to the
  removed collaboration server. Verify a deployment by loading the
  homepage, signing in with GitHub, and loading a repository list.

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

### 4. Electron release signing (desktop only)

- No code-signing certificate is configured (`CSC_LINK` /
  `CSC_KEY_PASSWORD` are not set anywhere). Without signing, Windows
  SmartScreen may warn users on install. Obtain an Authenticode
  certificate and configure it for electron-builder before distributing
  the installer outside the team.
- Installer build: `npm install` (without `--ignore-scripts`, so
  Electron downloads its runtime), then `npm run build:web`, then
  `npm run package --workspace @agentx/desktop` (or
  `npm run release:windows` for both steps). The packaged app bundles
  the web standalone output and loads it at `AGENTX_WEB_URL` (default
  `http://localhost:3000`) — the desktop shell is a viewer, not a
  second server.

## Operational expectations — verified vs not

| Area | Status |
| --- | --- |
| Connection pooling | Implemented: `pg` Pool, max 10, timeouts above. |
| Rate limits / request limits | **Not implemented.** No rate limiting exists on any API route. Do not claim otherwise. |
| Load testing | **Not done.** No load test has been run against the Vercel deployment or a self-hosted instance. |
| Bounded payloads / timeouts | Partial: AI provider calls time out at 20 s; `git diff` capped at 2 MB / 30 s; PR push at 120 s; sandbox runs time out (default 10 min). |
| Persistence | PostgreSQL via `DATABASE_URL`; `agent_actions` / `test_runs` helpers exist. **But:** no route currently calls `recordAgentAction` or `recordTestRun`, and `approval_requests` is never written either — the approval flow uses signed tokens, not the table. The tables exist; the audit trail does not yet. |
| Test-pass proof | Schema + helpers exist (`test_runs`, `recordTestRun` / `listTestRuns`); **not wired to any route**, and there is no endpoint to read proofs. See README "Known limits". |
| Error responses | Explicit: 401 unauthenticated, 400 bad input / failed approval check, 503 Docker or database unavailable, 502 workspace creation failure. |
| Availability | Single web service. No multi-instance design is needed any more (no shared room state), but workspaces on Vercel are ephemeral per invocation — a clone made in one request may not exist in the next. Self-hosted is the only deployment where workspaces persist. |
| Backups | PostgreSQL backups are the deployer's job (Supabase: point-in-time recovery / daily backups per plan). Nothing in the repo backs anything up. |

## Installer behaviour (verified against `apps/desktop/package.json`)

NSIS installer, not one-click: licence agreement (`LICENSE.txt`), custom
installation directory, progress UI, desktop shortcut, Start-menu
shortcut, launch-after-install, portable executable target, user-level
install (`perMachine: false`, `requestedExecutionLevel: asInvoker`),
`installer.nsh` extras. Explorer context-menu entries claimed by older
docs are **not** in the current packaging config — the config lists no
context-menu registration, so do not promise it.

## Remaining blockers (in order)

1. **Wire the test-pass proof.** Call `recordTestRun` from the sandboxed
   test path and add a read path (route or query) for `listTestRuns`, so
   the approval gate can verify a stored pass instead of trusting the
   client-reported `testPassed` flag. Until then the gate checks the flag
   and the diff, not an independent record.
2. **Add a health endpoint — or stop expecting one.** Decide: either add
   `GET /api/health` (session-independent, checks DB reachability
   without throwing) or keep verifying via homepage + sign-in. Today
   there is nothing to probe.
3. **No automated tests in this repo.** Add at least unit tests for
   `lib/approval.ts` (token expiry / wrong-user / wrong-action),
   `lib/sandbox.ts` (allowlist, image selection, config validation), and
   `lib/auth.ts` (`requireAuthSecret` rejection cases). Nothing here is
   covered by CI today.
4. **Rate limiting.** At least on `/api/agent/plan` (AI cost) and
   `/api/workspace/test` (Docker cost).
5. **Load test** the Vercel deployment (sign-in → repos → plan) before
   calling it production-ready.
6. **Code signing** for the Windows installer (see §4 above).
7. **PR base defaults to `main`.** Send the repo's actual default branch
   as `base` instead of hard-coding `main` in the UI.
8. **Fix `npm run validate:env`.** Its optional-key list uses wrong
   names (`GITHUB_Client_ID` instead of `GITHUB_CLIENT_ID`, `GROQ2_API_KEY`
   is listed but `GEMINI2_API_KEY` etc. are inconsistently named), so its
   "optional integrations configured" count is unreliable. Required
   checks (`AUTH_SECRET`, `DATABASE_URL` present and not placeholders)
   do work.
