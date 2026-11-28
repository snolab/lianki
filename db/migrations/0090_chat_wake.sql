-- Chat wake (docs/chat-wake.md; lib/chat-wake/): every @mention of a token in
-- its own chat thread, kept as one row, so any agent can be woken: pushed
-- (ChatGPT's MCP Events webhook) or pulled (lianki_chat_mentions_since and
-- MCP events/poll, for a Gemini scheduled action, local agents, any client).
-- Behind the flags mcp.events (the core) and chat.wake.pull (reading).

-- One mention of one token by one person's line. `id` is the event id
-- (men_ + SHA-256 of the token hash and the line id), so a line put twice is
-- one row. `seq` orders the rows for cursor paging; AUTOINCREMENT, so a seq is
-- never reused even after retention deletes every row. `token_id` is the API
-- token's public id (api_tokens.token_hash); only that token ever reads it.
CREATE TABLE IF NOT EXISTS chat_mention (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  token_id TEXT NOT NULL,
  thread TEXT NOT NULL,
  line_id TEXT NOT NULL,
  text TEXT NOT NULL,
  author TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
-- Paging: (created_at, seq) per token, the cursor's stable order.
CREATE INDEX IF NOT EXISTS idx_chat_mention_token ON chat_mention(token_id, created_at, seq);
-- Retention across all tokens (a bounded purge on every write, no cron).
CREATE INDEX IF NOT EXISTS idx_chat_mention_age ON chat_mention(created_at);

-- The newest position (created_at, seq) the per-token cap ever evicted, per
-- token. A cursor at or before it may have missed rows, whether or not it names
-- a row, so its next page says truncated. Retention needs no mark: it deletes
-- only rows older than the retention, which a live cursor's age rule covers.
CREATE TABLE IF NOT EXISTS chat_mention_gap (
  token_id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  seq INTEGER NOT NULL
);

-- Revocation: a token row deleted (revoke, sign out everywhere, the account
-- deleted) takes its mentions with it, and so does disconnecting an OAuth app.
CREATE TRIGGER IF NOT EXISTS chat_mention_token_gone AFTER DELETE ON api_tokens
BEGIN
  DELETE FROM chat_mention WHERE token_id = OLD.token_hash;
  DELETE FROM chat_mention_gap WHERE token_id = OLD.token_hash;
END;
CREATE TRIGGER IF NOT EXISTS chat_mention_grant_gone AFTER DELETE ON mcp_oauth_grant
BEGIN
  DELETE FROM chat_mention
  WHERE token_id IN (SELECT token_hash FROM api_tokens WHERE oauth_grant_id = OLD.id);
  DELETE FROM chat_mention_gap
  WHERE token_id IN (SELECT token_hash FROM api_tokens WHERE oauth_grant_id = OLD.id);
END;
