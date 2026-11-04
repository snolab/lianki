-- The chat inbox (docs/dev-debug-widget.md, "Attachments and the inbox"):
-- files pasted, dropped or picked in the chat, stored in R2 lianki-blobs
-- under inbox/ (lib/inbox/keys.ts). One row per file; the bytes are in R2.
-- Nothing is deleted automatically: a row goes only when the owner deletes it.
CREATE TABLE IF NOT EXISTS inbox_item (
  id            TEXT PRIMARY KEY,          -- 20 hex (lib/inbox/keys.ts newInboxId)
  owner_id      TEXT NOT NULL,             -- the uploader's user id
  name          TEXT NOT NULL,             -- display only (cleanFileName)
  type          TEXT NOT NULL,             -- sniffed (lib/inbox/sniff.ts), never the claim
  size          INTEGER NOT NULL,
  sha256        TEXT NOT NULL,
  r2_key        TEXT NOT NULL,
  created_ms    INTEGER NOT NULL,
  processed_ms  INTEGER,                   -- set by an agent (`eval.ts inbox done`)
  line_id       TEXT,                      -- the chat line it was sent with
  ticket_hash   TEXT,                      -- sha256 of a single-use download ticket
  ticket_exp    INTEGER
);
CREATE INDEX IF NOT EXISTS inbox_item_owner ON inbox_item (owner_id, created_ms);

-- Per-user usage, updated in the same batch as each upload and delete, so
-- the user bears the cost by usage (lib/inbox/charge.ts). Storage accrues as
-- bytes_stored x time since settled_ms; it is settled at each upload and
-- delete and when the user opens the inbox view (nothing polls).
CREATE TABLE IF NOT EXISTS inbox_usage (
  user_id        TEXT PRIMARY KEY,
  bytes_stored   INTEGER NOT NULL DEFAULT 0,
  bytes_uploaded INTEGER NOT NULL DEFAULT 0,  -- all time, deletes do not lower it
  items          INTEGER NOT NULL DEFAULT 0,
  settled_ms     INTEGER NOT NULL,             -- storage cost settled up to here
  updated_ms     INTEGER NOT NULL
);
