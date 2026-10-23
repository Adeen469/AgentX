CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  picture TEXT,
  provider TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS collaboration_rooms (
  code CHAR(6) PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  state JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_actions (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  repository TEXT NOT NULL,
  action TEXT NOT NULL,
  details JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS approval_requests (
  id UUID PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  repository TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('push_branch', 'open_pull_request')),
  payload JSONB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')) DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);
