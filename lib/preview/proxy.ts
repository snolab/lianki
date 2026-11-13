import { boxAccessFromCookies } from "../box-oauth/server-session";
import { isPreview, previewTarget, type GatewayEnv } from "./gateway";

// Auth stays in Core. All other routes run locally unless explicitly listed as data routes.
const DATA_ROUTES = [
  "/api/preferences",
  "/api/profile",
  "/api/token",
  "/api/export",
  "/api/import/yaml",
];
const below = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`);
export function previewProxy(req: Request, env: GatewayEnv): Promise<Response> | null {
  if (!isPreview(env)) return null;
  const url = new URL(req.url);
  // Client supplied routing/tenant hints never pick a Core namespace.
  const { core, tenant } = previewTarget(env);
  if (!env.PREVIEW_ORIGIN || url.origin !== env.PREVIEW_ORIGIN)
    return Promise.resolve(new Response("Preview origin refused", { status: 403 }));
  const auth = below(url.pathname, "/api/auth");
  const local = (env.PREVIEW_LOCAL_ROUTES ?? "").split(",").filter(Boolean);
  if (
    !auth &&
    (local.some((prefix) => below(url.pathname, prefix)) ||
      !DATA_ROUTES.some((prefix) => below(url.pathname, prefix)))
  )
    return null;
  const forwarded = new Request(req);
  forwarded.headers.set("x-lianki-preview-tenant", tenant);
  return core.proxy(tenant, forwarded);
}

/** Preview is only a MyBox client: no passwords, better-auth sessions or anonymous APIs. */
export async function previewHandler(
  req: Request,
  env: GatewayEnv,
  next: (r: Request) => Promise<Response>,
): Promise<Response> {
  const url = new URL(req.url);
  if (
    !env.CORE_AUTH ||
    !env.LIANKI_BOX_CLIENT_ID ||
    !env.PREVIEW_ORIGIN ||
    url.origin !== env.PREVIEW_ORIGIN
  )
    return new Response("Preview authorization is not configured", { status: 403 });
  if (!url.pathname.startsWith("/api/")) return next(req);
  if (url.pathname.startsWith("/api/auth"))
    return new Response("Sign in at lianki.com through MyBox OAuth", { status: 403 });
  const token =
    req.headers.get("authorization") ??
    (boxAccessFromCookies(req.headers.get("cookie"))
      ? `Bearer ${boxAccessFromCookies(req.headers.get("cookie"))}`
      : "");
  const clean = new Request(req);
  clean.headers.delete("cookie");
  clean.headers.delete("x-lk-box-identity");
  clean.headers.delete("x-lianki-preview-tenant");
  clean.headers.set("authorization", token);
  // Never trust a caller's Origin or tenant. Cross-site browser writes are refused.
  const origin = req.headers.get("origin");
  if (origin && origin !== env.PREVIEW_ORIGIN)
    return new Response("Preview origin refused", { status: 403 });
  clean.headers.set("origin", env.PREVIEW_ORIGIN);
  let allowed: Response;
  try {
    allowed = await env.CORE_AUTH.authorize(clean.clone());
  } catch {
    return new Response("Preview authorization unavailable", { status: 503 });
  }
  if (!allowed.ok) return new Response("Preview access refused", { status: 403 });
  if (url.pathname === "/api/box/me") return allowed;
  const local = (env.PREVIEW_LOCAL_ROUTES ?? "").split(",").filter(Boolean);
  const production = (env.PREVIEW_PRODUCTION_ROUTES ?? "").split(",").filter(Boolean);
  if (
    !local.some((p) => below(url.pathname, p)) &&
    production.some((p) => below(url.pathname, p))
  ) {
    if (!env.CORE_AUTH.proxy)
      return new Response("Production data proxy unavailable", { status: 503 });
    // Production access is through existing account/scoped HTTP handlers only.
    // The SQL gateway never receives production DB capabilities.
    return env.CORE_AUTH.proxy(clean);
  }
  return previewProxy(clean, env) ?? next(clean);
}
