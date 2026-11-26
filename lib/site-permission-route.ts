import { publicSitePermissionResult } from "./site-permission-result";
/** First-party management and separate selected-page consumption; no reusable credential leaves main. */
import { sameOriginJsonPost } from "./security/same-origin";
import {
  signSiteAction,
  SITE_ACTION_PATH,
  SITE_ACTION_HEADER,
  siteReadAccountBinding,
} from "./site-permission-ticket";
import {
  readSitePermissionManagementInput,
  readSitePageReadRequest,
  type SitePermissionAction,
} from "./site-permission-wire";
export type SitePermissionRouteDeps = {
  user: () => Promise<{ id: string } | null>;
  key: () => Promise<CryptoKey | null>;
  push: () => { fetch(req: Request): Promise<Response> } | null;
  allow: (sub: string) => Promise<boolean>;
  chatOn: () => Promise<boolean>;
  now?: () => number;
};
const origins = new Set([
  "https://lianki.com",
  "https://www.lianki.com",
  "https://preview.lianki.com",
]);
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "private, no-store" } });
async function forward(sub: string, action: SitePermissionAction, deps: SitePermissionRouteDeps) {
  try {
    if (!(await deps.allow(sub))) return json({ ok: false, error: "busy" }, 429);
    const key = await deps.key(),
      push = deps.push();
    if (!key || !push) return json({ ok: false, error: "unavailable" }, 503);
    const ticket = await signSiteAction(key, sub, action, deps.now?.());
    const response = await push.fetch(
      new Request("https://lianki-push" + SITE_ACTION_PATH, {
        method: "POST",
        headers: { "content-type": "application/json", [SITE_ACTION_HEADER]: ticket },
        body: JSON.stringify(action),
      }),
    );
    if (!response.ok) return json({ ok: false, error: "unavailable" }, 503);
    const body = publicSitePermissionResult(await response.json());
    if (!body) return json({ ok: false, error: "unavailable" }, 503);
    // The authority never returns its signed capability, account identifier or arbitrary headers.
    return json(body);
  } catch {
    return json({ ok: false, error: "unavailable" }, 503);
  }
}
export async function manageSitePermissions(
  req: Request,
  deps: SitePermissionRouteDeps,
): Promise<Response> {
  if (
    !origins.has(new URL(req.url).origin) ||
    req.headers.has("authorization") ||
    !sameOriginJsonPost(req)
  )
    return json({ ok: false, error: "invalid" }, 403);
  const user = await deps.user();
  if (!user) return json({ ok: false, error: "signed-out" }, 401);
  const action = await readSitePermissionManagementInput(req);
  if (!action || action === "too-large") return json({ ok: false, error: "invalid" }, 400);
  return forward(user.id, action, deps);
}
export async function consumeSitePageRead(
  req: Request,
  deps: SitePermissionRouteDeps,
): Promise<Response> {
  if (
    req.method !== "POST" ||
    !origins.has(new URL(req.url).origin) ||
    req.headers.has("authorization") ||
    req.headers.get("x-lianki-userscript") !== "1"
  )
    return json({ ok: false, error: "invalid" }, 403);
  const user = await deps.user();
  if (!user) return json({ ok: false, error: "signed-out" }, 401);
  if (!(await deps.chatOn())) return json({ ok: false, error: "denied" }, 403);
  const action = await readSitePageReadRequest(req);
  if (!action || action === "too-large") return json({ ok: false, error: "invalid" }, 400);
  const identityKey = await deps.key();
  if (!identityKey) return json({ ok: false, error: "unavailable" }, 503);
  const accountBinding = await siteReadAccountBinding(identityKey, user.id, action.origin);
  if (action.op === "consume" && req.headers.get("x-lianki-site-account") !== accountBinding)
    return json({ ok: false, error: "denied" }, 409);
  const authorityAction: SitePermissionAction =
    action.op === "status" ? { op: "inspect", origin: action.origin } : action;
  // Origin here selects the grant, not proof of host-page identity. This initial scope
  // processes only caller-supplied selected text; no account/private data or execution is exposed.
  const response = await forward(user.id, authorityAction, deps);
  if (action.op !== "status" || !response.ok) return response;
  const body = publicSitePermissionResult(await response.json());
  return body?.ok && body.kind === "grant"
    ? json({ ...body, accountBinding })
    : json(body ?? { ok: false, error: "unavailable" });
}
