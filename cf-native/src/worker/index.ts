import { Hono } from "hono";
import { getAuth, type AuthEnv } from "./auth";

type Bindings = AuthEnv & {
  BLOBS: R2Bucket;
  ASSETS: Fetcher;
  DB_BACKEND: string;
};

const app = new Hono<{ Bindings: Bindings }>();

// better-auth — framework-agnostic handler mounted on Hono (magic link + OAuth,
// session/cookies). Reuses the migrated D1 auth tables.
app.on(["GET", "POST"], "/api/auth/*", (c) => getAuth(c.env).handler(c.req.raw));

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
