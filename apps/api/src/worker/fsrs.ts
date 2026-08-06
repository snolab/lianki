import { Hono } from "hono";
import { createEmptyCard, fsrs, generatorParameters, Rating, type Grade } from "ts-fsrs";
import { FsrsNotesD1Repo, type StoredNote } from "@/lib/repos/fsrsNotesD1";
import { RATING_MAP, newServerHLC, compareHLC, type HLC } from "@/app/fsrs-helpers";
import { normalizeUrl } from "@/lib/normalizeUrl";
import { dueMs } from "@/app/ems";
import { resolveEmail, resolveUser, type Env } from "./session";
import { PreferencesD1Repo } from "@/lib/repos/d1Repos";
import { DEFAULT_REVIEW_ORDER, type ReviewOrder } from "@lianki/core";

// Faithful CF-native port of the userscript's FSRS API (app/fsrs.ts), built on
// the reused shared core (FsrsNotesD1Repo, fsrs-helpers, normalizeUrl, ems) —
// no Next/Mongo. Same FSRS scheduling, HLC conflict handling, and next-due rules.

type Ctx = { env: Env; req: { raw: Request } };

const fsrsConfig = fsrs(generatorParameters({ enable_fuzz: true }));
const LABELS = ["Again", "Hard", "Good", "Easy"] as const;
const GRADES = [Rating.Again, Rating.Hard, Rating.Good, Rating.Easy] as const;

function reviewOptions(card: StoredNote["card"]) {
  const rep = fsrsConfig.repeat(card, new Date());
  return GRADES.map((rating, i) => ({
    rating,
    label: LABELS[i],
    due: dueMs(rep[rating].card.due),
  }));
}

/** Upsert by normalized url (createEmptyCard on insert); update title if changed. */
async function saveNote(repo: FsrsNotesD1Repo, url: string, title?: string): Promise<StoredNote> {
  const normalized = normalizeUrl(url);
  const existing = await repo.getByUrl(normalized);
  if (existing) {
    if (title && title !== existing.title) {
      const { id, ...note } = existing;
      await repo.upsert({ ...note, title }, id);
      return { ...existing, title };
    }
    return existing;
  }
  const note = { url: normalized, card: createEmptyCard(), hlc: newServerHLC(), log: [] };
  const id = await repo.upsert(note);
  return { ...note, id };
}

/** Soonest due-now card (card.due ≤ now), excluding the current url + domains. */
async function nextDue(
  repo: FsrsNotesD1Repo,
  excludeUrl?: string,
  excludeDomains: string[] = [],
  order: ReviewOrder = DEFAULT_REVIEW_ORDER,
): Promise<StoredNote | null> {
  const due = await repo.listDue(new Date(), 50, order);
  return (
    due.find((n) => n.url !== excludeUrl && !excludeDomains.some((d) => d && n.url.includes(d))) ??
    null
  );
}

// Loosely typed app param (handlers read `c` as any) so callers can pass a Hono
// with any Bindings without invariance friction.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mountFsrs(app: Hono<any>) {
  // email-guarded handler: 401 if unauthenticated, else pass a per-user repo
  const auth =
    (
      handler: (
        c: Ctx & { json: typeof Response.json },
        repo: FsrsNotesD1Repo,
      ) => Promise<Response>,
    ) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (c: any) => {
      const email = await resolveEmail(c.env, c.req.raw);
      if (!email) return c.json({ error: "Login required" }, 401);
      return handler(c, new FsrsNotesD1Repo(c.env.DB, email));
    };

  /** The user's next-card order. Preferences are keyed by user id, not email. */
  const orderFor = async (c: any): Promise<ReviewOrder> => {
    try {
      const user = await resolveUser(c.env, c.req.raw);
      if (!user?.id) return DEFAULT_REVIEW_ORDER;
      return await new PreferencesD1Repo(c.env.DB, user.id).reviewOrder();
    } catch {
      return DEFAULT_REVIEW_ORDER; // never let a preference lookup break reviewing
    }
  };

  app.post(
    "/api/fsrs/add",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    auth(async (c: any, repo) => {
      const { url, title } = await c.req.json();
      const saved = await saveNote(repo, url, title ?? undefined);
      return c.json({
        ...saved,
        _id: saved.id,
        options: reviewOptions(saved.card),
        notes: saved.notes ?? "",
      });
    }),
  );

  app.get(
    "/api/fsrs/due",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    auth(async (c: any, repo) => {
      const limit = parseInt(c.req.query("limit") ?? "10", 10);
      const cards = await repo.listDue(new Date(), limit, await orderFor(c));
      return c.json({
        cards: cards.map((n) => ({
          _id: n.id,
          url: n.url,
          title: n.title,
          card: n.card,
          log: n.log,
          notes: n.notes,
          hlc: n.hlc ?? newServerHLC(),
        })),
      });
    }),
  );

  const nextUrl =
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    auth(async (c: any, repo) => {
      const note = await nextDue(
        repo,
        c.req.query("excludeUrl") ?? undefined,
        c.req.query("excludeDomains")?.split(",").filter(Boolean) ?? [],
        await orderFor(c),
      );
      return c.json({ url: note?.url ?? null, title: note?.title ?? null });
    });
  app.get("/api/fsrs/next-url", nextUrl);
  app.get("/api/fsrs/next", nextUrl);

  const review =
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    auth(async (c: any, repo) => {
      const grade = RATING_MAP[c.req.param("rating")] as Grade | undefined;
      if (grade == null) return c.json({ error: "unknown rating" }, 400);
      const url = c.req.query("url");
      if (!url) return c.json({ error: "no url" }, 400);
      const note = await repo.getByUrl(normalizeUrl(url));
      if (!note) return c.json({ error: "note not found" }, 404);

      let clientHLC: HLC | undefined;
      try {
        clientHLC = (await c.req.json())?.hlc;
      } catch {
        // body optional
      }
      if (clientHLC && note.hlc && compareHLC(clientHLC, note.hlc) < 0) {
        return c.json(
          {
            ok: false,
            error: "conflict",
            message: "Server has newer version",
            serverHLC: note.hlc,
            card: note.card,
            log: note.log,
          },
          409,
        );
      }

      const { card, log } = fsrsConfig.repeat(note.card, new Date())[grade];
      const now = Date.now();
      const newHLC: HLC = clientHLC
        ? {
            timestamp: Math.max(clientHLC.timestamp, now),
            counter: clientHLC.timestamp >= now ? clientHLC.counter + 1 : 0,
            deviceId: clientHLC.deviceId,
          }
        : newServerHLC(note.hlc);

      const { id, ...noteData } = note;
      const newLog = [...(note.log ?? []), log];
      await repo.upsert({ ...noteData, card, hlc: newHLC, log: newLog }, id);

      const next = await nextDue(repo, note.url, [], await orderFor(c));
      return c.json({
        ok: true,
        due: dueMs(card.due),
        card,
        log: newLog,
        hlc: newHLC,
        nextUrl: next?.url ?? null,
        nextTitle: next?.title ?? null,
      });
    });
  app.post("/api/fsrs/review/:rating", review);
  app.get("/api/fsrs/review/:rating", review);

  app.patch(
    "/api/fsrs/update-url",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    auth(async (c: any, repo) => {
      const { oldUrl, newUrl } = await c.req.json();
      await repo.updateUrl(normalizeUrl(oldUrl), normalizeUrl(newUrl));
      return c.json({ ok: true });
    }),
  );

  app.get(
    "/api/fsrs/delete",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    auth(async (c: any, repo) => {
      const url = c.req.query("url");
      if (!url) return c.json({ error: "no url" }, 400);
      await repo.delete(normalizeUrl(url));
      const next = await nextDue(repo, normalizeUrl(url), [], await orderFor(c));
      return c.json({ ok: true, nextUrl: next?.url ?? null, nextTitle: next?.title ?? null });
    }),
  );

  // Review options for one note, by id or url. The userscript's getOptions()
  // calls this on every dialog open.
  app.get(
    "/api/fsrs/options",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    auth(async (c: any, repo) => {
      const id = c.req.query("id");
      const url = c.req.query("url");
      const note = id
        ? await repo.getById(id)
        : url
          ? await repo.getByUrl(normalizeUrl(url))
          : null;
      if (!note) return c.json({ error: "note not found" }, 404);
      return c.json({ id: note.id, _id: note.id, options: reviewOptions(note.card) });
    }),
  );

  // Existence check used by the offline sync queue to confirm a card reached the
  // server. It called /api/fsrs/get, which was implemented on NO backend — so
  // that queue step has been 404ing for everyone. Implemented rather than
  // rerouted: a liveness probe should not have to compute FSRS scheduling.
  app.get(
    "/api/fsrs/get",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    auth(async (c: any, repo) => {
      const url = c.req.query("url");
      if (!url) return c.json({ error: "no url" }, 400);
      const note = await repo.getByUrl(normalizeUrl(url));
      if (!note) return c.json({ error: "note not found" }, 404);
      return c.json({ _id: note.id, url: note.url, title: note.title ?? null, card: note.card });
    }),
  );

  // Bulk add (the userscript's Alt+Shift+V paste-a-list flow).
  app.post(
    "/api/fsrs/batch-add",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    auth(async (c: any, repo) => {
      const body = await c.req.json().catch(() => null);
      const urls = Array.isArray(body?.urls) ? body.urls.filter(Boolean).slice(0, 500) : null;
      if (!urls) return c.json({ error: "urls must be an array" }, 400);
      const results = await Promise.allSettled(urls.map((u: string) => saveNote(repo, u)));
      const count = results.filter((r) => r.status === "fulfilled").length;
      return c.json({ success: true, count, failed: results.length - count, total: urls.length });
    }),
  );

  // Speed markers — {timestamp: playbackRate}, stored on the note itself.
  //
  // These were missing from this worker while app/fsrs.ts had them, so after the
  // cf-native cutover the userscript's 30 s marker sync would have 404'd and
  // markers would have silently stopped leaving the browser — taking the
  // difficulty heatmap's cross-device data with them.
  app.get(
    "/api/fsrs/speed-markers",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    auth(async (c: any, repo) => {
      const url = c.req.query("url");
      if (!url) return c.json({ error: "no url" }, 400);
      const note = await repo.getByUrl(normalizeUrl(url));
      return c.json({ markers: note?.speedMarkers ?? {} });
    }),
  );

  app.post(
    "/api/fsrs/speed-markers",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    auth(async (c: any, repo) => {
      const body = await c.req.json().catch(() => null);
      const url = typeof body?.url === "string" ? body.url : "";
      if (!url) return c.json({ error: "no url" }, 400);

      // Keep only sane {seconds: rate} pairs — this is client-supplied and lands
      // in a JSON column that the player later trusts to set playbackRate.
      const markers: Record<string, number> = {};
      for (const [t, rate] of Object.entries(body?.markers ?? {}).slice(0, 2000)) {
        const time = Number(t);
        const r = Number(rate);
        if (Number.isFinite(time) && time >= 0 && Number.isFinite(r) && r > 0 && r <= 16)
          markers[String(time)] = r;
      }

      // Upsert: the Mongo route used { upsert: true }, so marking speeds on a
      // page you have not carded yet still persists. saveNote creates on demand.
      const note = await saveNote(repo, url);
      const { id, ...rest } = note;
      await repo.upsert({ ...rest, speedMarkers: markers }, id);
      return c.json({ ok: true });
    }),
  );

  // Note text (max 128 chars) — the review dialog's notes box. Also absent here
  // while present in app/fsrs.ts.
  app.patch(
    "/api/fsrs/notes",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    auth(async (c: any, repo) => {
      const body = await c.req.json().catch(() => null);
      const url = c.req.query("url") ?? body?.url;
      if (!url) return c.json({ error: "no url" }, 400);
      if (typeof body?.notes !== "string" || body.notes.length > 128)
        return c.json({ error: "notes must be a string of at most 128 chars" }, 400);
      const note = await repo.getByUrl(normalizeUrl(url));
      if (!note) return c.json({ error: "note not found" }, 404);
      const { id, ...rest } = note;
      await repo.upsert({ ...rest, notes: body.notes }, id);
      return c.json({ ok: true });
    }),
  );
}
