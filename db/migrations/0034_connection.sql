-- Connections to outside services (docs/connections.md), separate from
-- sign-in: better-auth's `account` rows are never read or written for them.
--
-- One row per user per provider (first: 'google', Drive `drive.file`).
-- refresh_enc is the refresh token sealed with AES-256-GCM (lib/connections/
-- crypto.ts; key derived from AUTH_SECRET, the row's user and provider bound
-- as AAD). No access token is ever stored. Disconnect revokes at the provider
-- and deletes the row; deleting the user deletes it too.
CREATE TABLE IF NOT EXISTS connection (
  user_id       TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  provider      TEXT NOT NULL,
  account_sub   TEXT NOT NULL,           -- the provider's account id
  account_email TEXT,                    -- shown on /connections
  scopes        TEXT NOT NULL,           -- space-separated, as granted
  refresh_enc   TEXT NOT NULL,
  status        TEXT NOT NULL,           -- 'ok' | 'reconnect'
  created_ms    INTEGER NOT NULL,
  updated_ms    INTEGER NOT NULL,
  PRIMARY KEY (user_id, provider)
);
