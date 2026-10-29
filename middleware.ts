import { intlayerMiddleware } from "next-intlayer/middleware";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { isSupportedLocale } from "@/lib/constants";
import {
  DEFAULT_LOCALE,
  LOCALE_HEADER,
  LOCALE_PARAM,
  isAppRoute,
  localeFromAcceptLanguage,
} from "@/lib/app-locale";

const YEAR_S = 365 * 24 * 60 * 60;

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

    const response = NextResponse.next({ request: { headers } });
    // An explicit ?lang= (a language switch, or a shared link) sticks, so the
    // app's own links can stay bare.
    if (searchParams.get(LOCALE_PARAM) === locale) {
      response.cookies.set(LOCALE_PARAM, locale, { path: "/", sameSite: "lax", maxAge: YEAR_S });
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
