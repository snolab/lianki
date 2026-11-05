import { dbBackend } from "@/lib/d1";
import { confirmEmailChange } from "@/lib/profile/email-change";
import { emailDeps } from "@/lib/profile/deps";

/** The mailed link's confirmation: the token is the proof, no session needed. */
export const POST = (req: Request) =>
  dbBackend() === "d1"
    ? confirmEmailChange(req, emailDeps)
    : Response.json({ error: "Not found" }, { status: 404 });
