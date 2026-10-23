# Production readiness and remaining blockers

AgentX now has production-oriented code paths, but a production deployment
still requires these environment and operational steps.

## Required before a real release

1. **PostgreSQL database**
   - Create a database named `agentx`.
   - Set `DATABASE_URL` to a real connection string.
   - Run `npm run db:setup`.
   - Confirm `GET /ready` returns HTTP 200.

2. **OAuth callback configuration**
   - Register the exact Google and GitHub callback URLs for the deployed domain.
   - Do not use localhost callbacks in production.
   - Rotate any OAuth or AI credentials that were exposed during development.

3. **HTTPS and WebSocket TLS**
   - Put the web and collaboration services behind HTTPS/WSS.
   - Set secure cookies in production.
   - Configure a reverse proxy with request limits and health checks.

4. **Secrets**
   - Move secrets out of `.env.local` into the deployment secret store.
   - Set `AUTH_SECRET` to a new random value in production.
   - Never ship OAuth client secrets or `GROQ_API_KEY` inside the Electron renderer.

5. **Electron release signing**
   - Obtain an Authenticode code-signing certificate.
   - Configure `CSC_LINK` and `CSC_KEY_PASSWORD` for electron-builder.
   - Without signing, Windows SmartScreen may warn users.

6. **Installer build dependencies**
   - Allow downloads from npm and GitHub release assets.
   - Run `npm install` without `--ignore-scripts` so Electron downloads its runtime.
   - Run `npm run build --workspace @agentx/web`.
   - Run `npm run package --workspace @agentx/desktop`.

## Operational expectations

- **Performance:** connection pooling, bounded WebSocket payloads, rate limits,
  shallow Git clones, and allowlisted test commands reduce latency and resource
  use. Production load testing is still required.
- **Reliability:** atomic file persistence for local development, PostgreSQL
  persistence for production, process health/readiness endpoints, WebSocket
  heartbeat, graceful shutdown, and explicit error responses are implemented.
- **Availability:** deploy at least two web/server instances behind a reverse
  proxy and use PostgreSQL backups. The current in-memory WebSocket connection
  registry is single-instance; multi-instance collaboration needs a shared
  pub/sub layer such as Redis.
- **Maintainability:** providers, auth, GitHub, workspace, approval, and
  persistence are separated into modules; database migrations are versioned.
- **Usability:** the installer uses a license page, install-location page,
  progress UI, desktop/start-menu shortcuts, optional portable output, and
  Explorer context-menu entries.

## Installer behavior

The NSIS installer is configured with:

- License agreement
- Custom installation directory
- Progress bar
- Desktop shortcut
- Start Menu shortcut
- Launch-after-install option
- Portable executable target
- Explorer context menu for folders and folder backgrounds
- User-level installation by default

