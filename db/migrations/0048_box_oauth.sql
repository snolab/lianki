-- my-<hash> boxes sign in through lianki.com (docs/box-oauth.md).
--
-- 1. The tables of better-auth's OAuth provider plugin
--    (@better-auth/oauth-provider 1.7.10), columns exactly as its schema, with
--    the conventions of the other better-auth tables (0001_init.sql, 0011):
--    dates ISO 8601 TEXT, booleans INTEGER 0/1, lists and json TEXT.
--    Tokens are stored hashed by the plugin; the code is one-time.
CREATE TABLE IF NOT EXISTS oauthClient (
  id TEXT PRIMARY KEY NOT NULL,
  clientId TEXT NOT NULL UNIQUE,
  clientSecret TEXT,
  clientDiscoveryId TEXT,
  disabled INTEGER,
  skipConsent INTEGER,
  enableEndSession INTEGER,
  subjectType TEXT,
  scopes TEXT,
  clientCredentialsScopes TEXT,
  userId TEXT REFERENCES user(id),
  createdAt TEXT,
  updatedAt TEXT,
  name TEXT,
  uri TEXT,
  icon TEXT,
  contacts TEXT,
  tos TEXT,
  policy TEXT,
  softwareId TEXT,
  softwareVersion TEXT,
  softwareStatement TEXT,
  redirectUris TEXT NOT NULL,
  postLogoutRedirectUris TEXT,
  backchannelLogoutUri TEXT,
  backchannelLogoutSessionRequired INTEGER,
  tokenEndpointAuthMethod TEXT,
  applicationType TEXT,
  jwks TEXT,
  jwksUri TEXT,
  grantTypes TEXT,
  responseTypes TEXT,
  requirePKCE INTEGER,
  dpopBoundAccessTokens INTEGER,
  referenceId TEXT,
  metadata TEXT
);

CREATE TABLE IF NOT EXISTS oauthResource (
  id TEXT PRIMARY KEY NOT NULL,
  identifier TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  accessTokenTtl INTEGER,
  refreshTokenTtl INTEGER,
  signingAlgorithm TEXT,
  signingKeyId TEXT,
  allowedScopes TEXT,
  customClaims TEXT,
  dpopBoundAccessTokensRequired INTEGER,
  disabled INTEGER,
  createdAt TEXT,
  updatedAt TEXT,
  policyVersion INTEGER,
  metadata TEXT
);

CREATE TABLE IF NOT EXISTS oauthClientResource (
  id TEXT PRIMARY KEY NOT NULL,
  clientId TEXT NOT NULL REFERENCES oauthClient(clientId) ON DELETE CASCADE,
  resourceId TEXT NOT NULL REFERENCES oauthResource(identifier) ON DELETE CASCADE,
  metadata TEXT,
  createdAt TEXT
);

CREATE TABLE IF NOT EXISTS oauthRefreshToken (
  id TEXT PRIMARY KEY NOT NULL,
  token TEXT NOT NULL UNIQUE,
  clientId TEXT NOT NULL REFERENCES oauthClient(clientId),
  sessionId TEXT REFERENCES session(id) ON DELETE SET NULL,
  userId TEXT NOT NULL REFERENCES user(id),
  referenceId TEXT,
  authorizationCodeId TEXT,
  resources TEXT,
  requestedUserInfoClaims TEXT,
  expiresAt TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  revoked TEXT,
  rotatedAt TEXT,
  rotationReplayResponse TEXT,
  rotationReplayExpiresAt TEXT,
  authTime TEXT,
  confirmation TEXT,
  scopes TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_oauthRefreshToken_client ON oauthRefreshToken(clientId);

CREATE TABLE IF NOT EXISTS oauthAccessToken (
  id TEXT PRIMARY KEY NOT NULL,
  token TEXT NOT NULL UNIQUE,
  clientId TEXT NOT NULL REFERENCES oauthClient(clientId),
  sessionId TEXT REFERENCES session(id) ON DELETE SET NULL,
  userId TEXT REFERENCES user(id),
  referenceId TEXT,
  authorizationCodeId TEXT,
  resources TEXT,
  requestedUserInfoClaims TEXT,
  refreshId TEXT REFERENCES oauthRefreshToken(id),
  expiresAt TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  revoked TEXT,
  confirmation TEXT,
  scopes TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_oauthAccessToken_client ON oauthAccessToken(clientId);

CREATE TABLE IF NOT EXISTS oauthConsent (
  id TEXT PRIMARY KEY NOT NULL,
  clientId TEXT NOT NULL REFERENCES oauthClient(clientId),
  userId TEXT REFERENCES user(id),
  referenceId TEXT,
  resources TEXT,
  requestedUserInfoClaims TEXT,
  scopes TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS oauthClientAssertion (
  id TEXT PRIMARY KEY NOT NULL,
  expiresAt TEXT NOT NULL
);

-- 2. Which box may sign in as which account: what the plugin has no notion of.
--    While a binding is live, an origin has one account and an account has one
--    box. A revoked row stays as history. The origin is unguessable, so it lives
--    here and in the box's own env file, never in the repo.
CREATE TABLE IF NOT EXISTS box_binding (
  client_id   TEXT PRIMARY KEY NOT NULL,
  origin      TEXT NOT NULL,
  user_id     TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  scopes      TEXT NOT NULL,
  created_by  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,  -- ms
  revoked_at  INTEGER            -- ms, NULL while live
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_box_binding_origin ON box_binding(origin) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_box_binding_user ON box_binding(user_id) WHERE revoked_at IS NULL;
