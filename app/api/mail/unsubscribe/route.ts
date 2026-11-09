import type { D1Like } from "@/lib/d1/types";
import { dbBackend, getD1 } from "@/lib/d1";
import type { ThrottleDb } from "@/lib/security/throttle";
import { unsubscribeGet, unsubscribePost } from "@/lib/mail-templates/unsubscribe";

const origin = () => process.env.BETTER_AUTH_BASE_URL ?? "https://lianki.com";

/** One-click unsubscribe from an optional mail kind (lib/mail-templates/unsubscribe.ts). No sign-in. */
export const POST = (req: Request) =>
  unsubscribePost(req, {
    db: () => (dbBackend() === "d1" ? (getD1() as unknown as D1Like & ThrottleDb) : null),
    secret: () => process.env.AUTH_SECRET,
    origin,
  });

/** A GET changes nothing: it opens the unsubscribe page. */
export const GET = (req: Request) => unsubscribeGet(req, origin());
