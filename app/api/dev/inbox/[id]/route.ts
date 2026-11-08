import { dbBackend } from "@/lib/d1";
import { isDev } from "@/lib/permissions";
import { TICKET_HEADER, download, remove } from "@/lib/inbox/handlers";
import { inboxDeps } from "../deps";

/**
 * One inbox file: GET serves it (the owner's session, or an agent's
 * single-use 60 s ticket in the x-inbox-ticket header — lib/inbox/agent.ts),
 * inline only for a safe image type, else as an attachment. DELETE removes it
 * for good: the owner's own session only. 404 for anyone else.
 */
type Ctx = { params: Promise<{ id: string }> };
const off = () => Response.json({ error: "Not found" }, { status: 404 });
const owner = () => inboxDeps.who().then((w) => !!w && isDev(w.email));

export const GET = async (req: Request, ctx: Ctx) => {
  if (dbBackend() !== "d1") return off();
  // A ticket is checked against D1 in download(); without one, only the owner.
  if (!req.headers.get(TICKET_HEADER) && !(await owner())) return off();
  return download(req, (await ctx.params).id, inboxDeps);
};

export const DELETE = async (_req: Request, ctx: Ctx) =>
  dbBackend() === "d1" && (await owner()) ? remove((await ctx.params).id, inboxDeps) : off();
