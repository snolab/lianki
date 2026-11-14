import { sameOriginJson, sameOriginWrite } from "@/lib/security/same-origin";
import { act, appInfo, json, removeApp } from "@/lib/mini-apps/handlers";
import { miniDeps } from "../deps";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ slug: string }> };
const forbidden = () => Promise.resolve(json({ error: "forbidden" }, 403));

/** docs/mini-apps.md: one app — its grants, a prompt's answer, a capability call, delete. */
export const GET = async (_req: Request, ctx: Ctx) => appInfo((await ctx.params).slug, miniDeps);
export const POST = async (req: Request, ctx: Ctx) =>
  sameOriginJson(req) ? act(req, (await ctx.params).slug, miniDeps) : forbidden();
export const DELETE = async (req: Request, ctx: Ctx) =>
  sameOriginWrite(req) ? removeApp((await ctx.params).slug, miniDeps) : forbidden();
