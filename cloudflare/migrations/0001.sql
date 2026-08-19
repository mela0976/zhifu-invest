CREATE TABLE IF NOT EXISTS oauth_states (
  state_hash TEXT PRIMARY KEY,
  nonce TEXT NOT NULL,
  return_to TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);

CREATE INDEX IF NOT EXISTS oauth_states_expiry_idx
  ON oauth_states (expires_at);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  line_user_id TEXT NOT NULL,
  member_id TEXT,
  display_name TEXT NOT NULL,
  picture_url TEXT,
  role TEXT NOT NULL CHECK (role IN ('member', 'admin')),
  friendship_status TEXT NOT NULL CHECK (friendship_status IN ('friend', 'not_friend', 'unknown')),
  csrf_token TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS sessions_expiry_idx
  ON sessions (expires_at);

CREATE INDEX IF NOT EXISTS sessions_line_user_idx
  ON sessions (line_user_id);

CREATE TABLE IF NOT EXISTS deck_tokens (
  token_hash TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  object_key TEXT NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS deck_tokens_expiry_idx
  ON deck_tokens (expires_at);

CREATE TABLE IF NOT EXISTS webhook_events (
  webhook_event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  forwarded_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);

CREATE INDEX IF NOT EXISTS webhook_events_received_idx
  ON webhook_events (received_at);
