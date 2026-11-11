-- Lianki's speech servers for other accounts (docs/local-stt.md, "Lianki's
-- speech servers for everyone"; flag stt.worker, default off).
--
-- stt_access: who may use them. Default deny; managed by an administrator at
-- /dev/stt-access (lib/stt-worker/store.ts), every change in security_audit.
-- The migration inserts nobody.
CREATE TABLE IF NOT EXISTS stt_access (
  user_id  TEXT PRIMARY KEY,
  added_by TEXT NOT NULL,
  added_at INTEGER NOT NULL
);

-- stt_worker: the speech servers allowed to register with the SttRegistry
-- (lianki-push). Each dials out and proves itself with its Ed25519 key; only
-- the public half is here (raw 32 bytes, base64url). owner_user_id NULL = one
-- of Lianki's own speech servers; an account id = that user's personal worker
-- (later: it then serves that account only). capacity NULL = config
-- stt.worker.macCapacity. A revoked worker is refused at once (revoked_at).
-- The migration inserts nobody: a worker is added after the owner's approval.
CREATE TABLE IF NOT EXISTS stt_worker (
  id            TEXT PRIMARY KEY,
  pubkey        TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  owner_user_id TEXT,
  capacity      INTEGER CHECK (capacity IS NULL OR capacity >= 0),
  created_by    TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  revoked_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_stt_worker_owner ON stt_worker(owner_user_id);

-- stt_ticket: the v2 tickets /api/stt/session issued, for the per-account rate
-- (config stt.worker.ticketsPerMin). Ids and times only; a row older than a
-- day is deleted when the same account asks again.
CREATE TABLE IF NOT EXISTS stt_ticket (
  jti     TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stt_ticket_user ON stt_ticket(user_id, at);
