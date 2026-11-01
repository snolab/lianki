-- Sign-out notices to lianki-push's debug hub that did not get through
-- (lib/push-signed-out.ts; docs/monitoring.md, "Renewal"). One row per
-- session tag (a SHA-256 of a session id, never the id): retried with an
-- exponential backoff (`next_ms`) on later events until the hub acknowledges
-- it, then deleted; dropped unsent once no renewal chain could still use it.
CREATE TABLE IF NOT EXISTS debug_signout_outbox (
  tag     TEXT PRIMARY KEY,
  at_ms   INTEGER NOT NULL,
  tries   INTEGER NOT NULL DEFAULT 0,
  next_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_debug_signout_outbox_next ON debug_signout_outbox(next_ms);
