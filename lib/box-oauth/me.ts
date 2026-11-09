/**
 * Who a box is signed in as (docs/box-oauth.md, "The box's signed-in view"):
 * the bound account's id, display name, email and avatar and, so the box's pages
 * decide as lianki.com would ("Flags on a box"), production's feature flags
 * and which permissions that account holds (isAdmin, isDev). Nothing else. It takes no
 * parameter, so the only account it can name is the one the gate's signed
 * identity names; a request without that identity is a 404, so lianki.com's
 * own pages get nothing new from it.
 */
import type { FlagValues } from "@/lib/flags";
import { BOX_IDENTITY_HEADER } from "./identity";

export type BoxMe = { name: string; email: string; image: string | null };

/**
 * Production's view for the bound account: every flag and its permissions.
 * `owner` is `isDev` under the name the box's pages read (session.ts).
 */
export type BoxView = { flags: FlagValues; owner: boolean; isAdmin: boolean; isDev: boolean };

type SessionUser = {
  id?: string | null;
  name?: string | null;
  email?: string | null;
  image?: string | null;
};

const answer = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

export async function boxMeResponse(
  headers: Headers,
  session: (h: Headers) => Promise<{ user?: SessionUser | null } | null>,
  /** Production's flags and permissions for this account; absent, the answer has neither. */
  view?: (email: string) => Promise<BoxView>,
): Promise<Response> {
  if (!headers.has(BOX_IDENTITY_HEADER)) return answer(404, { error: "Not found" });
  const user = (await session(headers))?.user;
  if (!user?.email) return answer(401, { error: "Not signed in" });
  const me: BoxMe = { name: user.name ?? "", email: user.email, image: user.image ?? null };
  // The account's id too: the box's own server keys its session by it
  // (server-session.ts). The box is that account's already; nothing new.
  const body = { user: user.id ? { ...me, id: user.id } : me };
  return answer(200, view ? { ...body, ...(await view(user.email)) } : body);
}
