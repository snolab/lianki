import { mergeWatchStats, parseWatchStats, summarizeWatch, type WatchStats } from "@lianki/core";
import type { D1Like } from "@/lib/d1/types";

/** One row of `watch_stats`, with the JSON already parsed. */
export type WatchRow = {
  url: string;
  title?: string;
  stats: WatchStats;
  /** Denormalized totals, kept in sync with `stats` on every write. */
  wall: number;
  media: number;
  lang?: string;
  lastSeen?: string;
};

type Row = {
  url: string;
  title: string | null;
  stats: string;
  wall: number;
  media: number;
  lang: string | null;
  last_seen: string | null;
};

export type WatchOverview = {
  totalWall: number;
  totalMedia: number;
  videos: number;
  /** YYYY-MM-DD → active seconds, for the heatmap. */
  days: Record<string, number>;
  streak: number;
  languages: { lang: string; wall: number; media: number; videos: number }[];
  top: {
    url: string;
    title: string | null;
    lang: string | null;
    wall: number;
    coverage: number | null;
    sessions: number;
    lastSeen: string | null;
  }[];
};

/**
 * Consecutive days with any activity, counting back from today.
 *
 * Starts at yesterday if today is empty rather than breaking the streak — the
 * day is not over yet, and zeroing someone's streak at 00:01 for not having
 * studied yet would be both wrong and demoralising.
 */
export function currentStreak(days: Record<string, number>, now = new Date()): number {
  const key = (d: Date) => d.toLocaleDateString("en-CA");
  const cursor = new Date(now);
  if (!days[key(cursor)]) cursor.setDate(cursor.getDate() - 1);
  let streak = 0;
  while (days[key(cursor)] > 0) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

const rowToWatch = (r: Row): WatchRow => ({
  url: r.url,
  title: r.title ?? undefined,
  stats: parseWatchStats(r.stats),
  wall: r.wall,
  media: r.media,
  lang: r.lang ?? undefined,
  lastSeen: r.last_seen ?? undefined,
});

/**
 * D1-backed per-video watch time for one user.
 *
 * Separate from FsrsNotesD1Repo on purpose: watching a video records hours here
 * without enqueuing a review card. See db/migrations/0002_watch_stats.sql.
 */
export class WatchStatsD1Repo {
  constructor(
    private readonly db: D1Like,
    private readonly email: string,
  ) {}

  async getByUrl(url: string): Promise<WatchRow | null> {
    const row = await this.db
      .prepare("SELECT * FROM watch_stats WHERE email = ? AND url = ?")
      .bind(this.email, url)
      .first<Row>();
    return row ? rowToWatch(row) : null;
  }

  /**
   * Fold `incoming` into whatever is stored and persist the result.
   *
   * Read-then-write is not atomic on D1, so two devices POSTing at the same
   * instant can lose one side's update. That is self-healing rather than
   * corrupting: the merge is max-based, and a client keeps its dirty flag set
   * until it sees a 2xx, so the next 30 s sync re-sends and the max wins.
   */
  async merge(url: string, incoming: WatchStats, title?: string): Promise<WatchRow> {
    const existing = await this.getByUrl(url);
    const stats = mergeWatchStats(existing?.stats, incoming);
    const s = summarizeWatch(stats);
    const next: WatchRow = {
      url,
      title: title ?? existing?.title,
      stats,
      wall: Math.round(s.wall),
      media: Math.round(s.media),
      lang: s.lang,
      lastSeen: s.last,
    };
    await this.db
      .prepare(
        `INSERT INTO watch_stats (email, url, stats, wall, media, lang, title, last_seen)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(email, url) DO UPDATE SET
           stats = excluded.stats, wall = excluded.wall, media = excluded.media,
           lang = excluded.lang, title = excluded.title, last_seen = excluded.last_seen`,
      )
      .bind(
        this.email,
        url,
        JSON.stringify(stats),
        next.wall,
        next.media,
        next.lang ?? null,
        next.title ?? null,
        next.lastSeen ?? null,
      )
      .run();
    return next;
  }

  /** Most-watched videos first — the denormalized `wall` column keeps this indexed. */
  async listTop(limit = 50): Promise<WatchRow[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM watch_stats WHERE email = ? ORDER BY wall DESC LIMIT ?")
      .bind(this.email, limit)
      .all<Row>();
    return results.map(rowToWatch);
  }

  /** Total active seconds per language, biggest first. Null language groups as "". */
  async totalsByLang(): Promise<{ lang: string; wall: number; media: number; videos: number }[]> {
    const { results } = await this.db
      .prepare(
        `SELECT COALESCE(lang, '') AS lang, SUM(wall) AS wall, SUM(media) AS media,
                COUNT(*) AS videos
           FROM watch_stats WHERE email = ?
          GROUP BY COALESCE(lang, '') ORDER BY wall DESC`,
      )
      .bind(this.email)
      .all<{ lang: string; wall: number; media: number; videos: number }>();
    return results;
  }

  /**
   * Everything the stats page needs, in one pass.
   *
   * The per-day series has to come from the JSON, not a column: `days` is a map
   * inside each row's CRDT and there is no per-day table. Rows are streamed and
   * summed here rather than in SQL, because SQLite cannot sum across JSON object
   * keys without a json_each join per row — and at a few thousand videos the
   * scan is cheaper than the query complexity.
   */
  async overview(topLimit = 20): Promise<WatchOverview> {
    const { results } = await this.db
      .prepare("SELECT * FROM watch_stats WHERE email = ?")
      .bind(this.email)
      .all<Row>();

    const days: Record<string, number> = {};
    let wall = 0;
    let media = 0;
    for (const row of results) {
      const s = summarizeWatch(parseWatchStats(row.stats));
      wall += s.wall;
      media += s.media;
      for (const [day, secs] of Object.entries(s.days)) days[day] = (days[day] ?? 0) + secs;
    }

    return {
      totalWall: Math.round(wall),
      totalMedia: Math.round(media),
      videos: results.length,
      days,
      streak: currentStreak(days),
      languages: await this.totalsByLang(),
      top: (await this.listTop(topLimit)).map((r) => {
        const s = summarizeWatch(r.stats);
        return {
          url: r.url,
          title: r.title ?? null,
          lang: r.lang ?? null,
          wall: Math.round(s.wall),
          coverage: s.coverage ?? null,
          sessions: s.sessions,
          lastSeen: r.lastSeen ?? null,
        };
      }),
    };
  }

  async delete(url: string): Promise<void> {
    await this.db
      .prepare("DELETE FROM watch_stats WHERE email = ? AND url = ?")
      .bind(this.email, url)
      .run();
  }
}
