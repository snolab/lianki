-- The voice-clone reference in the account (docs/voice-clone.md;
-- lib/voice-clone-ref.ts; owner tap card 2026-11-14 02:50 JST). One short WAV
-- of the account holder's own voice (24 kHz mono 16-bit PCM, at most 30 s) and
-- its transcript, so his own voice can be synthesized for his account only.
--
-- One row per account. The AUDIO is not here: it is too large for a D1 row
-- once sealed, so it lives in R2 (`lianki-blobs`, key
-- `voice-clone-ref/<user_id>/<rev>`) as AES-256-GCM sealed bytes. This row
-- holds its metadata in clear and the transcript sealed. Key: HKDF-SHA256 from
-- AUTH_SECRET, salt "lianki/voice-clone-ref", info
-- "lianki/voice-clone-ref/at-rest/v1"; AAD: user, kind (audio | text) and rev,
-- so neither half opens in another account, as the other half, or paired with
-- another revision. Written, replaced and deleted only with a fresh passkey
-- ticket (Face ID / Touch ID) for this account; deleted when he deletes it.
CREATE TABLE IF NOT EXISTS voice_clone_ref (
  user_id      TEXT PRIMARY KEY,
  rev          TEXT NOT NULL,     -- random; names the R2 object and binds both seals
  text_sealed  TEXT NOT NULL,     -- the transcript, sealed (v1.<iv>.<ct>)
  duration_ms  INTEGER NOT NULL,
  sample_rate  INTEGER NOT NULL,  -- 24000
  bytes        INTEGER NOT NULL,  -- the WAV's length before sealing
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
