-- better-auth passkey plugin (@better-auth/passkey 1.5.4): one row per WebAuthn
-- credential a user has registered. Columns follow the plugin's schema exactly
-- (node_modules/@better-auth/passkey/dist/index.mjs, "src/schema.ts"), with the
-- same SQLite conventions as the other better-auth tables in 0001_init.sql:
-- dates are ISO 8601 TEXT, booleans INTEGER 0/1.
--
-- publicKey is the base64 COSE key; transports a comma-separated list; aaguid
-- names the authenticator model. createdAt is optional in the plugin schema.
CREATE TABLE IF NOT EXISTS passkey (
  id           TEXT PRIMARY KEY NOT NULL,
  name         TEXT,
  publicKey    TEXT NOT NULL,
  userId       TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  credentialID TEXT NOT NULL,
  counter      INTEGER NOT NULL,
  deviceType   TEXT NOT NULL,
  backedUp     INTEGER NOT NULL,
  transports   TEXT,
  createdAt    TEXT,
  aaguid       TEXT
);
CREATE INDEX IF NOT EXISTS idx_passkey_userId ON passkey(userId);
CREATE INDEX IF NOT EXISTS idx_passkey_credentialID ON passkey(credentialID);
