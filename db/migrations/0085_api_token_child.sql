-- Child tokens (lib/api-token-child.ts, docs/secrets-and-auth.md "Child
-- tokens"): a lane token holding `token:mint-child` mints short-lived tokens
-- for its own subagents. A child row names its parent's hash; checkToken
-- (lib/api-tokens.ts) joins the parent on every use, so a child works only
-- while its parent exists, has not expired, still holds `token:mint-child`,
-- and the flag `tokens.child` is on. Behind that flag (off by default).
ALTER TABLE api_tokens ADD COLUMN parent_hash TEXT;
CREATE INDEX IF NOT EXISTS api_tokens_parent ON api_tokens (parent_hash);
