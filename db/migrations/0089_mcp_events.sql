-- MCP Events (docs/mcp-events.md; lib/mcp-events/*): a ChatGPT session
-- connected to https://lianki.com/mcp with a chat token subscribes to
-- `chat.mention`, and is woken by a signed webhook when a person writes
-- @<token name> in that token's own chat thread. Behind the flag mcp.events (off).

-- One subscription. `id` is deterministic (sub_ + SHA-256 of the token hash,
-- callback URL, event name and canonical arguments), so a re-subscribe is an
-- upsert and an unsubscribe finds it again. `thread` is the token's own thread
-- when it subscribed; every delivery re-checks the token live and re-derives it.
-- The signing secret is sealed (AES-GCM, key from AUTH_SECRET, AAD = id and
-- token): never stored in the clear. `prev_secret_sealed` signs too until
-- `prev_until_ms`, while the client rotates its secret.
CREATE TABLE IF NOT EXISTS mcp_event_subscription (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  user_id TEXT NOT NULL,
  thread TEXT NOT NULL,
  name TEXT NOT NULL,
  arguments TEXT NOT NULL,
  url TEXT NOT NULL,
  secret_sealed TEXT NOT NULL,
  prev_secret_sealed TEXT,
  prev_until_ms INTEGER,
  expires_at_ms INTEGER NOT NULL,
  verified_at_ms INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  last_event_at_ms INTEGER,
  failures INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_mcp_event_sub_thread ON mcp_event_subscription(thread, name);
CREATE INDEX IF NOT EXISTS idx_mcp_event_sub_token ON mcp_event_subscription(token_hash);

-- Revocation: whatever deletes a token row (revoke one, sign out everywhere,
-- the account deleted) deletes its subscriptions in the same statement, and so
-- does disconnecting an OAuth app (its grant row; its token rows may stay, dead).
-- Every delivery re-checks the token live as well (lib/api-tokens.ts checkToken).
CREATE TRIGGER IF NOT EXISTS mcp_event_sub_token_gone AFTER DELETE ON api_tokens
BEGIN
  DELETE FROM mcp_event_subscription WHERE token_hash = OLD.token_hash;
END;
CREATE TRIGGER IF NOT EXISTS mcp_event_sub_grant_gone AFTER DELETE ON mcp_oauth_grant
BEGIN
  DELETE FROM mcp_event_subscription
  WHERE token_hash IN (SELECT token_hash FROM api_tokens WHERE oauth_grant_id = OLD.id);
END;
