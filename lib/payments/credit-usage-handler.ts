/**
 * GET /api/payments/credits/usage's logic (the route wires the session and
 * D1): the signed-in user's own ledger lines only — the user id comes from
 * the session, never from the query.
 */
import type { D1Like } from "@/lib/d1/types";
import { getBalance } from "./credits-store";
import { safeZone, localDay, toCsv, usagePage, usageRows } from "./credit-usage";

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

export async function creditUsage(
  req: Request,
  deps: { userId: string | null; d1: D1Like | null; now?: () => Date },
): Promise<Response> {
  if (!deps.d1) return json({ error: "Unavailable" }, 503);
  if (!deps.userId) return json({ error: "Unauthorized" }, 401);
  const now = deps.now?.() ?? new Date();
  const q = new URL(req.url).searchParams;
  const [rows, balance] = await Promise.all([
    usageRows(deps.d1, deps.userId),
    getBalance(deps.d1, deps.userId),
  ]);
  if (q.get("format") === "csv") {
    // The export is every line that matches the filters, oldest first.
    const page = usagePage(rows, balance, q, now, { all: true });
    const tz = safeZone(q.get("tz"));
    return new Response(toCsv([...page.entries].reverse(), tz), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="lianki-credits-${localDay(now, tz)}.csv"`,
        "cache-control": "no-store",
      },
    });
  }
  return json(usagePage(rows, balance, q, now));
}
