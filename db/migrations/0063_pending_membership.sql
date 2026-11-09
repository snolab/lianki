-- Pre-grants (lib/referrals/pregrant.ts, docs/payments.md, "Pre-grants"):
-- Pro days an admin gives an address BEFORE it has an account, from the panel
-- on /dev/users. The first sign-in of an account whose VERIFIED email has the
-- same canonical form (lib/canonical-email.ts) claims it: a membership_grant
-- row (reason 'pregrant', refId 'pregrant:<id>', so once only) extends
-- proEndsAt by `days`, and the row is stamped claimed.
--
-- Not in EMAIL_KEYED_TABLES (lib/profile/email-change.ts): `email` here is
-- the address the admin typed, not an account's key. No account owns the row
-- until it is claimed, so an email change has nothing to move; once claimed,
-- the grant belongs to claimed_user_id (an id, which never changes).
--
-- `email` is kept because the admin-only page must show the pending list; it
-- is the owner's own list. Matching uses email_hash = SHA-256 of
-- 'pregrant:' || canonical address. Times are ISO strings.
CREATE TABLE IF NOT EXISTS pending_membership (
  id               TEXT PRIMARY KEY NOT NULL,
  email_hash       TEXT NOT NULL,
  email            TEXT NOT NULL,
  days             INTEGER NOT NULL,
  -- The grant itself lapses at this time if unclaimed (NULL: never).
  grant_expires_at TEXT,
  granted_by       TEXT NOT NULL,   -- the admin's user id
  note             TEXT,
  created_at       TEXT NOT NULL,
  claimed_at       TEXT,
  claimed_user_id  TEXT,
  revoked_at       TEXT
);
-- At most one open (unclaimed, unrevoked) grant per person.
CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_membership_open
  ON pending_membership(email_hash) WHERE claimed_at IS NULL AND revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_pending_membership_created ON pending_membership(created_at);
