-- GitHub Sponsors (lib/payments/sponsors*.ts). One row per sponsorship, keyed
-- by its GraphQL node_id. userId is NULL while the sponsor has no Lianki
-- account with that GitHub id linked: the sponsorship waits, and is claimed
-- when that GitHub account signs in or is linked. The Pro days themselves are
-- membership_grant rows (reason 'github-sponsors'), once per billing period.
CREATE TABLE IF NOT EXISTS github_sponsorship (
  id         TEXT PRIMARY KEY NOT NULL,  -- sponsorship.node_id
  githubId   TEXT NOT NULL,              -- sponsor's numeric GitHub user id = account.accountId
  userId     TEXT REFERENCES user(id) ON DELETE SET NULL,
  oneTime    INTEGER NOT NULL,           -- 1 for a one-time tier
  priceCents INTEGER NOT NULL,           -- the tier's price, in US cents
  startedAt  TEXT NOT NULL,              -- sponsorship.created_at: the billing anchor
  status     TEXT NOT NULL,              -- 'active' | 'cancelled'
  endsAt     TEXT,                       -- a scheduled or actual cancellation
  createdAt  TEXT NOT NULL,
  updatedAt  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_github_sponsorship_githubId ON github_sponsorship(githubId);
CREATE INDEX IF NOT EXISTS idx_github_sponsorship_userId ON github_sponsorship(userId);
