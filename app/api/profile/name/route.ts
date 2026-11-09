import { postName } from "@/lib/profile/handlers";
import { profileDeps } from "@/lib/profile/deps";
import { dbBackend } from "@/lib/d1";

/** Change your own display name (lib/profile/handlers.ts). Its rate limit lives in D1. */
export const POST = (req: Request) =>
  dbBackend() === "d1"
    ? postName(req, profileDeps)
    : Response.json({ error: "Not found" }, { status: 404 });
