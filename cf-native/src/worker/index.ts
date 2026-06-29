import { Hono } from "hono";

type Bindings = {
  DB: D1Database;
  BLOBS: R2Bucket;
  ASSETS: Fetcher;
  DB_BACKEND: string;
};

const app = new Hono<{ Bindings: Bindings }>();

// Proves the D1 binding works from the CF-native worker (read-only count).
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
