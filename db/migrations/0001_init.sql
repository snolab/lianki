-- Lianki D1 schema — initial migration.
--
-- Date columns are TEXT storing ISO 8601 strings (sorts lexically, matches YAML export).
-- JSON-shaped columns (card, log, nodes, ...) are TEXT storing JSON.
--
-- The better-auth tables (user/session/account/verification) follow better-auth's
-- SQLite schema. Run `bunx @better-auth/cli generate` against the configured Kysely
-- adapter to confirm this matches the installed better-auth version before cutover.

-- ── better-auth: user ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user (
  id            TEXT PRIMARY KEY NOT NULL,
  name          TEXT,
  email         TEXT NOT NULL UNIQUE,
  emailVerified INTEGER NOT NULL DEFAULT 0,
  image         TEXT,
  createdAt     TEXT NOT NULL,
  updatedAt     TEXT NOT NULL,
  -- Lianki custom fields (better-auth additionalFields)
  trialEndsAt   TEXT,
  proEndsAt     TEXT
);

-- ── better-auth: session ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS session (
  id        TEXT PRIMARY KEY NOT NULL,
  userId    TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  token     TEXT NOT NULL UNIQUE,
  expiresAt TEXT NOT NULL,
  ipAddress TEXT,
  userAgent TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_session_userId ON session(userId);
CREATE INDEX IF NOT EXISTS idx_session_token ON session(token);

-- ── better-auth: account (OAuth + credential) ────────────────────────────────
CREATE TABLE IF NOT EXISTS account (
  id                    TEXT PRIMARY KEY NOT NULL,
  userId                TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  accountId             TEXT NOT NULL,
  providerId            TEXT NOT NULL,
  accessToken           TEXT,
  refreshToken          TEXT,
  idToken               TEXT,
  accessTokenExpiresAt  TEXT,
  refreshTokenExpiresAt TEXT,
  scope                 TEXT,
  password              TEXT,
  createdAt             TEXT NOT NULL,
  updatedAt             TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_account_userId ON account(userId);

-- ── better-auth: verification (magic links) ──────────────────────────────────
CREATE TABLE IF NOT EXISTS verification (
  id         TEXT PRIMARY KEY NOT NULL,
  identifier TEXT NOT NULL,
  value      TEXT NOT NULL,
  expiresAt  TEXT NOT NULL,
  createdAt  TEXT,
  updatedAt  TEXT
);
CREATE INDEX IF NOT EXISTS idx_verification_identifier ON verification(identifier);

-- ── App: fsrs_notes ──────────────────────────────────────────────────────────
-- Replaces the per-user MongoDB collections `FSRSNotes@{email}`.
-- card / log / speedMarkers / hlc are stored as JSON TEXT.
CREATE TABLE IF NOT EXISTS fsrs_notes (
  user_id       TEXT NOT NULL,
  url           TEXT NOT NULL,
  title         TEXT,
  card          TEXT NOT NULL,            -- JSON: ts-fsrs Card
  log           TEXT NOT NULL DEFAULT '[]', -- JSON: ReviewLog[]
  notes         TEXT,
  speed_markers TEXT,                     -- JSON: Record<number, number>
  hlc           TEXT,                     -- JSON: HLC
  device_id     TEXT,
  card_due      TEXT NOT NULL,            -- denormalized card.due for due-query indexing
  PRIMARY KEY (user_id, url)
);
CREATE INDEX IF NOT EXISTS idx_fsrs_notes_due ON fsrs_notes(user_id, card_due);

-- ── App: roadmap_goals ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS roadmap_goals (
  id         TEXT PRIMARY KEY NOT NULL,
  user_id    TEXT NOT NULL,
  topic      TEXT NOT NULL,
  nodes      TEXT NOT NULL DEFAULT '[]',  -- JSON: RoadmapNode[]
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_roadmap_goals_user ON roadmap_goals(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_roadmap_goals_user_topic ON roadmap_goals(user_id, topic);

-- ── App: preferences ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS preferences (
  user_id                 TEXT PRIMARY KEY NOT NULL,
  mobile_exclude_patterns TEXT NOT NULL DEFAULT '[]', -- JSON: FilterPattern[]
  updated_at              TEXT NOT NULL
);

-- ── App: api_tokens ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS api_tokens (
  token_hash TEXT PRIMARY KEY NOT NULL,
  email      TEXT NOT NULL,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_api_tokens_email ON api_tokens(email);

-- ── App: read_materials (metadata only; binary content lives in R2) ──────────
CREATE TABLE IF NOT EXISTS read_materials (
  id         TEXT PRIMARY KEY NOT NULL,
  user_id    TEXT NOT NULL,
  title      TEXT NOT NULL,
  lines      TEXT NOT NULL DEFAULT '[]',  -- JSON: string[]
  r2_key     TEXT,                        -- R2 object key for large content
  content    TEXT,                        -- inline content for small materials
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_read_materials_user ON read_materials(user_id);
