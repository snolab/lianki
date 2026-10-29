-- Invites and gift codes (lib/referrals). Every reward lands in
-- membership_grant, whose UNIQUE (reason, refId) makes each one idempotent:
-- the same referral or redemption can never grant twice, however often the
-- check that awards it runs.

-- One personal invite code per user, made the first time they ask for it.
CREATE TABLE IF NOT EXISTS invite_code (
  code      TEXT PRIMARY KEY NOT NULL,
  userId    TEXT NOT NULL UNIQUE REFERENCES user(id) ON DELETE CASCADE,
  createdAt TEXT NOT NULL
);

-- Who invited whom. inviteeId is the key: a user is invited at most once.
-- activatedAt is set when the invitee met the activation rule (reviewed on
-- enough distinct days soon after signing up); purchasedAt on their first pass.
CREATE TABLE IF NOT EXISTS referral (
  inviteeId   TEXT PRIMARY KEY NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  inviterId   TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  code        TEXT NOT NULL,
  createdAt   TEXT NOT NULL,
  activatedAt TEXT,
  purchasedAt TEXT
);
CREATE INDEX IF NOT EXISTS idx_referral_inviterId ON referral(inviterId);

-- Every day of trial or Pro given away, and why. days may be 0 when the
-- yearly cap left nothing to give; the row still marks the reward as settled.
CREATE TABLE IF NOT EXISTS membership_grant (
  id        TEXT PRIMARY KEY NOT NULL,
  userId    TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  kind      TEXT NOT NULL,        -- 'trial' | 'pro'
  days      INTEGER NOT NULL,
  reason    TEXT NOT NULL,        -- 'invitee' | 'referral-activated' | 'referral-purchase' | 'gift'
  refId     TEXT NOT NULL,        -- the referral's inviteeId, or the gift code + user
  createdAt TEXT NOT NULL,
  UNIQUE (reason, refId)
);
CREATE INDEX IF NOT EXISTS idx_membership_grant_user ON membership_grant(userId, createdAt);

-- Owner-made gift codes: N days of Pro, usable M times.
CREATE TABLE IF NOT EXISTS gift_code (
  code      TEXT PRIMARY KEY NOT NULL,
  days      INTEGER NOT NULL,
  maxUses   INTEGER NOT NULL,
  uses      INTEGER NOT NULL DEFAULT 0,
  note      TEXT,
  createdBy TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  expiresAt TEXT
);
