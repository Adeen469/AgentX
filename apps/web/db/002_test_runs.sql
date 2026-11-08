-- 002_test_runs.sql — AgentX migration 002
--
-- Server-stored test-pass proofs: when the sandbox (or a CI-style run)
-- executes a test command for a branch, the result is recorded here so a
-- later step can prove "tests passed on branch X" without trusting a
-- client-supplied claim. A run is identified by its caller-supplied run_id
-- (TEXT, e.g. "run-<uuid>" or a CI run id); re-recording the same run_id is
-- a no-op for the writer (ON CONFLICT DO NOTHING).
--
-- Also adds indexes for the hot lookups of the 001 tables. 001 itself is
-- left untouched; these indexes are idempotent and safe to apply on a
-- database that already ran 001.
--
-- Idempotent: every statement uses IF NOT EXISTS. Safe to re-run.

CREATE TABLE IF NOT EXISTS test_runs (
  run_id TEXT PRIMARY KEY,
  branch TEXT NOT NULL,
  command TEXT NOT NULL,
  exit_code INTEGER NOT NULL,
  output_hash TEXT,
  output_excerpt TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Hot lookup: latest runs for a branch (proof lookup + history view).
CREATE INDEX IF NOT EXISTS idx_test_runs_branch_created_at
  ON test_runs (branch, created_at DESC);

-- Hot lookup: latest runs overall, regardless of branch.
CREATE INDEX IF NOT EXISTS idx_test_runs_created_at
  ON test_runs (created_at DESC);

-- Indexes for 001 tables (hot lookups; 001_initial.sql is not modified).
-- agent_actions: per-user audit history, newest first.
CREATE INDEX IF NOT EXISTS idx_agent_actions_user_created_at
  ON agent_actions (user_id, created_at DESC);

-- approval_requests: pending approvals for a user, newest first.
CREATE INDEX IF NOT EXISTS idx_approval_requests_user_status_created_at
  ON approval_requests (user_id, status, created_at DESC);

-- NOTE: no index is added for collaboration_rooms — collaboration was
-- removed from AgentX, so that table has no hot lookups anymore.
