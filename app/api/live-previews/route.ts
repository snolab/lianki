import { NextResponse } from "next/server";
import { getD1 } from "@/lib/d1";
import {
  CUSTOM_CAP,
  CUSTOM_CREATES_PER_HOUR,
  createPreview,
  customHours,
  customTarget,
  listPreviews,
} from "@/lib/live-view/custom";
import { customDb, customViewer } from "@/lib/live-view/custom-route";
import { sameOriginJsonPost } from "@/lib/security/same-origin";
import { hit, type ThrottleDb } from "@/lib/security/throttle";

/**
 * Custom frontends (docs/custom-frontend.md, lib/live-view/custom.ts): the
 * signed-in user's own previews. Behind `my-box` (the owner
 * sees it while off); 404 for a guest, or with the flag off.
 *
 * - GET → the caller's active previews, each with its `url`;
 * - POST `{ target, hours? }` (same-origin JSON only) → registers one:
 *   target `https://<label>.trycloudflare.com`, hours ≤ 8 (default 8). 403
 *   off the allowlist (/dev/live-frontends), 409 at the cap (3 active),
 *   429 over 20 an hour. Audited.
 */
const NO_STORE = { "cache-control": "no-store" };
const notFound = () =>
  NextResponse.json({ error: "Not found" }, { status: 404, headers: NO_STORE });
const err = (status: number, error: string, extra: Record<string, string> = {}) =>
  NextResponse.json({ error }, { status, headers: { ...NO_STORE, ...extra } });

const HOUR = 3_600_000;
const view = (req: Request, p: { id: string; target: string; expiresAt: number }) => ({
  id: p.id,
  target: p.target,
  expiresAt: new Date(p.expiresAt).toISOString(),
  url: `${new URL(req.url).origin}/?live=${p.id}`,
});

export const GET = async (req: Request) => {
  const v = await customViewer();
  if (!v) return notFound();
  const list = await listPreviews(customDb(), v.userId);
  return NextResponse.json(
    { previews: list.map((p) => view(req, p)), cap: CUSTOM_CAP },
    { headers: NO_STORE },
  );
};

export const POST = async (req: Request) => {
  const v = await customViewer();
  if (!v) return notFound();
  if (!sameOriginJsonPost(req)) return err(403, "Same-origin JSON only");
  const body = (await req.json().catch(() => null)) as { target?: unknown; hours?: unknown } | null;
  const target = customTarget(body?.target);
  if (!target)
    return err(400, "target must be https://<name>.trycloudflare.com (no port, path or query)");
  const hours = customHours(body?.hours);
  if (hours === null) return err(400, "hours must be a number above 0, at most 8");
  const limit = await hit(getD1() as unknown as ThrottleDb, `live-preview:${v.userId}`, {
    max: CUSTOM_CREATES_PER_HOUR,
    windowMs: HOUR,
  });
  if (!limit.allowed)
    return err(429, "Too many registrations; try later", {
      "retry-after": String(Math.ceil(limit.retryAfterMs / 1000)),
    });
  const r = await createPreview(customDb(), { userId: v.userId, target, hours, owner: v.owner });
  if (!r.ok)
    return r.error === "cap"
      ? err(409, `At most ${CUSTOM_CAP} active previews; stop one first`)
      : err(403, "Not on the custom-frontend list");
  return NextResponse.json(view(req, r.preview), { status: 201, headers: NO_STORE });
};
