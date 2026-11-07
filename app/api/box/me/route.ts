import { auth } from "@/auth";
import { boxMeResponse } from "@/lib/box-oauth/me";

export const dynamic = "force-dynamic";

/** A box token's account: name, email, avatar (lib/box-oauth/me.ts, docs/box-oauth.md). */
export const GET = (req: Request) =>
  boxMeResponse(req.headers, (headers) => auth.api.getSession({ headers }));
