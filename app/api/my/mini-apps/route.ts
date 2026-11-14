import { sameOriginJson } from "@/lib/security/same-origin";
import { json, listMine, publish } from "@/lib/mini-apps/handlers";
import { miniDeps } from "./deps";

export const dynamic = "force-dynamic";

/** docs/mini-apps.md: the account's apps; publish one (phase 1: `dev` only). */
export const GET = () => listMine(miniDeps);
export const POST = (req: Request) =>
  sameOriginJson(req) ? publish(req, miniDeps) : Promise.resolve(json({ error: "forbidden" }, 403));
