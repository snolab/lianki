-- The owner role in the database (lib/site-role.ts, docs/secrets-and-auth.md,
-- "The owner role"): who may reach /dev, the dev bridge and the other owner
-- surfaces. Granted and revoked at /dev/owners or, break-glass, with
-- scripts/dev/owner-role.ts; no deploy. This table is the ONLY owner list:
-- the deploy-time OWNER_EMAILS setting is gone.
--
-- `email` is the address exactly as signed in, lowercased; never its canonical
-- form (0043): someone+admin@gmail.com and someone@gmail.com are two people
-- here. A revoked row stays, with revoked_at set; a new grant reactivates it.
-- Times are epoch milliseconds. Every change writes a security_audit row.
CREATE TABLE IF NOT EXISTS site_role (
  email      TEXT PRIMARY KEY CHECK (email = lower(trim(email)) AND instr(email, '@') > 1),
  role       TEXT NOT NULL DEFAULT 'owner' CHECK (role = 'owner'),
  granted_by TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  revoked_at INTEGER
);

-- Continuity: the two owners OWNER_EMAILS named when it was removed (owner's
-- decisions, 2026-11-05). deploy-worker.yml applies migrations before it deploys
-- the code that reads this, so there is no moment without an owner. The main
-- account's grant is a millisecond older: it stays first, as it was in that list,
-- so it is "the owner" where only one account can be meant (oldest grant first).
INSERT OR IGNORE INTO site_role (email, role, granted_by, granted_at) VALUES
  ('snomiao@gmail.com', 'owner', 'migration-0047', 1793872800000),
  ('snomiao+admin@gmail.com', 'owner', 'migration-0047', 1793872800001);

INSERT INTO security_audit (at_ms, kind, actor, subject, detail) VALUES
  (1793872800000, 'site-role.grant', 'migration-0047', NULL, 'snomiao@gmail.com'),
  (1793872800001, 'site-role.grant', 'migration-0047', NULL, 'snomiao+admin@gmail.com');
