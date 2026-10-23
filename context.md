# AgentX Project Context

This file is the durable handoff context for IDEs and coding agents working on
AgentX. It must not contain secrets, access tokens, or the contents of
`.env.local`.

## Product purpose

AgentX is a free, self-hostable bug-fix agent for GitHub repositories. The
workflow is: authenticate, select a repository and issue, generate an AI
investigation plan, create an isolated workspace, edit files, run an
allowlisted test, review the diff, and require explicit human approval before
pushing or opening a pull request. AgentX must not merge changes automatically.

## Repository layout

- `apps/web`: Next.js 14 web app, React UI, OAuth, GitHub APIs, AI planning,
  workspace APIs, and collaboration-token route.
- `apps/server`: Node.js WebSocket collaboration server with PostgreSQL or
  file persistence.
- `apps/desktop`: Electron/Windows packaging entry point and installer assets.
- `packages/collaboration`: shared collaboration package.
- `apps/web/db/001_initial.sql`: PostgreSQL schema.
- `scripts/setup-database.js`: database initialization.
- `scripts/validate-environment.js`: safe environment check.
- `scripts/dev.js`: Windows launcher for web and collaboration services.
- `docs/PRODUCTION-READINESS.md`: deployment and hardening checklist.

## Development commands

Run from `C:\Users\mrade\Downloads\AgentX`:

```powershell
npm install
npm run validate:env
npm run dev
```

`npm run dev` starts Next.js and the collaboration server. The normal endpoints
are `http://localhost:3000` and `ws://localhost:8787`; readiness is checked at
`http://localhost:8787/ready`. If port 3000 is occupied, Next.js selects
another port such as 3001. Stop stale processes by their specific PID.

Useful commands:

```powershell
npm run dev:web
npm run dev:collaboration
npm run server
npm run db:setup
npm run typecheck
npm run build:web
```

## Environment and AI providers

`.env.local` is local-only and must never be committed or printed. The planner
supports these exact provider key names and their numbered aliases:

```text
GROQ_API_KEY, GROQ2_API_KEY
GEMINI_API_KEY, GEMINI2_API_KEY
OPENROUTER_API_KEY, OPENROUTER2_API_KEY
NVIDIA_API_KEY, NVIDIA2_API_KEY
```

It also supports `KEY_1` and `KEY_2` aliases. Provider order is:

1. Groq key 1, then key 2
2. Gemini key 1, then key 2
3. OpenRouter key 1, then key 2
4. NVIDIA key 1, then key 2

Default models are `llama-3.1-8b-instant`, `gemini-2.0-flash`,
`openrouter/free`, and `nvidia/nemotron-3-ultra-550b-a55b`, respectively.
Model overrides are `GROQ_MODEL`, `GEMINI_MODEL`, `OPENROUTER_MODEL`, and
`NVIDIA_MODEL`.

Provider endpoints are:

- Groq: `https://api.groq.com/openai/v1`
- Gemini: `https://generativelanguage.googleapis.com/v1beta/openai`
- OpenRouter: `https://openrouter.ai/api/v1`
- NVIDIA: `https://integrate.api.nvidia.com/v1`

`apps/web/lib/agent.ts` sends OpenAI-compatible chat-completions requests,
validates the JSON plan, and continues to the next key/provider after
timeouts, rate limits, rejected credentials, HTTP errors, empty responses, or
invalid plans. It must never return a fake plan after all providers fail.

## Authentication and GitHub

Google and GitHub OAuth callbacks are under
`apps/web/app/api/auth/callback`. Sessions are signed with `AUTH_SECRET` and
stored in an HttpOnly cookie. Public repository search, issue loading, metadata
lookup, and cloning work without repository ownership or a GitHub OAuth token.
GitHub access is required for private repositories, the signed-in user's
repository list, and pull requests. Never expose OAuth secrets or GitHub access
tokens to browser code.

## Collaboration behavior

The collaboration server is `apps/server/src/server.js`, with UI in the
collaboration section of `apps/web/app/page.tsx`.

- Room codes are six-character alphanumeric values.
- A room code alone never grants access.
- Join requests are `pending` until approved by the room owner.
- Only the owner can approve or remove another member.
- A non-owner approved member can leave.
- Editor changes are broadcast only to approved members.
- WebSocket authentication uses a short-lived signed token from
  `/api/collaboration/token`.
- PostgreSQL stores room state in `collaboration_rooms`.
- The room owner is upserted into `users` before room insertion, preventing the
  `collaboration_rooms_owner_id_fkey` failure.

`GET /ready` must return HTTP 200 with `ok: true` before testing room creation.
The server reports `persistence: postgresql` when a real `DATABASE_URL` is
configured.

## Main files

- `apps/web/app/page.tsx`: app shell and workflow UI.
- `apps/web/lib/agent.ts`: AI provider routing and plan validation.
- `apps/web/lib/auth.ts`: OAuth sessions and collaboration tokens.
- `apps/web/lib/github.ts`: GitHub integration.
- `apps/web/lib/workspace.ts`: isolated workspace operations.
- `apps/server/src/server.js`: rooms, membership, persistence, and broadcasts.
- `apps/web/db/001_initial.sql`: database schema.
- `scripts/dev.js`: combined Windows development launcher.
- `package-lock.json`: root npm workspace lockfile.

## Operational notes

- The launcher sets `NEXT_IGNORE_INCORRECT_LOCKFILE=1` for the web process
  because Next.js 14.2.x attempts an incompatible workspace lockfile patch on
  Windows.
- The root lockfile must remain synchronized with package manifests.
- Never report or paste secret values while debugging configuration.
- Keep `.env.local`, API keys, OAuth credentials, generated workspaces, and
  runtime state out of commits.

## Validation expectations

1. Run the smallest relevant typecheck or syntax check.
2. Run `npm run validate:env` for environment changes.
3. Verify `/ready` for collaboration changes.
4. Verify the relevant browser interaction for UI changes.