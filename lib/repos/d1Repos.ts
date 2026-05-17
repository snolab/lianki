import type { D1Like } from "@/lib/d1/types";
import type { RoadmapGoal } from "@/types/roadmap";
import type { FilterPattern } from "@/app/api/preferences/route";
import type { ApiToken } from "@/lib/getApiTokensCollection";

// ── Roadmap goals ────────────────────────────────────────────────────────────

type GoalRow = {
  id: string;
  user_id: string;
  topic: string;
  nodes: string;
  created_at: string;
  updated_at: string;
};

export type RoadmapGoalWithId = RoadmapGoal & { id: string };

function rowToGoal(row: GoalRow): RoadmapGoalWithId {
  return {
    id: row.id,
    topic: row.topic,
    nodes: JSON.parse(row.nodes || "[]"),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

/** D1-backed access to one user's roadmap goals. */
export class RoadmapGoalsD1Repo {
  constructor(
    private readonly db: D1Like,
    private readonly userId: string,
  ) {}

  async listAll(): Promise<RoadmapGoalWithId[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM roadmap_goals WHERE user_id = ? ORDER BY created_at")
      .bind(this.userId)
      .all<GoalRow>();
    return results.map(rowToGoal);
  }

  async getById(id: string): Promise<RoadmapGoalWithId | null> {
    const row = await this.db
      .prepare("SELECT * FROM roadmap_goals WHERE user_id = ? AND id = ?")
      .bind(this.userId, id)
      .first<GoalRow>();
    return row ? rowToGoal(row) : null;
  }

  /** Insert or replace keyed by (user_id, topic). Returns the row id. */
  async upsertByTopic(goal: RoadmapGoal & { id?: string }): Promise<string> {
    const existing = await this.db
      .prepare("SELECT id FROM roadmap_goals WHERE user_id = ? AND topic = ?")
      .bind(this.userId, goal.topic)
      .first<{ id: string }>();
    const id = existing?.id ?? goal.id ?? crypto.randomUUID();
    await this.db
      .prepare(
        `INSERT INTO roadmap_goals (id, user_id, topic, nodes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           topic = excluded.topic, nodes = excluded.nodes, updated_at = excluded.updated_at`,
      )
      .bind(
        id,
        this.userId,
        goal.topic,
        JSON.stringify(goal.nodes ?? []),
        new Date(goal.createdAt).toISOString(),
        new Date(goal.updatedAt).toISOString(),
      )
      .run();
    return id;
  }

  async delete(id: string): Promise<void> {
    await this.db
      .prepare("DELETE FROM roadmap_goals WHERE user_id = ? AND id = ?")
      .bind(this.userId, id)
      .run();
  }
}

// ── Preferences ──────────────────────────────────────────────────────────────

type PrefRow = { user_id: string; mobile_exclude_patterns: string; updated_at: string };

/** D1-backed access to one user's preferences. */
export class PreferencesD1Repo {
  constructor(
    private readonly db: D1Like,
    private readonly userId: string,
  ) {}

  async get(): Promise<{ mobileExcludePatterns: FilterPattern[] } | null> {
    const row = await this.db
      .prepare("SELECT * FROM preferences WHERE user_id = ?")
      .bind(this.userId)
      .first<PrefRow>();
    if (!row) return null;
    return { mobileExcludePatterns: JSON.parse(row.mobile_exclude_patterns || "[]") };
  }

  async set(patterns: FilterPattern[]): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO preferences (user_id, mobile_exclude_patterns, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           mobile_exclude_patterns = excluded.mobile_exclude_patterns,
           updated_at = excluded.updated_at`,
      )
      .bind(this.userId, JSON.stringify(patterns), new Date().toISOString())
      .run();
  }
}

// ── API tokens ───────────────────────────────────────────────────────────────

type TokenRow = { token_hash: string; email: string; name: string; created_at: string };

/** D1-backed access to API tokens (global, not per-user). */
export class ApiTokensD1Repo {
  constructor(private readonly db: D1Like) {}

  async emailByHash(tokenHash: string): Promise<string | null> {
    const row = await this.db
      .prepare("SELECT email FROM api_tokens WHERE token_hash = ?")
      .bind(tokenHash)
      .first<{ email: string }>();
    return row?.email ?? null;
  }

  async listByEmail(email: string): Promise<ApiToken[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM api_tokens WHERE email = ? ORDER BY created_at DESC")
      .bind(email)
      .all<TokenRow>();
    return results.map((r) => ({
      tokenHash: r.token_hash,
      email: r.email,
      name: r.name,
      createdAt: new Date(r.created_at),
    }));
  }

  async insert(token: ApiToken): Promise<void> {
    await this.db
      .prepare("INSERT INTO api_tokens (token_hash, email, name, created_at) VALUES (?, ?, ?, ?)")
      .bind(token.tokenHash, token.email, token.name, new Date(token.createdAt).toISOString())
      .run();
  }

  async delete(tokenHash: string): Promise<void> {
    await this.db.prepare("DELETE FROM api_tokens WHERE token_hash = ?").bind(tokenHash).run();
  }
}
