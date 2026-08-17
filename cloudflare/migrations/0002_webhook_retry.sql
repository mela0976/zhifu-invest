ALTER TABLE webhook_events ADD COLUMN destination TEXT;
ALTER TABLE webhook_events ADD COLUMN payload_json TEXT;
ALTER TABLE webhook_events ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'
  CHECK (status IN ('pending', 'processing', 'retry', 'delivered', 'failed'));
ALTER TABLE webhook_events ADD COLUMN next_attempt_at INTEGER;
ALTER TABLE webhook_events ADD COLUMN updated_at INTEGER;

UPDATE webhook_events
   SET status = CASE WHEN forwarded_at IS NOT NULL THEN 'delivered' ELSE 'failed' END,
       next_attempt_at = NULL,
       updated_at = received_at;

CREATE INDEX IF NOT EXISTS webhook_events_retry_idx
  ON webhook_events (status, next_attempt_at, received_at);
