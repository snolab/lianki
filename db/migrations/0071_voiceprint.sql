-- The voiceprint in the account (docs/local-stt.md, "Voiceprint in your
-- account"; lib/voiceprint-cloud.ts). Voice FEATURES only, as the owner's Mac
-- computed them (CAM++ embeddings and their mean, sentence lengths, self
-- scores): numbers, never audio, never text. One row per account, device and
-- model. `payload` is AES-256-GCM sealed (key: HKDF from AUTH_SECRET, info
-- "lianki/voiceprint/features-at-rest/v1"; AAD: user, device, model), so a
-- D1 export alone does not read. Written and deleted only with the owner's
-- passkey (a voiceprint ticket); a row goes when he deletes it.
CREATE TABLE IF NOT EXISTS voiceprint (
  user_id    TEXT NOT NULL,
  device     TEXT NOT NULL,     -- iphone, android, mac… (the Mac's store slug)
  model      TEXT NOT NULL,     -- campp | eres2netv2
  dim        INTEGER NOT NULL,  -- embedding width (192 for CAM++)
  n          INTEGER NOT NULL,  -- sentences in the print
  payload    TEXT NOT NULL,     -- sealed JSON {centroid, embeddings, speechS, self, created, updated}
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, device, model)
);
