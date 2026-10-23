# AgentX

AgentX is a free, self-hostable Windows desktop workspace for an agent that
investigates GitHub issues, changes code in an isolated workspace, runs tests,
and waits for human approval before pushing or opening a pull request.

## Current implementation slice

- Next.js/React/TypeScript web UI
- Electron packaging entry point for Windows
- WebSocket collaboration protocol with owner approval
- Six-character alphanumeric room codes
- Explicit approval state for irreversible agent actions
- No paid service is required for the local development path

See [all api keys.md](./all%20api%20keys.md) for the credentials and
configuration needed for optional integrations.

## Development

```powershell
npm install
npm run dev
```

The local-model path can use any local OpenAI-compatible endpoint. Do not add
secrets to source control.

## Google sign-in

Start the web app with the repository root `.env.local` loaded by Next.js:

```powershell
npm run dev
```

Then open `http://localhost:3000` and select **Sign in with Google**. The
callback URI configured in Google Cloud must exactly match:

```text
http://localhost:3000/api/auth/callback/google
```

The Google client secret is used only by the server-side callback. Sessions are
signed with `AUTH_SECRET` and stored in an HttpOnly cookie; no OAuth secret is
sent to browser code.

## Collaboration server

Run the self-hosted collaboration service in a second terminal:

```powershell
$env:COLLABORATION_DEV_MODE = "true"
npm run server
```

The server exposes `GET http://localhost:8787/health` and a WebSocket endpoint
at `ws://localhost:8787`. In development mode, the client supplies a temporary
identity in each protocol message. This mode is intentionally disabled unless
`COLLABORATION_DEV_MODE=true` is set.

Production authentication is not simulated: the OAuth/session adapter must be
implemented and connected before this server is exposed to other machines.

For production persistence, apply [001_initial.sql](./apps/web/db/001_initial.sql)
to PostgreSQL and set a real `DATABASE_URL`; the collaboration server will use
the `collaboration_rooms` table automatically. Without a valid database URL,
local development uses the ignored `data/collaboration-rooms.json` file.

After creating the `agentx` database, initialize the schema with:

```powershell
npm run db:setup
```

The agent workspace APIs clone repositories into `WORKSPACE_ROOT`, prevent path
traversal, allow only an explicit test-command allowlist, and require a signed
human approval token before pushing a branch or opening a pull request.

See [production readiness](./docs/PRODUCTION-READINESS.md) for deployment,
performance, reliability, availability, installer, signing, and remaining
environment requirements.
