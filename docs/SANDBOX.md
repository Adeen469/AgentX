# Docker sandbox (Phase 2)

Tests in a target repository are untrusted code. AgentX no longer runs them
on the host. `POST /api/workspace/test` now runs the allowlisted command
inside a disposable Docker container, and fails closed when Docker is not
available.

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

## Prerequisites

- Docker Engine or Docker Desktop installed and running on the machine
  that runs the AgentX web server. On Windows, that is the machine
  running `npm run dev`; WSL2-backed Docker Desktop works with the same
  `docker` CLI.
- No Docker daemon access is needed by the browser. Only the server
  invokes the `docker` CLI.

## Known limits (not hidden)

1. **No sandboxed dependency install yet.** Containers start from a
   clean language image. A project that needs `npm install` or
   `pip install` before its tests will fail in the sandbox until a
   sandboxed install step is added in a later phase. Dependencies
   already present in the workspace copy are used as-is.
2. **Approval is not yet bound to the test result.** The UI still gates
   approval on a passing test, but the server does not yet verify that
   binding. That is Phase 1 / Phase 5 work, and the sandbox does not
   claim to fix it.
3. **A container is not a security proof.** `--cap-drop ALL`,
   `no-new-privileges`, no network, and a read-only root filesystem
   substantially raise the bar over host execution, but a kernel or
   Docker escape is still a different class of risk than a test script
   reading host files — which this sandbox does block.
