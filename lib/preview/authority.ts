import { boxGate, type BoxEnv, type GateDeps } from "../box-oauth/gate";

/** A Service Binding is a transport, not a user grant. Always run the MyBox gate. */
export function previewAuthority(
  req: Request,
  env: BoxEnv,
  deps: GateDeps,
  next: (verified: Request) => Promise<Response>,
): Promise<Response> {
  if (!/^Bearer lkb_[A-Za-z0-9_-]{16,256}$/.test(req.headers.get("authorization") ?? ""))
    return Promise.resolve(new Response("Preview authorization required", { status: 403 }));
  return boxGate(req, env, deps, next);
}
