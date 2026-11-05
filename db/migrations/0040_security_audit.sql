-- The security audit log (lib/security/audit-log.ts, docs/security-measures.md,
-- "Audit log"): one row per write to what lets dev code or a dev server in —
-- the live-view pointer (on, off, the owner's stop) and dev access tokens
-- (mint, revoke, revoke all, the profile menu's handoff). Ids, kinds and short
-- labels only, never a token, a pointer or a secret. Append-only by use.
CREATE TABLE IF NOT EXISTS security_audit (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at_ms   INTEGER NOT NULL,
  kind    TEXT NOT NULL,
  actor   TEXT NOT NULL,
  subject TEXT,
  detail  TEXT
);
CREATE INDEX IF NOT EXISTS idx_security_audit_at ON security_audit(at_ms);
