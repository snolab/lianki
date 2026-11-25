-- OAuth sign-in for the remote MCP server (docs/mcp-oauth.md; lib/mcp-oauth/*).
-- ChatGPT, Claude.ai and similar apps register themselves (RFC 7591), the user
-- approves them on lianki.com, and each approval is one grant. A grant's access
-- token is an ordinary api_tokens row (lk_…, short-lived) tagged with the grant,
-- so every route checks it exactly as any other API token (lib/api-tokens.ts
-- checkToken). Deleting the grant ends the app's access at once: checkToken
-- joins the grant, so its tokens die with it. Behind the flag mcp.oauth (off).

-- One registered app. client_id is public; only a confidential client has a
-- secret, stored as its SHA-256. redirect_uris: JSON array, matched exactly.
CREATE TABLE IF NOT EXISTS mcp_oauth_client (
  client_id TEXT PRIMARY KEY,
  secret_hash TEXT,
  name TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,
  auth_method TEXT NOT NULL,          -- none | client_secret_post | client_secret_basic
  created_at TEXT NOT NULL
);

-- An authorization code: one use, a minute or so, bound to its client,
-- redirect URI, PKCE challenge (S256), account and the scopes approved.
CREATE TABLE IF NOT EXISTS mcp_oauth_code (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  challenge TEXT NOT NULL,
  scopes TEXT NOT NULL,               -- JSON array of scope ids
  resource TEXT,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mcp_oauth_code_expires ON mcp_oauth_code(expires_at);

-- A connected app: one per (client, account). The refresh token is stored
-- hashed and rotates on every use.
CREATE TABLE IF NOT EXISTS mcp_oauth_grant (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  scopes TEXT NOT NULL,               -- JSON array of scope ids
  refresh_hash TEXT NOT NULL,
  refresh_expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  refreshed_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_oauth_grant_client_user ON mcp_oauth_grant(client_id, user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_oauth_grant_refresh ON mcp_oauth_grant(refresh_hash);
CREATE INDEX IF NOT EXISTS idx_mcp_oauth_grant_user ON mcp_oauth_grant(user_id);

-- The access tokens of a grant. NULL on every token a user made by hand.
ALTER TABLE api_tokens ADD COLUMN oauth_grant_id TEXT;
CREATE INDEX IF NOT EXISTS idx_api_tokens_grant ON api_tokens(oauth_grant_id);
