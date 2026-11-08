# Sandboxed test execution (Docker + Windows AppContainer)

Tests in a target repository are untrusted code. AgentX no longer runs them
on the host. `POST /api/workspace/test` runs the allowlisted command in a
sandbox — Docker, or the Windows AppContainer worker when the desktop app
is used — and fails closed when no backend is available.

> This sandbox runs **only where a backend exists** — a self-hosted
> machine with Docker, or a Windows machine running the AgentX desktop
> app (AppContainer worker). On Vercel neither exists, so the endpoint
> returns 503 by design (no Docker daemon on serverless functions), and
> nothing runs on the host instead.

## Backend selection

`apps/web/lib/sandbox.ts` picks a backend at runtime, per request
(`detectSandboxBackend`):

| Situation | Backend used |
| --- | --- |
| Windows + `agentx-worker.exe` found | **AppContainer** (no Docker needed) |
| Anywhere + Docker daemon available | **Docker** |
| Neither | **unavailable** → 503, fail closed |

`AGENTX_SANDBOX_BACKEND` forces one (`docker` | `appcontainer` |
`auto`, default `auto`). A forced backend that is missing also yields
"unavailable" — never a host run.

## Docker backend

### What runs where

| Step | Host | Container |
| --- | --- | --- |
| Clone, edit, diff, approval, PR | Yes | No |
| Test command (`npm test`, `pytest`, …) | No — the old host `exec` path was removed | Yes, in `/work` |

The container sees exactly one directory: a disposable copy of the
workspace, mounted at `/work`. The original workspace is never mounted, so
a test cannot edit the user's branch directly. The copy is deleted after
every run, pass or fail. `.git`, `.env` files, and `*.pem` / `*.key` files
are not copied into the container at all.

### Isolation flags

Every run uses (`apps/web/lib/sandbox.ts`, `buildDockerRunArgs`):

- `--network none` — no outbound network from the container.
- `--cap-drop ALL` and `--security-opt no-new-privileges`.
- `--read-only` root filesystem, with only `/work` and a tmpfs `/tmp`
  writable.
- `--cpus 2`, `--memory 1g`, `--memory-swap 1g`, `--pids-limit 256`
  (all overridable, see below).
- A non-root `--user`: the host user on Linux/macOS, `10001:10001` on
  Windows and whenever the server itself runs as root, unless overridden.
  In the `10001` case the disposable staging copy (only) is made writable
  for that user; the original workspace is never re-permissioned.
- `--rm`, plus an explicit `docker rm -f` if a run times out, so a timed
  out container cannot keep running.
- No host environment is passed. Docker does not forward host env vars
  unless asked, and this code only sets `HOME=/tmp` and `CI=true` inside
  the container. Never add `--env-file` or forward `process.env` here.

## AppContainer backend (Windows desktop, no Docker)

The desktop user runs **only AgentX.exe**: no Docker install, no WSL,
no visible console. On Windows, test commands run inside a Windows
**AppContainer** — the OS-native low-integrity sandbox Microsoft Edge
uses — driven by a small Rust helper, `agentx-worker.exe`, shipped
inside the installer as a Tauri resource
(`apps/desktop/src-tauri/src/bin/agentx-worker.rs`).

### How it works

1. The server (`lib/sandbox.ts`) finds the worker: `AGENTX_WORKER_PATH`
   first, then the installed app's resources
   (`<install>\resources\agentx-worker.exe`), then the Tauri crate
   (dev). If none resolves, the backend reports `unavailable` and the
   run fails closed with 503.
2. The worker opens (or creates, once) the **"AgentXWorker"**
   AppContainer profile and derives its SID. No admin / elevation is
   required — profiles are per-user, the same mechanism Chromium uses
   without admin rights.
3. The worker grants that SID access **only to the disposable staging
   copy** of the workspace (an explicit DACL entry merged into the
   directory's existing permissions). Nothing else on the filesystem,
   registry, or other processes is reachable from inside the container.
4. It spawns `cmd.exe /c <command>` inside the container
   (`CreateProcessAsUserW` + AppContainer security capabilities,
   `CREATE_NO_WINDOW`). The worker itself is a GUI-subsystem binary, so
   no console window ever appears.
5. A **Job Object** enforces the limits: `KILL_ON_JOB_CLOSE`
   (everything the test spawned dies if AgentX closes or crashes), a
   process/job memory cap (`AGENTX_SANDBOX_MEMORY`, default 1g), a hard
   CPU cap (`AGENTX_SANDBOX_CPUS`, default 2), and a wall-clock timeout
   (`AGENTX_SANDBOX_TIMEOUT_MS`, default 10 min) that kills the job and
   reports a timeout result.
6. The worker captures stdout/stderr through pipes (capped at 4 MiB
   total), computes the sha256 output hash + excerpt with the same
   algorithm as the server, and prints **one JSON result** on stdout.
   The server stores it as a `test_runs` proof row exactly like a Docker
   run — same columns, same approval verification.

### What is allowed / blocked

| | AppContainer run |
| --- | --- |
| Workspace staging copy (read + write) | Yes — the only whitelisted directory |
| Rest of the filesystem, registry, other processes | No (default-deny; the container SID has no access) |
| Network | No — no network capability is granted, tests run offline |
| Host environment (tokens, secrets) | No — only a minimal env crosses over (`Path`, `SystemRoot`, `TEMP`/`TMP`/`HOME` inside the staging copy, `CI=true`) |

### Requirements and limits

- **Windows 10 / 11, any edition.** AppContainer is part of the base
  OS and works on **Home** too — unlike Windows Sandbox, which needs
  Pro. No Docker, no WSL, no extra install.
- **Toolchains must be installed machine-wide** (e.g. Node.js in
  `C:\Program Files`). User-profile installs (e.g. Rustup in
  `%USERPROFILE%\.cargo`) are not reachable from the container, because
  the container SID has no access to the user profile. If a toolchain
  is missing, the test fails with a clear "command not found" inside
  the container — it never falls back to the host.
- **Tests needing network will fail** (no network capability), and
  **tests needing Linux-only tooling will fail** (there is no Linux
  inside an AppContainer). Docker remains the backend for those — run
  the server on a machine with Docker, or set
  `AGENTX_SANDBOX_BACKEND=docker`.
- **No sandboxed dependency install yet** (same as Docker): a project
  that needs `npm install` / `pip install` before its tests will fail
  until a sandboxed install step is added. Dependencies already in the
  workspace copy are used as-is.
- The worker re-validates the command against the same allowlist as the
  server, so a direct invocation can never run an arbitrary command in
  the container.

### Windows smoke test (owner — do this on a real Windows machine)

The AppContainer runtime path **cannot be tested on Linux** (the APIs
do not exist there), so this is a manual owner step. It has not been
run yet — do not claim it works until it does:

1. Install the new build (`AgentX_0.1.0_x64-setup.exe`) and confirm **no
   console window** appears when the app launches.
2. Confirm the worker shipped: `<install>\resources\agentx-worker.exe`
   exists.
3. Run `002_test_runs.sql` in Supabase SQL Editor first (the
   `test_runs` table must exist for proofs to be stored).
4. In the app: sign in, create a workspace from a small repo, run
   `npm test` (or another allowlisted command).
5. Check the response says `backend: "appcontainer"` and the run has a
   `proof` with `stored: true`.
6. In Supabase, confirm the row: `SELECT * FROM test_runs ORDER BY
   created_at DESC LIMIT 5;` — `exit_code` 0 on a passing run.
7. Approve the run and confirm the approval uses the stored proof
   (`testProof: { runId, outputHash }`), then check the PR opens.
8. Negative checks: run a command that needs network (it must fail
   inside the container, not on the host), and stop the app mid-test
   (the test processes must die with it — Job Object kill-on-close).

## Image selection

The image follows the test command, not a file-name guess:

| Command | Default image |
| --- | --- |
| `npm test`, `npm run test`, `npm run lint` | `node:20-bookworm-slim` |
| `pytest` | `python:3.12-slim` |
| `dotnet test` | `mcr.microsoft.com/dotnet/sdk:8.0` |
| `cargo test` | `rust:1.82-bookworm` |
| `go test ./...` | `golang:1.22-bookworm` |

Docker pulls the image on first use if it is not present locally. That
pull is done by the Docker daemon, outside the container's `--network
none` namespace.

## Configuration

All optional, all in the server environment (see `.env.example`):

```text
AGENTX_SANDBOX_BACKEND=auto
AGENTX_SANDBOX_CPUS=2
AGENTX_SANDBOX_MEMORY=1g
AGENTX_SANDBOX_MEMORY_SWAP=1g
AGENTX_SANDBOX_PIDS_LIMIT=256
AGENTX_SANDBOX_TIMEOUT_MS=600000
AGENTX_SANDBOX_USER=
AGENTX_WORKER_PATH=
AGENTX_SANDBOX_IMAGE_NODE=node:20-bookworm-slim
AGENTX_SANDBOX_IMAGE_PYTHON=python:3.12-slim
AGENTX_SANDBOX_IMAGE_DOTNET=mcr.microsoft.com/dotnet/sdk:8.0
AGENTX_SANDBOX_IMAGE_RUST=rust:1.82-bookworm
AGENTX_SANDBOX_IMAGE_GO=golang:1.22-bookworm
```

`AGENTX_SANDBOX_BACKEND` selects the backend (`auto` | `docker` |
`appcontainer`). `AGENTX_WORKER_PATH` overrides where the server looks
for `agentx-worker.exe`. The CPU / memory / timeout values apply to
both backends (the worker translates them into Job Object caps).
`AGENTX_SANDBOX_MEMORY_SWAP`, `AGENTX_SANDBOX_PIDS_LIMIT`,
`AGENTX_SANDBOX_USER`, and the `AGENTX_SANDBOX_IMAGE_*` values are
Docker-only.

Invalid values fail the test run with a configuration error, not with a
silent default.

## Fail-closed behaviour

- No backend available (no worker on Windows and no Docker anywhere)
  → `POST /api/workspace/test` returns **503** with "No sandbox
  backend is available…". The test is not run on the host.
- Docker CLI missing, daemon down, or `docker info` failing → 503
  with "Docker is not available…" (Docker backend only).
- Worker binary missing or crashing, or worker output that is not valid
  JSON → 503 with "AppContainer sandbox failed before the test could
  run…" (AppContainer backend only).
- Non-allowlisted command → 400, before any backend is invoked.
- Workspace outside `WORKSPACE_ROOT` → 400, before any backend is invoked.
- Docker daemon / image error (exit 125, daemon or image errors) →
  infrastructure error, not a "test failed" result.
- A test command exiting non-zero → a normal `passed: false` result
  with its stdout/stderr, and the container and staging copy are still
  cleaned up.

## Approval binding — what the server checks, and what it does not

The approval gate **is** bound to the test result at the API level, which
is a change from the earlier Phase 2 state:

- The UI only offers approval when it holds a passing test result and a
  non-empty diff.
- `POST /api/agent/approval` refuses a `open_pull_request` approval unless
  the payload carries `testPassed: true` and a non-empty `diff`.
- `POST /api/github/pull-request` re-verifies the signed approval token
  and re-checks `testPassed === true` and a non-empty diff before pushing
  or opening the PR.

On top of that, every sandboxed test run is now **stored server-side**:
`POST /api/workspace/test` records the run in `test_runs` (run id,
branch, command, exit code, output hash + excerpt) and returns
`proof: { ..., stored: true/false }`; proofs are readable via
`GET /api/workspace/test?runId=<id>` or `?branch=<branch>`, and
`GET /api/workspace/diff` returns the branch's recent proofs. When a
caller supplies `testProof: { runId, outputHash? }` to
`POST /api/agent/approval`, approval is issued only if the stored row
shows exit code 0 (and the hash matches when given) — and the request
fails closed 503 when the database cannot be read.

What the server does **not** do yet: the in-app UI does not send
`testProof`, so a UI approval still rests on the client-reported
`testPassed` flag inside the signed payload — the server checks the flag,
not a stored record, unless the caller supplies a proof. The PR route
likewise re-checks only the token's flag. Until the UI sends the proof,
treat a stored row (visible via `GET /api/workspace/test`) as the
independent evidence for a run, and the UI approval as flag-based.

## Autonomous reproduction uses the same sandbox

`POST /api/agent/repro` — and the plan step, which runs it first —
reuses `runSandboxedTest` with one allowlisted command (default
`npm test`; issue text never supplies a raw command). A failing command
is reported `reproduced`, a passing one `not-reproduced`, and no backend
being available is reported `not-run` with the reason attached (the
response also carries `sandboxBackend: "docker" | "appcontainer" |
null`). The repro result is evidence about that test command only; it is
never a diagnosis, and it never blocks planning.

## Prerequisites

- **Docker backend:** Docker Engine or Docker Desktop installed and
  running on the machine that runs the AgentX web server. On Windows,
  that is the machine running `npm run dev`; WSL2-backed Docker Desktop
  works with the same `docker` CLI.
- **AppContainer backend:** Windows 10 / 11 (any edition, including
  Home) running the AgentX desktop app — the installer ships
  `agentx-worker.exe`, nothing else to install. No Docker, no WSL.
- No Docker daemon access is needed by the browser. Only the server
  invokes the `docker` CLI or the worker.
- The first Docker run for a language pulls its image (`docker pull` by
  the daemon, outside the container). Allow that once per image, or
  pre-pull with `docker pull node:20-bookworm-slim` (and the other
  images you need).

## Known limits (not hidden)

1. **No sandboxed dependency install yet.** Docker containers start
   from a clean language image and the AppContainer worker uses the
   host's machine-wide toolchains. A project that needs `npm install`
   or `pip install` before its tests will fail in the sandbox until a
   sandboxed install step is added in a later phase. Dependencies
   already present in the workspace copy are used as-is.
2. **Approval trusts the client-reported test flag in the UI path.**
   See the section above. The server stores proofs and verifies them
   when a caller supplies `testProof`, but the UI does not send it yet,
   so a UI approval still rests on `testPassed` in the signed payload.
3. **A container is not a security proof.** `--cap-drop ALL`,
   `no-new-privileges`, no network, and a read-only root filesystem
   (Docker) / a default-deny AppContainer SID with no network
   capability (AppContainer) substantially raise the bar over host
   execution, but a kernel or runtime escape is still a different class
   of risk than a test script reading host files — which both sandboxes
   do block.
4. **Vercel cannot run the sandbox.** No Docker daemon and no
   AppContainer worker exist on serverless functions, so tests there
   always answer 503. This is by design; the full run (plan → fix →
   test → approve → PR) only works self-hosted or in the desktop app.
   See [docs/E2E-RUN.md](./E2E-RUN.md).
5. **AppContainer is Windows-only and offline.** Tests needing network
   or Linux-only tooling fail in the AppContainer backend; Docker
   remains the backend for those. The AppContainer runtime path has
   not been executed on a real Windows machine yet (see the smoke test
   above) — the code compiles for the Windows target, but a live run
   is still owed.
