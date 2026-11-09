-- /vibe: a conversation transcribed into a private /read material
-- (docs/vibe.md). The text itself is an ordinary read_materials row; this table
-- is what makes it a transcript: who started it, that they went through the
-- consent screen, whether writes are open, and how far the writer has got.
--
-- material_id stays NULL until the first line, so a cancelled or silent start
-- leaves nothing in /read. Deleting the material (the /read row menu, the
-- retention sweep) or the user takes this row with it.
CREATE TABLE IF NOT EXISTS vibe_doc (
  id           TEXT PRIMARY KEY NOT NULL,
  user_id      TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  material_id  TEXT REFERENCES read_materials(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('running', 'paused', 'stopped')),
  next_seq     INTEGER NOT NULL DEFAULT 0,  -- lines held so far: a retry cannot add one twice
  other_lang   TEXT NOT NULL,               -- the language the consent screen was shown in
  consent_ms   INTEGER NOT NULL,            -- when its start button was pressed
  started_ms   INTEGER NOT NULL,
  last_ms      INTEGER NOT NULL             -- the newest line: retention counts from here
);
CREATE INDEX IF NOT EXISTS vibe_doc_user ON vibe_doc(user_id, status);
CREATE INDEX IF NOT EXISTS vibe_doc_last ON vibe_doc(last_ms);

-- How long a user's transcripts are kept. No row: the default, 30 days
-- (lib/vibe/gate.ts). Read by the daily sweep (lib/vibe/retention.ts).
CREATE TABLE IF NOT EXISTS vibe_settings (
  user_id        TEXT PRIMARY KEY NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  retention_days INTEGER NOT NULL CHECK (retention_days BETWEEN 1 AND 3650),
  updated_ms     INTEGER NOT NULL
);
