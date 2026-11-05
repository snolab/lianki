import { NextResponse } from "next/server";
import { previewFor, revokePreview } from "@/lib/live-view/custom";
import { customDb, customViewer } from "@/lib/live-view/custom-route";
import { sameOriginJson } from "@/lib/security/same-origin";

/**
 * One custom-frontend preview (docs/custom-frontend.md).
 *
 * - GET → its target and expiry, to its registrant only (404 for anyone
 *   else, the owner included, and once expired or revoked). The main Worker
 *   asks this, with the viewer's Cookie only, before it serves a
 *   `?live=<id>` document (lib/live-view/page-proxy.ts).
 * - DELETE (same-origin JSON) → revokes it: the registrant's own, or any for
 *   the owner. Audited.
 */
type Ctx = { params: Promise<{ id: string }> };
const NO_STORE = { "cache-control": "no-store" };
const notFound = () =>
  NextResponse.json({ error: "Not found" }, { status: 404, headers: NO_STORE });

export const GET = async (_req: Request, { params }: Ctx) => {
  const v = await customViewer();
  if (!v) return notFound();
  const p = await previewFor(customDb(), (await params).id, v);
  if (!p) return notFound();
  return NextResponse.json(
    { id: p.id, target: p.target, expiresAt: p.expiresAt, userId: p.userId, owner: v.owner },
    { headers: NO_STORE },
  );
};

export const DELETE = async (req: Request, { params }: Ctx) => {
  const v = await customViewer();
  if (!v) return notFound();
  if (!sameOriginJson(req))
    return NextResponse.json(
      { error: "Same-origin JSON only" },
      { status: 403, headers: NO_STORE },
    );
  const ok = await revokePreview(customDb(), (await params).id, v);
  return ok ? NextResponse.json({ revoked: true }, { headers: NO_STORE }) : notFound();
};
