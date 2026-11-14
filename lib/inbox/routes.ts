import { sameOriginWrite } from "@/lib/security/same-origin";
import { upload, list, link, download, remove, type InboxDeps } from "./handlers";
export type InboxRouteContext = { params: Promise<{ id: string }> };
const fail = (error: string, status: number) =>
  Response.json({ error }, { status, headers: { "cache-control": "no-store" } });

/** Canonical handlers, also forwarded by the old /api/dev/inbox aliases. */
export function inboxRoutes(deps: InboxDeps, backend: () => string) {
  const write = (request: Request, run: () => Promise<Response>) =>
    backend() !== "d1"
      ? Promise.resolve(fail("unavailable", 503))
      : !sameOriginWrite(request)
        ? Promise.resolve(fail("forbidden", 403))
        : run();
  return {
    GET: () => (backend() === "d1" ? list(deps) : Promise.resolve(fail("unavailable", 503))),
    POST: (request: Request) => write(request, () => upload(request, deps)),
    PATCH: (request: Request) => write(request, () => link(request, deps)),
    read: async (request: Request, context: InboxRouteContext) =>
      backend() === "d1"
        ? download(request, (await context.params).id, deps)
        : fail("unavailable", 503),
    DELETE: (request: Request, context: InboxRouteContext) =>
      write(request, async () => remove((await context.params).id, deps)),
  };
}
