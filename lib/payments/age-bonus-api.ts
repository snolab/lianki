/**
 * POST /api/dev/credits/age-bonus — the account-age bonus backfill
 * (docs/payments.md, "Account-age bonus"). Admin only; anyone else, and any
 * backend but D1, gets a plain 404.
 *
 * - `{ action: "preview" }` → `{ usersD1, usersD7, users, credits }`; writes nothing.
 * - `{ action: "apply" }` → the same counts for what this run granted, plus
 *   `failed`. Idempotent: a second Apply grants nothing.
 *
 * Kept apart from the route file (which may export only HTTP handlers) so the
 * gate and both actions are unit-tested with injected parts.
 */
import { applyAgeBonus, previewAgeBonus } from "./age-bonus-store";
import type { AgeBonusConfig } from "./age-bonus";
import type { D1WithBatch } from "./credits-store";

export interface AgeBonusDeps {
  /** The signed-in admin's email, or null for anyone else. */
  admin: () => Promise<string | null>;
  /** The D1 handle, or null when the backend is not D1. */
  db: () => D1WithBatch | null;
  conf?: AgeBonusConfig;
  now?: () => Date;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export async function handleAgeBonus(req: Request, deps: AgeBonusDeps): Promise<Response> {
  const by = await deps.admin();
  const d1 = by ? deps.db() : null;
  if (!by || !d1) return new Response(null, { status: 404 });
  const body = (await req.json().catch(() => null)) as { action?: unknown } | null;
  const now = deps.now?.() ?? new Date();
  if (body?.action === "preview") return json(await previewAgeBonus(d1, now, deps.conf));
  if (body?.action === "apply") {
    const r = await applyAgeBonus(d1, now, deps.conf);
    console.log(JSON.stringify({ event: "credits.ageBonus.apply", by, result: r }));
    return json(r);
  }
  return json({ error: "action must be preview or apply" }, 400);
}
