import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const LOCALES = ["en", "cn"];
const DEFAULT_LOCALE = "en";

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Redirect /blog/* → /en/blog/*
  if (pathname === "/blog" || pathname.startsWith("/blog/")) {
    return NextResponse.redirect(new URL(`/${DEFAULT_LOCALE}${pathname}`, request.url));
  }

  // Redirect bare /en or /cn to locale blog index
  if (LOCALES.includes(pathname.slice(1)) && pathname.split("/").length === 2) {
    return NextResponse.redirect(new URL(`${pathname}/blog`, request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/blog/:path*", "/en", "/cn"],
};
