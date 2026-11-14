-- Mic recordings in the account (docs/recordings.md; lib/recordings.ts; owner
-- tap card 2026-11-14 ~03:35 JST, "批准：开始做"). While the account's mic is
-- on in Lianki, every finished utterance (active or passive, sent to the chat
-- or not) is kept: its audio and the transcript the mic already had, so he can
-- review a day later and download it to his Mac. Other people's voices in the
-- room are kept too (he accepted that); only this account can read them.
--
-- One row per utterance. The AUDIO is not here: it lives in R2
-- (`lianki-blobs`, key `recordings/<user_id>/<day>/<id>`) as AES-256-GCM
-- sealed bytes. The transcript is sealed here. Key: HKDF-SHA256 from
-- AUTH_SECRET, salt "lianki/recordings", info "lianki/recordings/at-rest/v1";
-- AAD: user, kind (audio | text) and id, so neither half opens in another
-- account, as the other half, or under another clip's id.
--
-- Deleted by him (a clip or a whole day) or by the daily sweep once older
-- than the config key `recordings.retentionDays` (worker.ts `scheduled`).
CREATE TABLE IF NOT EXISTS recording (
  user_id       TEXT NOT NULL,
  id            TEXT NOT NULL,     -- the client's random id: a retried upload is the same clip
  day           TEXT NOT NULL,     -- YYYY-MM-DD on the recording device's clock
  at            INTEGER NOT NULL,  -- end of the utterance, ms since the epoch
  duration_ms   INTEGER NOT NULL,
  bytes         INTEGER NOT NULL,  -- the WAV's length before sealing
  mode          TEXT NOT NULL,     -- active | passive
  source        TEXT NOT NULL,     -- the transcript's origin: local (the Mac) | cloud (the chat's fallback) | none
  device        TEXT NOT NULL,     -- the device label ("iphone")
  speaker       TEXT,              -- the Mac's speaker check: me | other | unknown, or NULL
  text_sealed   TEXT NOT NULL,     -- the transcript, sealed (v1.<iv>.<ct>); may seal ""
  created_at    INTEGER NOT NULL,  -- when the server stored it, ms
  PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS recording_user_day ON recording (user_id, day, at);
CREATE INDEX IF NOT EXISTS recording_at ON recording (at);
