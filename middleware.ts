import { intlayerMiddleware } from "next-intlayer/middleware";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { BLOG_LOCALES } from "@/lib/constants";

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Special routes that don't need locale prefix
  if (pathname === "/next") {
    return NextResponse.next();
  }

  // Redirect legacy /cn/* → /zh/*
  if (pathname === "/cn" || pathname.startsWith("/cn/")) {
    return NextResponse.redirect(new URL(pathname.replace(/^\/cn/, "/zh"), request.url));
  }

  // Redirect bare locale paths to blog index
  const bare = pathname.slice(1);
  if ((BLOG_LOCALES as readonly string[]).includes(bare) && pathname.split("/").length === 2) {
    return NextResponse.redirect(new URL(`${pathname}/blog`, request.url));
  }

  // Intlayer middleware: adds locale prefix to all routes, handles locale detection
  // This will redirect / → /en/, /list → /en/list, etc.
  return intlayerMiddleware(request);
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|.*\\.user\\.js).*)"],
};
