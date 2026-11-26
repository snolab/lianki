import { manageSitePermissions } from "@/lib/site-permission-route";
import { sitePermissionDeps } from "@/lib/site-permission-deps.server";
export const dynamic = "force-dynamic";
export const POST = (req: Request) => manageSitePermissions(req, sitePermissionDeps());
