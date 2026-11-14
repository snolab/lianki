import { dbBackend } from "@/lib/d1";
import { inboxRoutes } from "@/lib/inbox/routes";
import { inboxDeps } from "./deps";
const routes = inboxRoutes(inboxDeps, dbBackend);
export const GET = routes.GET;
export const POST = routes.POST;
export const PATCH = routes.PATCH;
