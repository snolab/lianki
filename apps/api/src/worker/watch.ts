import { Hono } from "hono";
import {
  lookupYoutubeLanguages,
  sanitizeWatchStats,
  summarizeWatch,
  youtubeVideoId,
} from "@lianki/core";
import { WatchStatsD1Repo } from "@/lib/repos/watchStatsD1";
import { normalizeUrl } from "@/lib/normalizeUrl";
import { resolveEmail } from "./session";

// Per-video watch-time sync. The client accumulates locally (offline-first) and
// POSTs its whole grow-only counter; the server folds it into what it has. The
// merge is idempotent, so a retried POST after a dropped response is harmless.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mountWatch(app: Hono<any>) {
  const auth =
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (handler: (c: any, repo: WatchStatsD1Repo) => Promise<Response>) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (c: any) => {
        const email = await resolveEmail(c.env, c.req.raw);
        if (!email) return c.json({ error: "Login required" }, 401);
        return handler(c, new WatchStatsD1Repo(c.env.DB, email));
      };

  app.get(
    "/api/fsrs/watch",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    auth(async (c: any, repo) => {
      const url = c.req.query("url");
      if (!url) return c.json({ error: "no url" }, 400);
      const row = await repo.getByUrl(normalizeUrl(url));
      return c.json({
        stats: row?.stats ?? { v: 1, by: {} },
        summary: summarizeWatch(row?.stats),
      });
    }),
  );

  app.post(
    "/api/fsrs/watch",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    auth(async (c: any, repo) => {
      const body = await c.req.json().catch(() => null);
      const url = typeof body?.url === "string" ? body.url : "";
      if (!url) return c.json({ error: "no url" }, 400);
      const title = typeof body?.title === "string" ? body.title.slice(0, 512) : undefined;
      const row = await repo.merge(normalizeUrl(url), sanitizeWatchStats(body?.stats), title);
      return c.json({ ok: true, stats: row.stats, summary: summarizeWatch(row.stats) });
    }),
  );

  app.get(
    "/api/fsrs/watch/top",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    auth(async (c: any, repo) => {
      const limit = Math.min(200, parseInt(c.req.query("limit") ?? "50", 10) || 50);
      const rows = await repo.listTop(limit);
      return c.json({
        videos: rows.map((r) => ({
          url: r.url,
          title: r.title ?? null,
          lang: r.lang ?? null,
          lastSeen: r.lastSeen ?? null,
          ...summarizeWatch(r.stats),
        })),
      });
    }),
  );

  // One call backing the whole stats page — totals, per-day heatmap series,
  // streak, per-language breakdown, and top videos.
  /**
   * Fill in missing audio languages from the YouTube Data API.
   *
   * Client-side detection can't reach ytInitialPlayerResponse from an isolated
   * world, so rows arrive unlabelled and "hours per language" — the whole point
   * of tracking — stays empty. This backfills them in bulk (50 ids per call).
   *
   * Explicitly triggered rather than run on every POST: it costs quota, and the
   * sync path should never block on a third-party API.
   */
  app.post(
    "/api/fsrs/watch/enrich",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    auth(async (c: any, repo) => {
      const apiKey = c.env.YOUTUBE_API_KEY;
      if (!apiKey) return c.json({ error: "YOUTUBE_API_KEY not configured" }, 501);

      const rows = await repo.listTop(500);
      const pending = rows
        .filter((r) => !r.lang)
        .map((r) => ({ row: r, id: youtubeVideoId(r.url) }))
        .filter((x): x is { row: (typeof rows)[number]; id: string } => !!x.id)
        .slice(0, 200); // bound the quota spend per request
      if (!pending.length) return c.json({ ok: true, checked: 0, labelled: 0 });

      const found = await lookupYoutubeLanguages(
        pending.map((p) => p.id),
        apiKey,
      );

      let labelled = 0;
      for (const { row, id } of pending) {
        const hit = found.get(id);
        if (!hit?.lang) continue;
        // Write through the CRDT under a distinct device id so the label merges
        // like any other observation instead of overwriting a device's own.
        await repo.merge(
          row.url,
          {
            v: 1,
            by: {
              server: {
                wall: 0,
                media: 0,
                sessions: 0,
                days: {},
                lang: hit.lang,
                last: new Date().toISOString(),
              },
            },
          },
          row.title ?? hit.title,
        );
        labelled++;
      }
      return c.json({ ok: true, checked: pending.length, labelled });
    }),
  );

  app.get(
    "/api/fsrs/watch/overview",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    auth(async (c: any, repo) => {
      const limit = Math.min(100, parseInt(c.req.query("top") ?? "20", 10) || 20);
      return c.json(await repo.overview(limit));
    }),
  );

  app.get(
    "/api/fsrs/watch/languages",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    auth(async (c: any, repo) => c.json({ languages: await repo.totalsByLang() })),
  );
}
