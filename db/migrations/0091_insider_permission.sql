-- A third account permission, `insider` (lib/permissions.ts, isInsider;
-- docs/secrets-and-auth.md, "Permissions"; docs/feature-flags.md, "Insiders
-- first"): early access to features behind a flag with audience "insider".
-- Granted and revoked at /dev/permissions like `admin` and `dev`.
--
-- SQLite cannot change a CHECK constraint in place, so the table is rebuilt
-- with the same columns, key and rows; only the allowed permission names grow.
-- account_permission has no indexes, triggers or foreign keys to carry over.
-- Deliberately no seed: grants are data, added after the owner approves them.
CREATE TABLE account_permission_new (
  email      TEXT NOT NULL CHECK (email = lower(trim(email)) AND instr(email, '@') > 1),
  permission TEXT NOT NULL CHECK (permission IN ('admin', 'dev', 'insider')),
  granted_by TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  revoked_at INTEGER,
  PRIMARY KEY (email, permission)
);
INSERT INTO account_permission_new (email, permission, granted_by, granted_at, revoked_at)
  SELECT email, permission, granted_by, granted_at, revoked_at FROM account_permission;
DROP TABLE account_permission;
ALTER TABLE account_permission_new RENAME TO account_permission;
