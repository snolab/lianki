import { Hono } from "hono";
import type { D1Like } from "@/lib/d1/types";
import { getAuth, type AuthEnv } from "./auth";
import { mountFsrs } from "./fsrs";
import { mountDataRoutes } from "./data-routes";
import { mountReadProgress } from "./read-progress";

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

// Non-/api requests fall through to Static Assets (SPA fallback handled by
// not_found_handling="single-page-application").
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
