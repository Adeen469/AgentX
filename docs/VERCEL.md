# Vercel deployment (web-only)

> This doc describes the deployment as it stands at `main` `95acca4`
> (the 9+ pass) plus the uncommitted Tauri desktop migration. The old multi-service doc (a `collaboration` container service, `/collab`
> routes, `wss://<host>/collab`, `/collab/health`) described a service that
> was **removed on 2026-10-30**. Every collaboration section in the old
> version was obsolete and has been deleted, not updated. Do not re-add a
> collaboration service.

## What deploys

One service: the Next.js web app in `apps/web`. The repo-root `vercel.json`
is:

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "services": {
    "web": {
      "root": "apps/web",
      "framework": "nextjs"
    }
  },
  "rewrites": [
    {
      "source": "/(.*)",
      "destination": { "service": "web" }
    }
  ]
}
```

There is no second service, no container runtime, and no server-to-server
binding. Auth routing guards are plain redirects in
`apps/web/next.config.mjs` — **there is no Edge middleware**. Vercel
rejects Edge Function output ("middleware") in this project, and every
deployment that included `middleware.ts` failed. Do not reintroduce it.

## Import steps (dashboard)

1. In Vercel, import `Adeen469/AgentX`. Keep **Root Directory: `./`**
   (the repo root, because `vercel.json` lives there), Project Name
   `agentx`.
2. Expand **Environment Variables** and add for Production:
   - `AUTH_SECRET` — new random value, **at least 32 characters**
     (e.g. `openssl rand -hex 32`). The app refuses to sign sessions
     with a short or placeholder value.
   - `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` — from the GitHub OAuth
     app.
   - At least one AI key for plans: `GROQ_API_KEY` (or `GEMINI_API_KEY` /
     `OPENROUTER_API_KEY` / `NVIDIA_API_KEY`). Without any key, planning
     fails.
   - `DATABASE_URL` — **Supabase Transaction pooler URL, port 6543**
     (`postgres://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres`).
     Strongly recommended: without it nothing is persisted, and a direct
     port-5432 URL risks exhausting Supabase's connection limit under
     serverless load.
   - Do **not** set `PORT`, `COLLABORATION_PORT`, or
     `NEXT_PUBLIC_COLLABORATION_URL` — there is no collaboration service
     any more, and those variables do nothing (the last two are still
     listed in `.env.example` as leftovers; ignore them). Do not paste
     any secret value in chat or in the repo.
3. Deploy.
4. After the first deploy, add the exact callback in the GitHub OAuth app:
   - `https://<your-domain>/api/auth/callback/github`

## Verify, in order

1. Homepage loads at `https://<your-domain>/`.
2. **Sign in with GitHub** works and lands on `/app`.
3. Repositories load, and opening one lists its issues.
4. **Analyze issue** returns an AI plan (proves an AI key is set).
5. `POST /api/workspace/test` returns **503** with a Docker message —
   **this is the expected result on Vercel**, not a failure. There is no
   Docker daemon on serverless functions.
6. `GET /api/health` returns `{ status: "ok" | "degraded", checks: { database, github, docker }, checkedAt }`.
   On Vercel, `status` is normally `"degraded"` with `docker:
   "unavailable"` — that is expected, not a failure. There is **no**
   `/collab/health` and **no** `/ready` endpoint to probe (those
   belonged to the removed collaboration server); verify with steps
   1–5 plus this health check instead.

## What Vercel does NOT do (platform limits, not bugs)

1. **Sandbox tests do not run on Vercel.** The web service is serverless
   Next.js with no Docker daemon. `/api/workspace/test` returns the
   fail-closed 503. The full run — plan → fix → sandboxed test → approve
   → PR — only works self-hosted. See [docs/E2E-RUN.md](./E2E-RUN.md).
2. **Workspaces are ephemeral.** A clone created by one serverless
   invocation may not exist in the next. Do not rely on a Vercel
   workspace persisting between steps; self-hosted workspaces persist
   under `WORKSPACE_ROOT`.
3. **Database connections are per-invocation.** Each serverless instance
   holds its own small pool (max 10). That is why the Transaction pooler
   (port 6543) is required rather than a direct connection.
4. **Health is `GET /api/health`, not Vercel's checks.** The endpoint
   needs no auth and returns `{ status, checks: { database, github,
   docker }, checkedAt }` with fast per-check timeouts. On Vercel the
   docker check is `unavailable` by design, so expect `status:
   "degraded"` there — wire alerts to the database/github checks, not
   to overall `ok`.

## Desktop app (separate from Vercel)

The Windows desktop app is not deployed by Vercel: it is a Tauri shell
in `apps/desktop` that loads the web app at `AGENTX_WEB_URL` (default
`https://agentx-error.vercel.app` — the installed app works with no
setup; `http://localhost:3000` is only for local dev). It is built on Windows with the Rust toolchain
(`npm run package --workspace @agentx/desktop`); see README
"Desktop (Windows)". The desktop shell needs WebView2 on the user's
machine — unlike the old Electron shell, it does not bundle Chromium.
