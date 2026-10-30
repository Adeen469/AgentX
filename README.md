# AgentX

AgentX is a free, self-hostable Windows desktop workspace for an agent that
investigates GitHub issues, changes code in an isolated workspace, runs tests,
and waits for human approval before pushing or opening a pull request.

## Current implementation slice

- Next.js/React/TypeScript web UI
- Electron packaging entry point for Windows
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

## GitHub sign-in (the only sign-in)

Start the web app with the repository root `.env.local` loaded by Next.js:

```powershell
npm run dev
```

Then open `http://localhost:3000` and select **Sign in with GitHub**. The
callback URI configured in the GitHub OAuth app must exactly match:

```text
http://localhost:3000/api/auth/callback/github
```

The GitHub client secret is used only by the server-side callback. Sessions are
signed with `AUTH_SECRET` and stored in an HttpOnly cookie; no OAuth secret is
sent to browser code.

## Collaboration (removed)

Collaborative rooms were removed on 2026-10-30. There is no collaboration server, no `/collab` route, and no room UI. PS-05 is a single-user bug-fix agent.

The agent workspace APIs clone repositories into `WORKSPACE_ROOT`, prevent path
traversal, allow only an explicit test-command allowlist, and require a signed
human approval token before pushing a branch or opening a pull request.

## Vercel deployment

Deploy the web service only (Next.js, public at `/` including `/api/*`) from the repo-root `vercel.json`. There is no collaboration container service.

## Docker sandbox (Phase 2)

Tests never run on the host. `POST /api/workspace/test` runs the
allowlisted command inside a disposable Docker container with no network,
dropped capabilities, a read-only root filesystem, CPU/memory/process
limits, and only a disposable copy of the workspace mounted at `/work`.
If Docker is missing or its daemon is down, the test fails with a 503
instead of falling back to host execution. Docker must be installed and
running on the machine that runs the web server. See
[docs/SANDBOX.md](./docs/SANDBOX.md) for the full threat model, image
table, configuration, and known limits (including: no sandboxed
dependency-install step yet).

See [production readiness](./docs/PRODUCTION-READINESS.md) for deployment,
performance, reliability, availability, installer, signing, and remaining
environment requirements.
