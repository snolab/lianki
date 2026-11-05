/**
 * Shared plumbing for the node-tree and plan routes (app/api/tree, app/api/plan).
 * D1 only: on the Mongo backend (a frozen rollback copy) they answer 503.
 */
import { NextResponse } from "next/server";
import { authUserOrNull } from "@/app/signInEmail";
import { dbBackend, getD1 } from "@/lib/d1";
import type { D1Like } from "@/lib/d1/types";
import { PreferencesD1Repo } from "@/lib/repos/d1Repos";
import { NodesD1Repo, TreeError } from "@/lib/repos/nodesD1";
import { summarizeError } from "@/lib/safeError";
import { resolveTimeZone, type ResolvedZone } from "@/lib/tree/tz";

export type TreeCtx = {
  user: { id: string; email: string };
  db: D1Like;
  zone: ResolvedZone;
  nodes: NodesD1Repo;
};

/**
 * Signed-in user, D1, their zone and a repo — or the response to send instead.
 * `browserTz` (a `tz` query parameter) wins over the stored zone; neither → UTC.
 */
export async function treeContext(browserTz?: string | null): Promise<TreeCtx | NextResponse> {
  if (dbBackend() !== "d1")
    return NextResponse.json({ error: "Not available on this backend" }, { status: 503 });
  const user = await authUserOrNull();
  if (!user) return NextResponse.json({ error: "Login required" }, { status: 401 });
  const db = getD1();
  const stored = await new PreferencesD1Repo(db, user.id).timeZone();
  const zone = resolveTimeZone(browserTz, stored);
  return { user, db, zone, nodes: new NodesD1Repo(db, user.id, zone.tz) };
}

/** A TreeError as its status; anything else as a logged 500 (no titles or fields logged). */
export function treeErrorResponse(e: unknown, where: string): NextResponse {
  if (e instanceof TreeError) return NextResponse.json({ error: e.message }, { status: e.status });
  console.error(JSON.stringify({ event: `${where}.failed`, error: summarizeError(e) }));
  return NextResponse.json({ error: "Internal error" }, { status: 500 });
}

/** `depth` query parameter: an integer ≥ -1 (-1 = all), default `fallback`, capped at 32. */
export function depthParam(raw: string | null, fallback: number): number {
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < -1) return fallback;
  return n === -1 ? -1 : Math.min(32, n);
}
