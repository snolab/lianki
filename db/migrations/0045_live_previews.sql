-- Custom frontends (docs/custom-frontend.md, lib/live-view/custom.ts):
-- a signed-in user runs their own frontend on their own dev server, behind
-- a Cloudflare tunnel, and views it at lianki.com/?live=<id>. Only they
-- see it; /api and /auth stay on production.
--
-- 1. Who may register one: the owner adds and removes users at
--    /dev/live-frontends. Every change is in security_audit.
CREATE TABLE IF NOT EXISTS live_frontend_allow (
  user_id   TEXT PRIMARY KEY NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  added_by  TEXT NOT NULL,
  added_at  INTEGER NOT NULL  -- ms
);

-- 2. One row per registered preview. `id` is 128 random bits, base64url
--    (22 characters). `target` is the tunnel's bare https origin. Shown
--    only to `user_id`, until `expires_at` (at most 8 h after creation) or
--    `revoked_at`. The per-user cap is enforced by the one conditional
--    INSERT that creates a row (lib/live-view/custom.ts, createPreview).
CREATE TABLE IF NOT EXISTS live_preview (
  id          TEXT PRIMARY KEY NOT NULL,
  user_id     TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  target      TEXT NOT NULL,
  created_at  INTEGER NOT NULL,  -- ms
  expires_at  INTEGER NOT NULL,  -- ms
  revoked_at  INTEGER            -- ms, NULL while not revoked
);
CREATE INDEX IF NOT EXISTS idx_live_preview_user ON live_preview(user_id, expires_at);
