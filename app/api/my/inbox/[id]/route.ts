import { dbBackend } from "@/lib/d1";
import { inboxRoutes } from "@/lib/inbox/routes";
import { inboxDeps } from "../deps";
const routes = inboxRoutes(inboxDeps, dbBackend);
export const GET = routes.read;
export const DELETE = routes.DELETE;
