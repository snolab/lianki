import { mergeWatchStats, parseWatchStats, summarizeWatch, type WatchStats } from "@lianki/core";
import {
  WatchStatsD1Repo,
  currentStreak,
  type WatchOverview,
  type WatchRow,
} from "@/lib/repos/watchStatsD1";
import { dbBackend, getD1 } from "@/lib/d1";
import { db } from "./db";

// Backend-agnostic per-video watch time for the Next handler. D1 delegates to the
// shared repo (same code the CF worker runs); Mongo keeps the per-email collection
// convention used by FSRSNotes@{email}.

export type WatchStatsStore = {
  getByUrl(url: string): Promise<WatchRow | null>;
  merge(url: string, incoming: WatchStats, title?: string): Promise<WatchRow>;
  overview(topLimit?: number): Promise<WatchOverview>;
};

type MongoDoc = {
  url: string;
  title?: string;
  stats?: string;
  wall?: number;
  media?: number;
  lang?: string;
  lastSeen?: string;
};

function mongoStore(email?: string): WatchStatsStore {
  const col = db.collection<MongoDoc>(`WatchStats${email?.replace(/^/, "@") ?? ""}`);
  const toRow = (d: MongoDoc | null): WatchRow | null =>
    d && {
      url: d.url,
      title: d.title,
      stats: parseWatchStats(d.stats),
      wall: d.wall ?? 0,
      media: d.media ?? 0,
      lang: d.lang,
      lastSeen: d.lastSeen,
    };
  return {
    async getByUrl(url) {
      return toRow(await col.findOne({ url }));
    },
    async merge(url, incoming, title) {
      const existing = toRow(await col.findOne({ url }));
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
      await col.updateOne(
        { url },
        {
          $set: {
            url,
            stats: JSON.stringify(stats),
            wall: next.wall,
            media: next.media,
            lang: next.lang,
            title: next.title,
            lastSeen: next.lastSeen,
          },
        },
        { upsert: true },
      );
      return next;
    },
    async overview(topLimit = 20) {
      // Same shape as the D1 repo's overview so the page is backend-agnostic.
      const docs = await col.find({}).toArray();
      const rows = docs.map((d) => toRow(d)!).filter(Boolean);
      const days: Record<string, number> = {};
      let wall = 0;
      let media = 0;
      const langs = new Map<string, { wall: number; media: number; videos: number }>();
      for (const r of rows) {
        const s = summarizeWatch(r.stats);
        wall += s.wall;
        media += s.media;
        for (const [day, secs] of Object.entries(s.days)) days[day] = (days[day] ?? 0) + secs;
        const k = r.lang ?? "";
        const agg = langs.get(k) ?? { wall: 0, media: 0, videos: 0 };
        agg.wall += s.wall;
        agg.media += s.media;
        agg.videos += 1;
        langs.set(k, agg);
      }
      return {
        totalWall: Math.round(wall),
        totalMedia: Math.round(media),
        videos: rows.length,
        days,
        streak: currentStreak(days),
        languages: [...langs.entries()]
          .map(([lang, v]) => ({
            lang,
            wall: Math.round(v.wall),
            media: Math.round(v.media),
            videos: v.videos,
          }))
          .sort((a, b) => b.wall - a.wall),
        top: rows
          .map((r) => {
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
          })
          .sort((a, b) => b.wall - a.wall)
          .slice(0, topLimit),
      } satisfies WatchOverview;
    },
  };
}

export function getWatchStatsStore(email?: string): WatchStatsStore {
  if (dbBackend() === "d1") return new WatchStatsD1Repo(getD1(), email ?? "");
  return mongoStore(email);
}
