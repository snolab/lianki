-- Permissions per account (lib/permissions.ts, lib/account-permission.ts,
-- docs/secrets-and-auth.md, "Permissions"): `admin` and `dev`, each its own
-- grant, the one source for every owner/dev/admin gate. Granted and revoked at
-- /dev/permissions or, break-glass, with scripts/dev/permission.ts; no deploy.
-- Never an email list in code or env.
--
-- `email` is the address exactly as signed in, lowercased; never its canonical
-- form: someone+admin@example.com and someone@example.com are two people here. A
-- revoked row stays, with revoked_at set; a new grant reactivates it. Times are
-- epoch milliseconds. Every change writes a security_audit row.
--
-- Deliberately no seed: grants are data, added after the owner approves them.
-- Until then the old site_role owners still pass every check (migration step a).
CREATE TABLE IF NOT EXISTS account_permission (
  email      TEXT NOT NULL CHECK (email = lower(trim(email)) AND instr(email, '@') > 1),
  permission TEXT NOT NULL CHECK (permission IN ('admin', 'dev')),
  granted_by TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  revoked_at INTEGER,
  PRIMARY KEY (email, permission)
);
