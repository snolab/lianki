-- Sessions that have opened a custom frontend (docs/custom-frontend.md, "Account
-- writes"; lib/live-view/custom.ts). That frontend's JS runs on lianki.com with
-- the session's cookie, and may still be running in a tab after a normal page has
-- cleared the live cookie. So the block on account writes lives here, on the
-- session, where no page load can clear it. A new sign-in is a new session.
-- `tag` is sessionTag(): a hash of the session token, never the token.
CREATE TABLE IF NOT EXISTS custom_live_session (
  tag      TEXT PRIMARY KEY NOT NULL,
  first_at INTEGER NOT NULL,
  last_at  INTEGER NOT NULL
);
