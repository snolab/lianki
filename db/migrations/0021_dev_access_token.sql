-- Dev access tokens (docs/dev-whole-page.md, "Off the tailnet: preview.lianki.com"):
-- what lets the owner's devices through the gate in front of his whole-page dev
-- server on the public tunnel. Minted on /dev/tokens by the owner's session
-- only; the token itself is shown once and never stored: `token_hash` is its
-- SHA-256 (the token has 256 random bits, so a plain hash is enough).
--
-- kind 'token':   named, lives until `expires_ms` (at most 90 days), any number of uses.
-- kind 'handoff': the profile menu's jump to the dev server — single use
--                 (`consumed_ms`), 60 s to be used.
-- `revoked_ms` ends the token and every dev-server session made with it.
-- Deleting the user deletes the rows.
CREATE TABLE IF NOT EXISTS dev_access_token (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  email        TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('token', 'handoff')),
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  created_ms   INTEGER NOT NULL,
  expires_ms   INTEGER NOT NULL,
  consumed_ms  INTEGER,
  revoked_ms   INTEGER,
  last_used_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_dev_access_token_user ON dev_access_token(user_id, kind, created_ms);
