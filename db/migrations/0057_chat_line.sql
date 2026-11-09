-- The account's chat history (docs/chat-history.md; lib/chat-log.ts). One row a
-- line of the user's own thread, written by lianki-push's DebugHub as the line
-- is kept: the owner's thread to each active owner's account, a Learning
-- Partner thread to that user's. Text only: no audio, no clip ids, no page
-- context or screen text, no attachments. A row goes only when the user
-- deletes it (a line, or a day) at /chat/history.
CREATE TABLE IF NOT EXISTS chat_line (
  user_id  TEXT NOT NULL,             -- the account it belongs to
  id       TEXT NOT NULL,             -- the hub's line id
  thread   TEXT NOT NULL,             -- "owner", or the user's own id
  sender   TEXT NOT NULL,             -- owner | friend | agent (the line's `from`)
  lane     TEXT,                      -- main | codex | agy on agent lines (voices.ts LANES)
  text     TEXT NOT NULL,
  at_ms    INTEGER NOT NULL,
  ask      INTEGER NOT NULL DEFAULT 0, -- 1: an ask card
  answer   TEXT,                      -- the ask's chosen options, once tapped
  PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS chat_line_user_at ON chat_line (user_id, at_ms DESC, id DESC);

-- The one-time backfill from the hub's stored history, per account: once it
-- ran, it never runs again (so a line deleted since is not brought back).
CREATE TABLE IF NOT EXISTS chat_line_backfill (
  user_id  TEXT PRIMARY KEY,
  thread   TEXT NOT NULL,
  lines    INTEGER NOT NULL,
  at_ms    INTEGER NOT NULL
);
