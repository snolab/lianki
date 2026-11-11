/**
 * GET /api/dev/costs for /dev/costs (docs/payments.md, "Cost ledger"). Admin
 * only: anyone else, or no D1, gets a plain 404.
 *
 * - `?from=YYYY-MM-DD&to=YYYY-MM-DD` (JST days, inclusive; default the last 30)
 *   → totals, by day and by feature, free and paid side by side;
 * - `&view=users&offset=N&limit=M` → accounts, the dearest first (the top
 *   spenders), for the page's continuous scroll. Account id and display name
 *   only — never an email.
 */
import type { D1Like } from "@/lib/d1/types";
import { costSummary, costUsers, defaultRange, isDay, type CostRange } from "./cost-ledger";

/** The widest range one request may ask for. */
export const COSTS_MAX_DAYS = 400;
/** The most account rows in one batch. */
export const COSTS_MAX_LIMIT = 200;

const NO_STORE = { "cache-control": "no-store" };
const notFound = () => new Response(null, { status: 404, headers: NO_STORE });
const bad = (error: string) => Response.json({ error }, { status: 400, headers: NO_STORE });

/** The asked range, or a default; null when it is malformed or too wide. */
export function rangeOf(q: URLSearchParams, now = new Date()): CostRange | null {
  const d = defaultRange(now);
  const from = q.get("from") ?? d.from;
  const to = q.get("to") ?? d.to;
  if (!isDay(from) || !isDay(to) || from > to) return null;
  if ((Date.parse(to) - Date.parse(from)) / 86400_000 >= COSTS_MAX_DAYS) return null;
  return { from, to };
}

const int = (s: string | null, dflt: number, max: number) => {
  const n = Number(s ?? dflt);
  return Number.isInteger(n) && n >= 0 ? Math.min(n, max) : dflt;
};

export async function costsGet(
  req: Request,
  admin: boolean,
  db: D1Like | null,
  now = new Date(),
): Promise<Response> {
  if (!admin || !db) return notFound();
  const q = new URL(req.url).searchParams;
  const range = rangeOf(q, now);
  if (!range) return bad("bad-range");
  if (q.get("view") === "users") {
    const offset = int(q.get("offset"), 0, Number.MAX_SAFE_INTEGER);
    const limit = Math.max(1, int(q.get("limit"), 30, COSTS_MAX_LIMIT));
    const r = await costUsers(db, range, offset, limit);
    const next = offset + r.rows.length < r.total ? offset + r.rows.length : null;
    return Response.json({ range, ...r, next }, { headers: NO_STORE });
  }
  return Response.json(await costSummary(db, range), { headers: NO_STORE });
}
