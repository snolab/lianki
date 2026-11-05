import { dbBackend } from "@/lib/d1";
import { requestEmailChange } from "@/lib/profile/email-change";
import { emailDeps } from "@/lib/profile/deps";

/** Ask to change your own sign-in address (lib/profile/email-change.ts). */
export const POST = (req: Request) =>
  dbBackend() === "d1"
    ? requestEmailChange(req, emailDeps)
    : Response.json({ error: "Not found" }, { status: 404 });
