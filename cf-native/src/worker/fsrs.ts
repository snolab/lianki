import { createHash } from "node:crypto";
import { Hono } from "hono";
import { createEmptyCard, fsrs, generatorParameters, Rating, type Grade } from "ts-fsrs";
import type { D1Like } from "@/lib/d1/types";
import { FsrsNotesD1Repo, type StoredNote } from "@/lib/repos/fsrsNotesD1";
import { ApiTokensD1Repo } from "@/lib/repos/d1Repos";
import { RATING_MAP, newServerHLC, compareHLC, type HLC } from "@/app/fsrs-helpers";
import { normalizeUrl } from "@/lib/normalizeUrl";
import { dueMs } from "@/app/ems";
import { getAuth, type AuthEnv } from "./auth";

// Faithful CF-native port of the userscript's FSRS API (app/fsrs.ts), built on
// the reused shared core (FsrsNotesD1Repo, fsrs-helpers, normalizeUrl, ems) —
// no Next/Mongo. Same FSRS scheduling, HLC conflict handling, and next-due rules.

type Bindings = AuthEnv & { DB: D1Like };
type Ctx = { env: Bindings; req: { raw: Request } };

const fsrsConfig = fsrs(generatorParameters({ enable_fuzz: true }));
const LABELS = ["Again", "Hard", "Good", "Easy"] as const;
const GRADES = [Rating.Again, Rating.Hard, Rating.Good, Rating.Easy] as const;

/** Resolve the caller's email from a Bearer API token, else the session cookie. */
async function resolveEmail(env: Bindings, req: Request): Promise<string | null> {
  const authz = req.headers.get("authorization");
  if (authz?.startsWith("Bearer ")) {
    const hash = createHash("sha256").update(authz.slice(7)).digest("hex");
    const email = await new ApiTokensD1Repo(env.DB).emailByHash(hash);
    if (email) return email;
  }
  const session = await getAuth(env).api.getSession({ headers: req.headers });
  return session?.user?.email ?? null;
}

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
): Promise<StoredNote | null> {
  const due = await repo.listDue(new Date(), 50);
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
      const cards = await repo.listDue(new Date(), limit);
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

      const next = await nextDue(repo, note.url);
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
      const next = await nextDue(repo, normalizeUrl(url));
      return c.json({ ok: true, nextUrl: next?.url ?? null, nextTitle: next?.title ?? null });
    }),
  );
}
