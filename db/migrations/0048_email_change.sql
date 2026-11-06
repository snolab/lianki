-- A verified change of sign-in address that is waiting for its confirmation link
-- (lib/profile/email-change.ts; docs/secrets-and-auth.md, "Changing the email").
-- One per user: a new request replaces the old one. Only the token's hash is
-- kept. The row goes when the change is applied.
CREATE TABLE IF NOT EXISTS email_change_request (
  userId    TEXT PRIMARY KEY NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  tokenHash TEXT NOT NULL,
  oldEmail  TEXT NOT NULL,
  newEmail  TEXT NOT NULL,
  expiresMs INTEGER NOT NULL
);
