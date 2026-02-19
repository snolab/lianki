import { intlayerMiddleware } from "next-intlayer/middleware";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const BLOG_LOCALES = ["en", "zh", "ja"];
const DEFAULT_LOCALE = "en";

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Redirect /blog/* → /en/blog/*
  if (pathname === "/blog" || pathname.startsWith("/blog/")) {
    return NextResponse.redirect(new URL(`/${DEFAULT_LOCALE}${pathname}`, request.url));
  }

  // Redirect legacy /cn/* → /zh/*
  if (pathname === "/cn" || pathname.startsWith("/cn/")) {
    return NextResponse.redirect(new URL(pathname.replace(/^\/cn/, "/zh"), request.url));
  }

  // Redirect bare locale paths to blog index
  const bare = pathname.slice(1);
  if (BLOG_LOCALES.includes(bare) && pathname.split("/").length === 2) {
    return NextResponse.redirect(new URL(`${pathname}/blog`, request.url));
  }

  // Intlayer: detect locale from Accept-Language / cookie, set locale cookie (noPrefix mode)
  return intlayerMiddleware(request);
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|.*\\.user\\.js).*)"],
};
