import { checkToken } from "@/lib/api-tokens";
import { getD1 } from "@/lib/d1";
import { publishRequest } from "@/lib/mini-apps/publish-auth";
import { listMine } from "@/lib/mini-apps/handlers";
import { miniDeps } from "./deps";

export const dynamic = "force-dynamic";

/** docs/mini-apps.md: the account's apps; publish with a dev session or apps:publish + chat:write token. */
export const GET = () => listMine(miniDeps);
export const POST = (req: Request) =>
  publishRequest(req, miniDeps, (token) => checkToken(getD1(), token, "apps:publish"));
