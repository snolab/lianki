import type { D1Like } from "@/lib/d1/types";
import { checkToken, cleanTokenName, renameSelfToken, tagOf } from "@/lib/api-tokens";
import { audit, type AuditDb } from "@/lib/security/audit-log";

export type IdentityApiDeps = {
  db: () => D1Like & AuditDb;
  /** True only when `chat.agent-identities` is on AND the user is in the owner audience. */
  allowed: (userId: string) => Promise<boolean>;
  now?: () => number;
};

const NO_STORE = { "cache-control": "no-store" };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: NO_STORE });

/**
 * Self-identity endpoints (`GET` whoami, `POST` set-name) for an agent token
 * holding `identity:self`. Explicitly exempt from the name-before-use gate
 * (`allowUntitled: true`) so an untitled identity can inspect and name itself
 * on first connect, while still gated on `chat.agent-identities` + owner audience.
 */
export async function identityApi(req: Request, deps: IdentityApiDeps): Promise<Response> {
  if (req.method !== "GET" && req.method !== "POST")
    return json({ error: "method-not-allowed" }, 405);
  const auth = req.headers.get("authorization") ?? "";
  const m = auth.match(/^Bearer\s+(lk_[0-9a-f]{64})$/i);
  if (!m) return json({ error: "unauthorized" }, 401);
  const now = (deps.now ?? Date.now)();
  const db = deps.db();
  const checked = await checkToken(db, m[1], "identity:self", now, { allowUntitled: true });
  if (!checked.ok) {
    return json(
      { error: checked.reason, ...(checked.requestUrl ? { requestUrl: checked.requestUrl } : {}) },
      checked.reason === "scope" ? 403 : 401,
    );
  }
  if (!(await deps.allowed(checked.user.id))) return json({ error: "forbidden" }, 403);

  if (req.method === "GET") {
    return json({
      id: checked.id,
      name: checked.name,
      untitled: !checked.name,
      scopes: checked.scopes,
      account: checked.user.email,
    });
  }

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const name = cleanTokenName(body?.name);
  if (!name) return json({ error: "invalid-name" }, 400);
  await renameSelfToken(db, checked.id, name);
  await audit(
    db,
    {
      kind: "api-token.self-name",
      actor: checked.user.id,
      subject: tagOf(checked.id),
      detail: name,
    },
    now,
  );
  return json({ ok: true, id: checked.id, name });
}
