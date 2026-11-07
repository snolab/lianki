-- Fine-grained API tokens (docs/secrets-and-auth.md, "API tokens"; lib/api-tokens.ts),
-- modelled on GitHub's fine-grained personal access tokens. Every token is
-- bound to the account that made it (user_id, fixed at creation and checked on
-- every use, with the email), carries an explicit list of permissions, and
-- expires. Rows from before this migration keep working as they did: scopes
-- NULL reads as ["study"] (cards and settings, never chat) and expires_at NULL
-- as "no expiry"; new tokens always get both.
ALTER TABLE api_tokens ADD COLUMN user_id TEXT;
ALTER TABLE api_tokens ADD COLUMN scopes TEXT;       -- JSON array of scope ids (lib/api-tokens.ts SCOPES)
ALTER TABLE api_tokens ADD COLUMN expires_at TEXT;   -- ISO time; NULL only on rows from before
ALTER TABLE api_tokens ADD COLUMN last_used_at TEXT; -- ISO time, written at most once a minute

-- Bind every old token to its account now, by the address it was made for.
UPDATE api_tokens SET user_id = (SELECT u.id FROM user u WHERE u.email = api_tokens.email)
  WHERE user_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens(user_id);

-- `lianki auth login`: the permissions and expiry the user picked on /cli-login,
-- carried from Approve to the exchange that mints the token.
ALTER TABLE cli_login ADD COLUMN scopes TEXT;
ALTER TABLE cli_login ADD COLUMN token_expires_at TEXT;
