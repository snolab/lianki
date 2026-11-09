-- The send log of every outgoing mail (docs/mail-templates.md, "Send log";
-- lib/mail-log/). One row per mail, written in the one send path
-- (lib/mail-log/send.ts) before the provider is called, then updated by its
-- answer and by Resend's webhook (lib/resend-webhook.ts).
--
-- `recipient` is the address (owner decision 2026-11-09): read only at
-- /dev/mails (isDev), never logged, never exported without isDev, and deleted
-- with the account (trigger below). Rows copied from invite_email_log hold the
-- masked form only (`recipient_masked` = 1): addresses are not backfilled.
--
-- `vars` keeps only the template variables needed to re-render the mail
-- (lib/mail-log/vars.ts): never a sign-in code, a link or a token.
CREATE TABLE IF NOT EXISTS mail_log (
  id               TEXT PRIMARY KEY,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  -- a mail template id (lib/mail-templates/defs.ts), or "unknown"
  template         TEXT NOT NULL,
  -- the stored template version sent; 0 = the built-in, -1 = an editor test send
  version          INTEGER NOT NULL,
  locale           TEXT NOT NULL,
  recipient        TEXT NOT NULL,
  recipient_masked INTEGER NOT NULL DEFAULT 0,
  -- lib/referrals/recipient-hash.ts: matches invite_email_suppression
  recipient_hash   TEXT NOT NULL,
  user_id          TEXT,
  inviter_id       TEXT,
  invite_log_id    TEXT,
  -- JSON object of the non-secret variables, or NULL
  vars             TEXT,
  -- queued | sent | delivered | bounced | complained | unsubscribed | failed
  status           TEXT NOT NULL,
  -- a short reason (failed, bounce type); never an address
  reason           TEXT,
  provider_id      TEXT,
  -- the row this one re-sent (/dev/mails Resend)
  resend_of        TEXT
);
CREATE INDEX IF NOT EXISTS idx_mail_log_created ON mail_log(created_at);
CREATE INDEX IF NOT EXISTS idx_mail_log_template ON mail_log(template, created_at);
CREATE INDEX IF NOT EXISTS idx_mail_log_status ON mail_log(status, created_at);
CREATE INDEX IF NOT EXISTS idx_mail_log_provider ON mail_log(provider_id);
CREATE INDEX IF NOT EXISTS idx_mail_log_hash ON mail_log(recipient_hash);
CREATE INDEX IF NOT EXISTS idx_mail_log_user ON mail_log(user_id);
CREATE INDEX IF NOT EXISTS idx_mail_log_inviter ON mail_log(inviter_id);
CREATE INDEX IF NOT EXISTS idx_mail_log_invite ON mail_log(invite_log_id);

-- Deleted with the account: mail to it, about it, or that it sent as an invite.
CREATE TRIGGER IF NOT EXISTS mail_log_user_deleted AFTER DELETE ON user
BEGIN
  DELETE FROM mail_log
   WHERE user_id = OLD.id OR inviter_id = OLD.id OR lower(recipient) = lower(OLD.email);
END;

-- The invites sent before this log existed, masked (no address backfill).
INSERT OR IGNORE INTO mail_log
  (id, created_at, updated_at, template, version, locale, recipient, recipient_masked,
   recipient_hash, inviter_id, invite_log_id, status, provider_id)
SELECT id, createdAt, createdAt, 'invite', 0, locale, recipientMasked, 1,
       recipientHash, inviterId, id,
       CASE
         WHEN reportedAt IS NOT NULL THEN 'complained'
         WHEN status = 'pending' THEN 'queued'
         ELSE status
       END,
       providerId
  FROM invite_email_log
 WHERE status IN ('pending', 'sent', 'failed');
