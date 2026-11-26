import { dbBackend, getD1 } from "@/lib/d1";
import type { D1Like } from "@/lib/d1/types";
import { checkToken, cleanTokenName, renameSelfToken, tagOf } from "@/lib/api-tokens";
import { audit, type AuditDb } from "@/lib/security/audit-log";

export const dynamic = "force-dynamic";

/**
 * Authenticated name-only bootstrap call for an agent identity (`identity:self`).
 * Explicitly exempt from the name-before-use gate (`allowUntitled: true`) so an
 * untitled identity can name itself on first connect before making any other call.
 */
export async function POST(req: Request) {
  if (dbBackend() !== "d1") return Response.json({ error: "not-available" }, { status: 503 });
  const auth = req.headers.get("authorization") ?? "";
  const m = auth.match(/^Bearer\s+(lk_[0-9a-f]{64})$/i);
  if (!m) return Response.json({ error: "unauthorized" }, { status: 401 });
  const db = getD1() as unknown as D1Like & AuditDb;
  const checked = await checkToken(db, m[1], "identity:self", Date.now(), { allowUntitled: true });
  if (!checked.ok) {
    return Response.json(
      { error: checked.reason, ...(checked.requestUrl ? { requestUrl: checked.requestUrl } : {}) },
      { status: checked.reason === "scope" ? 403 : 401 },
    );
  }
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const name = cleanTokenName(body?.name);
  if (!name) return Response.json({ error: "invalid-name" }, { status: 400 });
  await renameSelfToken(db, checked.id, name);
  await audit(db, {
    kind: "api-token.self-name",
    actor: checked.user.id,
    subject: tagOf(checked.id),
    detail: name,
  });
  return Response.json({ ok: true, id: checked.id, name });
}
