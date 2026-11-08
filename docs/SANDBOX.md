# Docker sandbox (Phase 2)

Tests in a target repository are untrusted code. AgentX no longer runs them
on the host. `POST /api/workspace/test` now runs the allowlisted command
inside a disposable Docker container, and fails closed when Docker is not
available.

> This sandbox runs **only where a Docker daemon exists** — a self-hosted
> machine. On Vercel the endpoint returns 503 by design (no Docker daemon
> on serverless functions), and nothing runs on the host instead.

## What runs where

| Step | Host | Container |
| --- | --- | --- |
| Clone, edit, diff, approval, PR | Yes | No |
| Test command (`npm test`, `pytest`, …) | No — the old host `exec` path was removed | Yes, in `/work` |

The container sees exactly one directory: a disposable copy of the
workspace, mounted at `/work`. The original workspace is never mounted, so
a test cannot edit the user's branch directly. The copy is deleted after
every run, pass or fail. `.git`, `.env` files, and `*.pem` / `*.key` files
are not copied into the container at all.

## Isolation flags

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
AGENTX_SANDBOX_CPUS=2
AGENTX_SANDBOX_MEMORY=1g
AGENTX_SANDBOX_MEMORY_SWAP=1g
AGENTX_SANDBOX_PIDS_LIMIT=256
AGENTX_SANDBOX_TIMEOUT_MS=600000
AGENTX_SANDBOX_USER=
AGENTX_SANDBOX_IMAGE_NODE=node:20-bookworm-slim
AGENTX_SANDBOX_IMAGE_PYTHON=python:3.12-slim
AGENTX_SANDBOX_IMAGE_DOTNET=mcr.microsoft.com/dotnet/sdk:8.0
AGENTX_SANDBOX_IMAGE_RUST=rust:1.82-bookworm
AGENTX_SANDBOX_IMAGE_GO=golang:1.22-bookworm
```

Invalid values fail the test run with a configuration error, not with a
silent default.

## Fail-closed behaviour

- Docker CLI missing, daemon down, or `docker info` failing →
  `POST /api/workspace/test` returns **503** with "Docker is not
  available…". The test is not run on the host.
- Non-allowlisted command → 400, before Docker is invoked.
- Workspace outside `WORKSPACE_ROOT` → 400, before Docker is invoked.
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
is reported `reproduced`, a passing one `not-reproduced`, and Docker
being unavailable is reported `not-run` with the reason attached. The
repro result is evidence about that test command only; it is never a
diagnosis, and it never blocks planning.

## Prerequisites

- Docker Engine or Docker Desktop installed and running on the machine
  that runs the AgentX web server. On Windows, that is the machine
  running `npm run dev`; WSL2-backed Docker Desktop works with the same
  `docker` CLI.
- No Docker daemon access is needed by the browser. Only the server
  invokes the `docker` CLI.
- The first run for a language pulls its image (`docker pull` by the
  daemon, outside the container). Allow that once per image, or
  pre-pull with `docker pull node:20-bookworm-slim` (and the other
  images you need).

## Known limits (not hidden)

1. **No sandboxed dependency install yet.** Containers start from a
   clean language image. A project that needs `npm install` or
   `pip install` before its tests will fail in the sandbox until a
   sandboxed install step is added in a later phase. Dependencies
   already present in the workspace copy are used as-is.
2. **Approval trusts the client-reported test flag in the UI path.**
   See the section above. The server stores proofs and verifies them
   when a caller supplies `testProof`, but the UI does not send it yet,
   so a UI approval still rests on `testPassed` in the signed payload.
3. **A container is not a security proof.** `--cap-drop ALL`,
   `no-new-privileges`, no network, and a read-only root filesystem
   substantially raise the bar over host execution, but a kernel or
   Docker escape is still a different class of risk than a test script
   reading host files — which this sandbox does block.
4. **Vercel cannot run the sandbox.** No Docker daemon exists on
   serverless functions, so tests there always answer 503. This is by
   design; the full run (plan → fix → test → approve → PR) only works
   self-hosted. See [docs/E2E-RUN.md](./E2E-RUN.md).
