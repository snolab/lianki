-- Invite by email (docs/payments.md, "Invite by email"; lib/referrals/email-invite.ts).
--
-- No table here holds a recipient's address. Matching needs only
-- `recipientHash` = SHA-256 of the canonical address (lib/canonical-email.ts);
-- the inviter's own history shows `recipientMasked` (a***@example.com), and no
-- one else ever reads it. Keyed by user id, never by the inviter's email, so a
-- change of address moves nothing (not in EMAIL_KEYED_TABLES).

-- Every accepted request, sent or quietly not (status), in one row.
CREATE TABLE IF NOT EXISTS invite_email_log (
  id              TEXT PRIMARY KEY,
  inviterId       TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  recipientHash   TEXT NOT NULL,
  recipientMasked TEXT NOT NULL,
  locale          TEXT NOT NULL,
  -- pending | sent | skipped-recent | skipped-suppressed | skipped-account |
  -- skipped-blocked | failed
  status          TEXT NOT NULL,
  providerId      TEXT,
  createdAt       INTEGER NOT NULL,
  -- Set when the recipient reported this mail as abuse (the link in it).
  reportedAt      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_invite_email_log_inviter ON invite_email_log(inviterId, createdAt);
CREATE INDEX IF NOT EXISTS idx_invite_email_log_recipient ON invite_email_log(recipientHash, createdAt);

-- The last invite mail each address got, from anyone: the per-recipient window
-- is claimed here with one conditional upsert, so two inviters at once cannot
-- both send.
CREATE TABLE IF NOT EXISTS invite_email_recipient (
  recipientHash TEXT PRIMARY KEY,
  lastSentAt    INTEGER NOT NULL
);

-- Addresses that get no invite mail again: unsubscribe, abuse report, and
-- later the provider's bounce / complaint events. Checked before every send.
CREATE TABLE IF NOT EXISTS invite_email_suppression (
  recipientHash TEXT PRIMARY KEY,
  -- unsubscribe | abuse | bounce | complaint
  reason        TEXT NOT NULL,
  createdAt     INTEGER NOT NULL
);
