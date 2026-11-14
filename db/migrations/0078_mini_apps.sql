-- Mini apps (docs/mini-apps.md): one HTML file per app, stored in R2
-- (mini-apps/<owner>/<slug>/index.html + manifest.json); these rows list them,
-- hold the per-(account, app, capability) grants, and each app's small
-- key-value store. Private to the owner account; nothing here is shared.

-- One row per app. `id` is random (16 hex): the label of a per-app origin and
-- what grants and storage hang off, kept when the same slug is republished.
CREATE TABLE IF NOT EXISTS mini_app (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  icon TEXT NOT NULL,
  version TEXT NOT NULL,
  permissions TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  created_ms INTEGER NOT NULL,
  updated_ms INTEGER NOT NULL,
  UNIQUE (owner_id, slug)
);

-- The user's answer to a capability prompt: 'allow' (for this app, until
-- revoked on /my/preferences), 'deny' (until reset there), or 'once' (one
-- call, then the row is gone).
CREATE TABLE IF NOT EXISTS mini_app_grant (
  owner_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  permission TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('allow', 'deny', 'once')),
  created_ms INTEGER NOT NULL,
  PRIMARY KEY (owner_id, app_id, permission)
);

-- lianki.storage: per-app JSON values, capped per app by miniApps.storageBytes.
CREATE TABLE IF NOT EXISTS mini_app_kv (
  app_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  updated_ms INTEGER NOT NULL,
  PRIMARY KEY (app_id, key)
);
