-- The canonical email (lib/canonical-email.ts): used ONLY to see that two
-- accounts are one person — the 90-day trial, invite and gift-code rewards,
-- per-person rate limits. Sign-in and identity keep `email` as given; no
-- account is merged or changed by this.
--
-- New accounts and email changes get it from the better-auth user hooks
-- (auth-impl.ts), and the checks fill it lazily for any account missed.
-- The backfill below mirrors canonicalEmail(); unit/canonical-email.test.ts
-- runs it against the TypeScript function so the two cannot drift.
ALTER TABLE user ADD COLUMN email_canonical TEXT;
CREATE INDEX IF NOT EXISTS idx_user_email_canonical ON user(email_canonical);

UPDATE user SET email_canonical = (
  SELECT CASE WHEN d IN ('gmail.com', 'googlemail.com')
              THEN replace(lp, '.', '') || '@gmail.com'
              ELSE lp || '@' || d END
    FROM (SELECT CASE WHEN d IN ('gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com',
                                 'live.com', 'msn.com', 'icloud.com', 'me.com', 'mac.com',
                                 'proton.me', 'protonmail.com', 'pm.me', 'fastmail.com')
                           AND instr(lo, '+') > 1
                      THEN substr(lo, 1, instr(lo, '+') - 1) ELSE lo END AS lp, d
            FROM (SELECT substr(l, 1, instr(l, '@') - 1) AS lo, substr(l, instr(l, '@') + 1) AS d
                    FROM (SELECT lower(trim(user.email)) AS l)))
)
WHERE instr(lower(trim(email)), '@') > 1
  AND instr(substr(lower(trim(email)), instr(lower(trim(email)), '@') + 1), '@') = 0;

UPDATE user SET email_canonical = lower(trim(email)) WHERE email_canonical IS NULL;
