import { Hono } from "hono";
import type { D1Like } from "@/lib/d1/types";
import { getAuth, type AuthEnv } from "./auth";
import { mountFsrs } from "./fsrs";
import { mountDataRoutes } from "./data-routes";
import { mountReadProgress } from "./read-progress";
import { mountAiRoutes } from "./ai";
import { mountImportRoutes } from "./import";
import { mountMiscRoutes } from "./misc";
import { mountContentRoutes } from "./content";
import { mountPolyglotRoutes } from "./polyglot";
import { mountSelfIntroRoutes } from "./self-intro";

type Bindings = AuthEnv & {
  DB: D1Like;
  BLOBS: R2Bucket;
  ASSETS: Fetcher;
  DB_BACKEND: string;
};

const app = new Hono<{ Bindings: Bindings }>();

// better-auth — framework-agnostic handler (magic link + OAuth, session/cookies).
app.on(["GET", "POST"], "/api/auth/*", (c) => getAuth(c.env).handler(c.req.raw));

// FSRS core API (the userscript's endpoints), ported onto the reused shared core.
mountFsrs(app);
// Data routes: token, preferences, membership, roadmap, export.
mountDataRoutes(app);
// Read materials (D1 + R2) and roadmap node progress.
mountReadProgress(app);
// AI vocab routes (OpenAI via fetch).
mountAiRoutes(app);
// Import routes (yaml restore, youtube, anki-client).
mountImportRoutes(app);
// Contact form + Slack events webhook.
mountMiscRoutes(app);
// Content routes (blog translate stream, tts, roadmap generate).
mountContentRoutes(app);
// Polyglot routes (translate, tts, save-cards).
mountPolyglotRoutes(app);
// Self-intro routes (translate, tts, save-cards).
mountSelfIntroRoutes(app);

// Health/D1 sanity check.
app.get("/api/health", async (c) => {
  try {
    const row = await c.env.DB.prepare("SELECT count(*) AS notes FROM fsrs_notes").first<{
      notes: number;
    }>();
    return c.json({ ok: true, backend: c.env.DB_BACKEND ?? "?", notes: row?.notes ?? null });
  } catch (e) {
    return c.json({ ok: false, error: String(e) }, 500);
  }
});

// Non-/api requests fall through to Static Assets. On Workers this uses
// not_found_handling="single-page-application"; on Pages (no such config) we
// do the SPA fallback explicitly: a 404 for an extension-less, non-/api path
// serves index.html so client-side routes resolve.
app.all("*", async (c) => {
  const res = await c.env.ASSETS.fetch(c.req.raw);
  const { pathname } = new URL(c.req.url);
  if (res.status === 404 && !pathname.startsWith("/api/") && !/\.[a-z0-9]+$/i.test(pathname)) {
    const index = await c.env.ASSETS.fetch(new Request(new URL("/", c.req.url)));
    if (index.ok) return new Response(index.body, { status: 200, headers: index.headers });
  }
  return res;
});

export default app;
