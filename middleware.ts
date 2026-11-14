import { intlayerMiddleware } from "next-intlayer/middleware";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { isSupportedLocale } from "@/lib/constants";
import { BOX_PATH_HEADER } from "@/lib/box-oauth/return-path";
import {
  DEFAULT_LOCALE,
  LOCALE_HEADER,
  LOCALE_PARAM,
  PARTNER_FRAME_HEADER,
  isAppRoute,
  isPartnerFramePath,
  localeRoot,
} from "@/lib/app-locale";
import { movedPath } from "@/lib/moved-routes";
import { LOCALE_SRC_COOKIE, LOCALE_SRC_HEADER, requestLocale } from "@/lib/account-locale";

const YEAR_S = 365 * 24 * 60 * 60;
/** intlayer's locale header, which the root layout reads (app/layout.tsx, getRootLocale). */
const INTLAYER_LOCALE_HEADER = "x-intlayer-locale";

/**
 * ?lang= → `lang` cookie → Accept-Language. A signed-in account's language is
 * put first later, on the server (lib/account-locale.ts): no session here.
 */
function appRouteLocale(request: NextRequest) {
  return requestLocale(
    request.nextUrl.searchParams.get(LOCALE_PARAM),
    request.cookies.get(LOCALE_PARAM)?.value,
    request.headers.get("accept-language"),
  );
}

/** `/agent-guide.md` or `/agent-guide.<lang>.md` → the guide's language (base tag, lower case), or null. */
export function agentGuideFile(pathname: string): { lang: string | null } | null {
  const m = /^\/agent-guide(?:\.([A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?))?\.md$/.exec(pathname);
  if (!m) return null;
  return { lang: m[1] ? m[1].split("-")[0]!.toLowerCase() : null };
}

export function middleware(request: NextRequest) {
  const { pathname, searchParams } = request.nextUrl;
  const host = request.headers.get("host");

  // Redirect www.lianki.com → lianki.com (canonical domain)
  if (host === "www.lianki.com") {
    const canonicalUrl = new URL(request.url);
    canonicalUrl.host = "lianki.com";
    return NextResponse.redirect(canonicalUrl, 308);
  }

  // The AI-assistant guide as a public file (docs/api-for-agents.md):
  // /agent-guide.md (Accept-Language) and /agent-guide.<lang>.md, e.g.
  // agent-guide.zh-CN.md → ?lang=zh. The query (?scopes=…) is kept.
  const guide = agentGuideFile(pathname);
  if (guide) {
    const to = new URL("/api/agent-guide", request.url);
    for (const [k, v] of searchParams) to.searchParams.set(k, v);
    if (guide.lang) to.searchParams.set("lang", guide.lang);
    return NextResponse.rewrite(to);
  }

  // Redirect legacy /cn/* → /zh/*
  if (pathname === "/cn" || pathname.startsWith("/cn/")) {
    return NextResponse.redirect(new URL(pathname.replace(/^\/cn/, "/zh"), request.url));
  }

  const [, maybeLocale, ...rest] = pathname.split("/");
  const restPath = `/${rest.join("/")}`;

  // Moved pages (lib/moved-routes.ts): one permanent hop to the new address,
  // subpath and query kept — also from a legacy locale prefix (/ja/polyglot).
  const prefixed = isSupportedLocale(maybeLocale) && rest.length > 0;
  const moved = movedPath(prefixed ? restPath : pathname);
  if (moved) {
    const target = new URL(moved, request.url);
    target.search = searchParams.toString();
    if (prefixed && maybeLocale !== DEFAULT_LOCALE && !target.searchParams.has(LOCALE_PARAM)) {
      target.searchParams.set(LOCALE_PARAM, maybeLocale);
    }
    return NextResponse.redirect(target, 308);
  }

  // Legacy prefixed app routes: /ja/list → /list?lang=ja
  if (isSupportedLocale(maybeLocale) && rest.length > 0 && isAppRoute(restPath)) {
    const target = new URL(restPath, request.url);
    target.search = searchParams.toString();
    if (maybeLocale !== DEFAULT_LOCALE) target.searchParams.set(LOCALE_PARAM, maybeLocale);
    return NextResponse.redirect(target, 301);
  }

  if (pathname === "/next") {
    return NextResponse.next();
  }

  // App routes carry the locale in ?lang=. Resolve it here and pass it down as a
  // request header, because layouts cannot read searchParams.
  if (isAppRoute(pathname)) {
    const { locale, source } = appRouteLocale(request);
    const headers = new Headers(request.headers);
    headers.set(LOCALE_HEADER, locale);
    // Decided here; a request can never claim a source itself.
    headers.set(LOCALE_SRC_HEADER, source);
    // Decided here from the path alone; a request can never set or clear it itself.
    headers.delete(PARTNER_FRAME_HEADER);
    if (isPartnerFramePath(pathname)) headers.set(PARTNER_FRAME_HEADER, "1");
    // The page to come back to after a box's /sign-in (lib/box-oauth/return-path.ts).
    headers.delete(BOX_PATH_HEADER);
    if (process.env.LIANKI_BOX_CLIENT_ID)
      headers.set(BOX_PATH_HEADER, `${pathname}${request.nextUrl.search}`);

    const response = NextResponse.next({ request: { headers } });
    // An explicit ?lang= (a language switch, or a shared link) sticks, so the
    // app's own links can stay bare.
    // It is a pick by hand for this browser session: the account's language
    // never overrides it (lib/account-locale.ts, the `pick` marker).
    if (source === "param") {
      response.cookies.set(LOCALE_PARAM, locale, { path: "/", sameSite: "lax", maxAge: YEAR_S });
      response.cookies.set(LOCALE_SRC_COOKIE, "pick", { path: "/", sameSite: "lax" });
    }
    return response;
  }

  // A bare locale root ("/zh"): served as is, with the locale intlayer would
  // pass down. Its own middleware rewrites it to "/zh/", which next dev
  // redirects back to "/zh" (308): a redirect loop (lib/app-locale.ts, localeRoot).
  const root = localeRoot(pathname);
  if (root) {
    const headers = new Headers(request.headers);
    headers.set(INTLAYER_LOCALE_HEADER, root);
    const response = NextResponse.next({ request: { headers } });
    response.headers.set(INTLAYER_LOCALE_HEADER, root);
    if (!request.cookies.has(LOCALE_PARAM)) {
      response.cookies.set(LOCALE_PARAM, root, { path: "/", sameSite: "lax", maxAge: YEAR_S });
    }
    return response;
  }

  // Landing page and blog keep their /{locale}/ prefix. A first visit there
  // also seeds the app's locale, so a bare /words link from /ja stays Japanese.
  const response = intlayerMiddleware(request);
  if (isSupportedLocale(maybeLocale) && !request.cookies.has(LOCALE_PARAM)) {
    response.cookies.set(LOCALE_PARAM, maybeLocale, { path: "/", sameSite: "lax", maxAge: YEAR_S });
  }
  return response;
}

export const config = {
  matcher: [
    "/((?!api|_next/static|_next/image|favicon.ico|sw\\.js|manifest\\.json|.*\\.user\\.js|.*\\.meta\\.js|.*\\.wasm|.*\\.svg|.*\\.png|.*\\.webp|proto/|sqlite3).*)",
  ],
};
