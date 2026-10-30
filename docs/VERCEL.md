> NOTE (2026-10-30): Collaborative rooms were removed. There is no collaboration service, no `/collab` route, and no room UI. Older collaboration sections below are obsolete.

# Vercel multi-service deployment (properly fixed)

This is the corrected version of Vercel's auto-suggested Services config.
Do not revert to that suggestion: it routed `/api/(.*)` to the
collaboration server, which would break every Next.js API route.

## Final `vercel.json` (at the repo root)

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "services": {
    "web": {
      "root": "apps/web",
      "framework": "nextjs"
    },
    "collaboration": {
      "root": "apps/server",
      "runtime": "container",
      "entrypoint": "Dockerfile"
    }
  },
  "rewrites": [
    { "source": "/collab", "destination": { "service": "collaboration" } },
    { "source": "/collab/(.*)", "destination": { "service": "collaboration" } },
    { "source": "/(.*)", "destination": { "service": "web" } }
  ]
}
```

## Service names, public paths, and bindings — confirmed

| Service | Root | Public? | Public path | What it serves |
| --- | --- | --- | --- | --- |
| `web` | `apps/web` | Yes | `/` (catch-all, last) — including all `/api/*` routes | Next.js UI + Next.js API routes: auth, GitHub, workspace, agent, collaboration token |
| `collaboration` | `apps/server` | Yes, only on its prefix | `/collab` and `/collab/(.*)` | WebSocket collaboration server + `/collab/health`, `/collab/ready` |

**Bindings: none.** No service calls another service server-to-server.
The web server never fetches the collaboration server, and the server
never calls the web app. The only cross-service link is the *browser*
connecting to the collaboration service over public `wss://<host>/collab`.
A binding would be for server-side code calling another service privately;
inventing one here would grant nothing the app uses and would hide the
fact that the browser link is public traffic. If a future change makes
the web *server* call the collaboration service, that change must add a
binding on `web` at that time — do not add one pre-emptively.

## Why the collaboration service is a container

`apps/server` is a long-lived `http.createServer` + `ws` process, not a
function handler. A plain Node service runtime would not run it as
written. The container runtime does: `apps/server/Dockerfile` builds a
`node:20` image and runs `node src/server.js`, listening on `$PORT`
(Vercel's container default is 80). `server.js` now honours `PORT`
first, then `COLLABORATION_PORT`, then `8787`, so local dev is
unchanged and Vercel routing works.

Routing note: a service receives the original request path, so
`/collab/health` arrives at the server as `/collab/health`, not
`/health`. `server.js` strips that one `/collab` prefix for its HTTP
health/ready routes only. WebSocket upgrades are path-agnostic in this
server, so a `wss://<host>/collab` upgrade works without stripping.

## Browser WebSocket URL

`apps/web/app/page.tsx` resolves it as:

1. `NEXT_PUBLIC_COLLABORATION_URL` if set (explicit override).
2. Otherwise, on an `https:` site: `wss://<current host>/collab` — so a
   Vercel deployment works without knowing its domain at build time
   (`NEXT_PUBLIC_*` values are baked into the client bundle).
3. Otherwise (local http dev): `ws://localhost:8787`.

## What Vercel does NOT fix (read before relying on this)

These are platform limits of Vercel Functions / container services, not
bugs this config claims to solve:

1. **Connections end.** On Hobby, a function connection is capped at
   300 seconds (Vercel's documented default/maximum for Hobby). The
   client now discards a closed socket and shows "retry to reconnect",
   and the server now lets an *approved* member rejoin the same room
   instead of throwing "You are already in this room" — but a user
   still has to retry/rejoin after a close. There is no automatic
   resubscribe yet.
2. **Instances scale down and multiply.** A container instance scales
   down after inactivity (5 minutes in production) and a new connection
   can land on a different instance. Room *state* survives only if
   `DATABASE_URL` is set (Postgres); the in-memory `clients` map does
   not. Two users on different instances will not see each other's
   broadcasts, because there is no Redis pub/sub yet. On Vercel,
   collaboration is therefore best-effort, not the same as a single
   self-hosted server. For reliable multi-user rooms, add Redis
   pub/sub (a later phase) or host the collaboration server on a
   persistent host.
3. **File persistence is ephemeral.** Without `DATABASE_URL`, rooms
   live in `data/collaboration-rooms.json` inside the container
   instance and are lost on scale-down/redeploy. Set `DATABASE_URL`
   for any real use, and apply `apps/web/db/001_initial.sql`.
4. **Sandbox tests still do not run on Vercel.** The web service is
   serverless Next.js with no Docker daemon, and the collaboration
   container is not a Docker host for the web service. `/api/workspace/test`
   will return the Phase 2 fail-closed 503 on Vercel. Workspace clones
   are also ephemeral on serverless functions. Those features remain
   local / self-hosted.

## Import steps (dashboard, after this config is on `main`)

1. In Vercel, import `Adeen469/AgentX`. Keep **Application Preset:
   Services**, **Root Directory: `./`** (the repo root, because
   `vercel.json` lives there), Project Name `agentx`.
2. If the import screen still shows the old "needs a vercel.json"
   warning, refresh / re-select the repository — it was captured
   before this file was pushed.
3. Expand **Environment Variables** (shared by both services in a
   Services project) and add for Production:
   - `AUTH_SECRET` — new random value, required for sessions and
     collaboration tokens.
   - `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`
   - At least one AI key for plans: `GROQ_API_KEY` (or Gemini /
     OpenRouter / NVIDIA).
   - `DATABASE_URL` — strongly recommended (see limits above).
   - `NEXT_PUBLIC_COLLABORATION_URL` — optional; leave unset to
     auto-derive `wss://<host>/collab`, or set it explicitly to
     `wss://<your-domain>/collab` after you know the domain (then
     redeploy, because it is baked into the client bundle).
   - Do **not** set `PORT` or `COLLABORATION_PORT` for the
     collaboration service on Vercel; the container runtime manages
     `PORT`. Do not paste any secret value in chat or in the repo.
4. Deploy.
5. After the first deploy, add the exact callback in your GitHub OAuth app:
   - `https://<your-domain>/api/auth/callback/github`
   These go to the `web` service, which is correct — do not point
   them at `/collab`.
6. Verify, in order: homepage → sign-in → repo/issue loading → plan
   → `https://<your-domain>/collab/health` returns `{"ok":true}` →
   create a collaboration room, then (as a second browser/user)
   request to join and get approved. Expect the limits in the
   section above: a room that works for a few minutes and then
   needs a rejoin is a platform limit, not a misconfiguration.
