-- The browser language at an account's first sign-up (lib/signup-locale.ts):
-- one normalised tag (en, ja, zh-Hans, zh-Hant…), nothing else from the
-- Accept-Language header. Written once by the user.create hook, never
-- overwritten. Accounts made before this stay NULL: no backfill, no guessing.
-- The invite email's language falls back to it (docs/payments.md, "Invite by email").
ALTER TABLE user ADD COLUMN signupLocale TEXT;
