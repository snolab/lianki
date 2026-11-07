/**
 * Who a box is signed in as (docs/box-oauth.md, "The box's signed-in view"):
 * the bound account's display name, email and avatar, and nothing else. It
 * takes no parameter, so the only account it can name is the one the gate's
 * signed identity names; a request without that identity is a 404, so
 * lianki.com's own pages get nothing new from it.
 */
import { BOX_IDENTITY_HEADER } from "./identity";

export type BoxMe = { name: string; email: string; image: string | null };

type SessionUser = { name?: string | null; email?: string | null; image?: string | null };

const answer = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

export async function boxMeResponse(
  headers: Headers,
  session: (h: Headers) => Promise<{ user?: SessionUser | null } | null>,
): Promise<Response> {
  if (!headers.has(BOX_IDENTITY_HEADER)) return answer(404, { error: "Not found" });
  const user = (await session(headers))?.user;
  if (!user?.email) return answer(401, { error: "Not signed in" });
  const me: BoxMe = { name: user.name ?? "", email: user.email, image: user.image ?? null };
  return answer(200, { user: me });
}
