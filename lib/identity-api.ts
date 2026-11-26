import type { D1Like } from "@/lib/d1/types";
import { checkToken, cleanTokenName, renameSelfToken, tagOf } from "@/lib/api-tokens";
import { defaultConfig } from "@/lib/config";
import { loadConfig } from "@/lib/config-store";
import { audit, type AuditDb } from "@/lib/security/audit-log";
import { hit, type ThrottleDb } from "@/lib/security/throttle";

export type IdentityApiDeps = {
  db: () => D1Like & AuditDb;
  /** True only when `chat.agent-identities` is on AND the user is in the owner audience. */
  allowed: (userId: string) => Promise<boolean>;
  now?: () => number;
};

const MIN = 60_000;
const NO_STORE = { "cache-control": "no-store" };
const json = (body: unknown, status = 200, extra?: Record<string, string>) =>
  Response.json(body, { status, headers: { ...NO_STORE, ...extra } });

/**
 * Self-identity endpoints (`GET` whoami, `POST` set-name) for an agent token
 * holding `identity:self`. Explicitly exempt from the name-before-use gate
 * (`allowUntitled: true`) so an untitled identity can inspect and name itself
 * on first connect, while gated on `chat.agent-identities` + owner audience,
 * rate-limited via `chat.identityBootstrapCalls`, and atomically one-shot on `POST`.
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

  const config = await loadConfig(db).catch(defaultConfig);
  const limit = await hit(
    db as unknown as ThrottleDb,
    `identity-bootstrap:${tagOf(checked.id)}`,
    { max: config["chat.identityBootstrapCalls"], windowMs: 10 * MIN },
    now,
  );
  if (!limit.allowed) {
    return json({ error: "rate-limited" }, 429, {
      "Retry-After": String(Math.max(1, Math.ceil(limit.retryAfterMs / 1000))),
    });
  }

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
  const claimed = await renameSelfToken(db, checked.id, name);
  if (!claimed) return json({ error: "already-named" }, 409);
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
