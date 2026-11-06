import { NextResponse } from "next/server";
import { authUserOrNull } from "@/app/signInEmail";
import { dbBackend, getD1 } from "@/lib/d1";
import { flagIn } from "@/lib/flags";
import { readFlags } from "@/lib/flags-store";
import {
  BOX_AUTHORIZE_PATH,
  BOX_FLAG,
  cleanAuthorizeQuery,
  redirectUriFor,
} from "@/lib/box-oauth/rules";
import { bindingByClient, type BoxDb } from "@/lib/box-oauth/store";
import { SIGN_IN_RETURN_PARAM } from "@/lib/dev-server-switch";

/**
 * lianki.com's entry to a box's sign-in (docs/box-oauth.md). Checks the box and
 * the account before the plugin sees anything, and refuses any account but the
 * one the owner bound to this box. 404 while the flag is off. Never in a frame.
 *
 * Not under /api, and it answers with a page rather than a redirect, on
 * purpose: a box is a sibling subdomain, so its navigation here is marked
 * `Sec-Fetch-Site: same-site` and the sibling guard refuses that on /api, all
 * along a redirect chain. The refresh below is lianki.com's own navigation, and
 * the plugin's route takes nothing else (isFirstPartyNavigation).
 */
export const dynamic = "force-dynamic";

const HEADERS = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
};
const notFound = () => new NextResponse(null, { status: 404, headers: HEADERS });
const refused = (text: string) =>
  new NextResponse(text, {
    status: 403,
    headers: { ...HEADERS, "content-type": "text/plain; charset=utf-8" },
  });

const attr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

export const GET = async (req: Request) => {
  if (dbBackend() !== "d1") return notFound();
  if (!flagIn(await readFlags(), BOX_FLAG)) return notFound();
  const url = new URL(req.url);
  const query = cleanAuthorizeQuery(url.searchParams);
  if (!query) return notFound();
  const box = await bindingByClient(getD1() as unknown as BoxDb, query.get("client_id") as string);
  // Exact match, or nothing is sent anywhere.
  if (!box || query.get("redirect_uri") !== redirectUriFor(box.origin)) return notFound();

  const user = await authUserOrNull();
  if (!user) {
    const back = `${BOX_AUTHORIZE_PATH}?${query}`;
    return new NextResponse(null, {
      status: 302,
      headers: {
        ...HEADERS,
        location: `/sign-in?${new URLSearchParams({ [SIGN_IN_RETURN_PARAM]: back })}`,
      },
    });
  }
  if (user.id !== box.userId)
    return refused(
      "This box belongs to another Lianki account. Sign in to lianki.com with that account.",
    );
  const to = attr(`/api/auth/oauth2/authorize?${query}`);
  return new NextResponse(
    `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${to}"><title>Lianki</title>`,
    { status: 200, headers: { ...HEADERS, "content-type": "text/html; charset=utf-8" } },
  );
};
