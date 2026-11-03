-- `lianki auth login` (lib/cli-login.ts, docs/secrets-and-auth.md "CLI login").
--
-- One row per browser sign-in of the CLI. It starts `pending` when the signed-in
-- user opens /cli-login (request_hash = SHA-256 of the random id the page hands
-- its Approve button, so the id is also the CSRF token), becomes `code` when
-- they approve (code_hash = SHA-256 of the one-time code sent to the CLI's
-- 127.0.0.1 listener, good for 60 s), and `used` when the CLI exchanges that
-- code with its PKCE verifier for an API token. No raw id, code or token is
-- stored. Rows past expires_ms are deleted on the next start.
CREATE TABLE IF NOT EXISTS cli_login (
  request_hash TEXT PRIMARY KEY NOT NULL,
  user_id      TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  email        TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  state        TEXT NOT NULL,
  challenge    TEXT NOT NULL,
  name         TEXT NOT NULL,
  stage        TEXT NOT NULL,
  code_hash    TEXT UNIQUE,
  expires_ms   INTEGER NOT NULL,
  created_ms   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cli_login_expires ON cli_login(expires_ms);
