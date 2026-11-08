import { dbBackend } from "@/lib/d1";
import { isDev } from "@/lib/permissions";
import { link, list, upload } from "@/lib/inbox/handlers";
import { inboxDeps } from "./deps";

/**
 * The chat inbox (lib/inbox/; docs/dev-debug-widget.md, "Attachments and
 * the inbox"): POST uploads one file (raw body), GET lists the owner's files
 * and usage, PATCH links files to the chat line they were sent with.
 * Owner session only; 404 for anyone else, as every /api/dev route — each
 * handler's gate is the owner check in lib/inbox/handlers.ts, wrapping isDev().
 */
const off = () => Response.json({ error: "Not found" }, { status: 404 });
const owner = () => inboxDeps.who().then((w) => !!w && isDev(w.email) && dbBackend() === "d1");

export const POST = async (req: Request) => ((await owner()) ? upload(req, inboxDeps) : off());
export const GET = async () => ((await owner()) ? list(inboxDeps) : off());
export const PATCH = async (req: Request) => ((await owner()) ? link(req, inboxDeps) : off());
