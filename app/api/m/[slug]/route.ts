import { serveApp } from "@/lib/mini-apps/handlers";
import { miniDeps } from "../../my/mini-apps/deps";

export const dynamic = "force-dynamic";

/** docs/mini-apps.md, "Isolation": the app's file on its own origin, by signed ticket only. */
export const GET = async (req: Request, ctx: { params: Promise<{ slug: string }> }) =>
  serveApp(req, (await ctx.params).slug, miniDeps);
