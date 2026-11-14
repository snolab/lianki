/** Publication is the only mini-app endpoint accepting an API token. It never grants dev. */
import { type CheckResult, tokenScopeRequest } from "../api-tokens";
import { sameOriginJson } from "../security/same-origin";
import { json, publish, type MiniDeps } from "./handlers";

/** Cookie writes retain CSRF protection; explicit bearer clients may omit browser Origin headers. */
function tokenJson(req: Request): boolean {
  if (req.headers.get("origin") !== null) return sameOriginJson(req);
  return (
    req.headers.get("sec-fetch-site") === null &&
    req.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() === "application/json"
  );
}

export async function publishRequest(
  req: Request,
  session: MiniDeps,
  verify: (token: string) => Promise<CheckResult>,
): Promise<Response> {
  const authorization = req.headers.get("authorization");
  if (authorization === null)
    return sameOriginJson(req) ? publish(req, session) : json({ error: "forbidden" }, 403);
  if (!(await session.on())) return json({ error: "not-found" }, 404);
  if (!tokenJson(req)) return json({ error: "forbidden" }, 403);
  const token = /^Bearer (\S+)$/i.exec(authorization)?.[1];
  if (!token) return json({ error: "malformed" }, 401);
  // verify asks for apps:publish against the live token/account; no ambient browser identity is read.
  const checked = await verify(token);
  if (!checked.ok)
    return json(
      {
        error: checked.reason,
        ...(checked.needScope
          ? { needScope: checked.needScope, requestUrl: checked.requestUrl }
          : {}),
      },
      checked.reason === "scope" ? 403 : 401,
    );
  if (!checked.scopes.includes("chat:write"))
    return json({ error: "scope", ...tokenScopeRequest(checked.id, "chat:write")! }, 403);
  return publish(req, {
    ...session,
    who: async () => ({
      id: checked.user.id,
      email: checked.user.email,
      dev: false,
      canPublish: true,
    }),
  });
}
