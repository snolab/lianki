/**
 * lianki-edge: the Hono front Worker of docs/framework-migration.md, section 4.
 * A ported route answers here; everything else goes to `lianki` over MAIN,
 * unchanged. Spike only: one route, and no traffic reaches it.
 */
import { Hono } from "hono";
import { hasSessionCookie } from "@/lib/auth-env";
import { runWithCloudflareContext } from "./context";

type Env = {
  /** Absent on the cold-start deployment (wrangler.cold.jsonc). */
  MAIN?: { fetch(request: Request): Promise<Response> };
  /** Set only on the cold-start deployment: adds x-spike-* to each answer. */
  SPIKE_SAMPLE?: string;
};

let isolateRequests = 0;

const app = new Hono<{ Bindings: Env }>();

app.use((c, next) => {
  isolateRequests++;
  return runWithCloudflareContext(
    { env: c.env, ctx: c.executionCtx, cf: (c.req.raw as Request & { cf?: unknown }).cf },
    async () => {
      await next();
      if (c.env.SPIKE_SAMPLE) {
        c.header("x-spike-sample", c.env.SPIKE_SAMPLE);
        c.header("x-spike-isolate-requests", String(isolateRequests));
      }
    },
  );
});

// Ported from app/api/preferences/route.ts, its D1 branch: DB_BACKEND is always
// d1 here. POST is not ported, so it falls through to MAIN.
app.get("/api/preferences", async (c) => {
  try {
    // As authSessionOrNull: a guest never loads better-auth or the repos.
    const headers = c.req.raw.headers;
    if (!hasSessionCookie(headers)) return c.json({ error: "Login required" }, 401);
    const { getPreferencesFor } = await import("./preferences");
    const { body, setCookies } = await getPreferencesFor(headers);
    for (const line of setCookies) c.header("set-cookie", line, { append: true });
    return body ? c.json(body) : c.json({ error: "Login required" }, 401);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: message }, 500);
  }
});

app.all("*", (c) =>
  c.env.MAIN ? c.env.MAIN.fetch(c.req.raw) : c.json({ error: "No MAIN binding" }, 503),
);

export default app;
