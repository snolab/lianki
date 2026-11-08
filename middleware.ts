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
  localeFromAcceptLanguage,
  localeRoot,
} from "@/lib/app-locale";

const YEAR_S = 365 * 24 * 60 * 60;
/** intlayer's locale header, which the root layout reads (app/layout.tsx, getRootLocale). */
const INTLAYER_LOCALE_HEADER = "x-intlayer-locale";

function appRouteLocale(request: NextRequest): string {
  const requested = request.nextUrl.searchParams.get(LOCALE_PARAM);
  if (requested && isSupportedLocale(requested)) return requested;

  const cookie = request.cookies.get(LOCALE_PARAM)?.value;
  if (cookie && isSupportedLocale(cookie)) return cookie;

  return localeFromAcceptLanguage(request.headers.get("accept-language"));
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

  // Redirect legacy /cn/* → /zh/*
  if (pathname === "/cn" || pathname.startsWith("/cn/")) {
    return NextResponse.redirect(new URL(pathname.replace(/^\/cn/, "/zh"), request.url));
  }

  // Legacy prefixed app routes: /ja/list → /list?lang=ja
  const [, maybeLocale, ...rest] = pathname.split("/");
  const restPath = `/${rest.join("/")}`;
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
    const locale = appRouteLocale(request);
    const headers = new Headers(request.headers);
    headers.set(LOCALE_HEADER, locale);
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
    if (searchParams.get(LOCALE_PARAM) === locale) {
      response.cookies.set(LOCALE_PARAM, locale, { path: "/", sameSite: "lax", maxAge: YEAR_S });
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
