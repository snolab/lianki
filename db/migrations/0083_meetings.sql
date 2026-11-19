-- Meetings: screen + sound recorded into the account (docs/meetings.md; owner
-- approved building it 2026-11-19 ~15:45 JST). Flag `meetings.record`
-- (default off, audience owner) plus the `dev` grant; lib/meetings/*.
--
-- The MEDIA is not here: it lives in R2 (`lianki-blobs`, key
-- `meetings/<user_id>/<meeting id>/<track>/<seq>`, seq zero-padded to 6) as
-- AES-256-GCM sealed bytes ("LKM1" + IV + ciphertext + tag). Key: HKDF-SHA256
-- from AUTH_SECRET, salt "lianki/meetings", info "lianki/meetings/at-rest/v1";
-- AAD binds user, meeting, track and seq. Titles and transcript lines are
-- sealed here with the same key (AAD: user, meeting, kind).

-- One row per meeting.
CREATE TABLE IF NOT EXISTS meeting (
  user_id           TEXT NOT NULL,
  id                TEXT NOT NULL,     -- 16 random bytes, base64url (22 chars); never a count
  title_sealed      TEXT NOT NULL,     -- v1.<iv>.<ct>
  status            TEXT NOT NULL,     -- recording | ended | interrupted | deleting
  started_at        INTEGER NOT NULL,  -- ms since the epoch
  ended_at          INTEGER,
  last_chunk_at     INTEGER,           -- when the server stored the newest piece (the stale sweep)
  duration_ms       INTEGER NOT NULL DEFAULT 0,
  bytes             INTEGER NOT NULL DEFAULT 0, -- every piece of every track, before sealing (the quota)
  mime_av           TEXT NOT NULL,
  mime_audio        TEXT NOT NULL,
  width             INTEGER,
  height            INTEGER,
  has_mic           INTEGER NOT NULL DEFAULT 0,
  has_room_audio    INTEGER NOT NULL DEFAULT 0,
  device            TEXT NOT NULL DEFAULT '',
  transcript        TEXT NOT NULL DEFAULT 'none', -- none | local | cloud (the user's choice)
  transcript_status TEXT NOT NULL DEFAULT 'none', -- none | waiting | running | done | failed
  material_id       TEXT,              -- the /reader copy, if one was opened
  PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS meeting_user_started ON meeting (user_id, started_at DESC, id);
CREATE INDEX IF NOT EXISTS meeting_status ON meeting (status, last_chunk_at);

-- One row per stored piece. Tracks: av (screen video + mixed sound, one
-- continuous file cut every meetings.chunkSec), me (mic only) and others (the
-- shared tab's / system's sound only); me and others pieces are each a
-- complete file (a new recorder per piece).
CREATE TABLE IF NOT EXISTS meeting_chunk (
  user_id     TEXT NOT NULL,
  meeting_id  TEXT NOT NULL,
  track       TEXT NOT NULL,     -- av | me | others
  seq         INTEGER NOT NULL,  -- 0, 1, 2… per track
  start_ms    INTEGER NOT NULL,  -- from the meeting's start, on the recorder's one clock
  dur_ms      INTEGER NOT NULL,
  bytes       INTEGER NOT NULL,  -- before sealing
  sha256      TEXT NOT NULL,     -- hex, of the plain bytes
  frag_off    INTEGER,           -- av: byte offset of the first fragment start (WebM Cluster / MP4 moof) in this piece
  frag_ms     INTEGER,           -- av: that fragment's media time, ms from the meeting's start
  at          INTEGER NOT NULL,  -- when the server stored it
  PRIMARY KEY (user_id, meeting_id, track, seq)
);

-- Transcript lines (written by the voice side, M3/M4; lib/meetings/lines.ts).
-- Upserted on (meeting_id, track, start_ms); every statement also carries
-- user_id, so no line is read or written across accounts.
CREATE TABLE IF NOT EXISTS meeting_line (
  meeting_id  TEXT NOT NULL,
  track       TEXT NOT NULL,     -- me | others
  start_ms    INTEGER NOT NULL,  -- from the meeting's start
  user_id     TEXT NOT NULL,
  end_ms      INTEGER NOT NULL,
  speaker     TEXT,              -- a label ("me", "others", a voice id), or NULL
  lang        TEXT,
  text_sealed TEXT NOT NULL,     -- the line's text, sealed
  source      TEXT NOT NULL,     -- live | final
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (meeting_id, track, start_ms)
);
CREATE INDEX IF NOT EXISTS meeting_line_user ON meeting_line (user_id, meeting_id, start_ms);

-- The spans a final transcript PUT has finalized (lib/meetings/store.ts
-- `putLines`): written in the same batch, even when the span holds no line
-- (silence). A live line overlapping one is never stored, and GET hides any
-- that does, so a late live line cannot reappear over finalized text.
CREATE TABLE IF NOT EXISTS meeting_final_span (
  meeting_id  TEXT NOT NULL,
  track       TEXT NOT NULL,     -- me | others
  start_ms    INTEGER NOT NULL,
  end_ms      INTEGER NOT NULL,
  user_id     TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (meeting_id, track, start_ms, end_ms)
);
CREATE INDEX IF NOT EXISTS meeting_final_span_user ON meeting_final_span (user_id, meeting_id, track);
