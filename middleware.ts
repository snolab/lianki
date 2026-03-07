import { intlayerMiddleware } from "next-intlayer/middleware";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { BLOG_LOCALES } from "@/lib/constants";

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const host = request.headers.get("host");

  // Redirect beta.lianki.com → Vercel beta preview URL
  if (host === "beta.lianki.com") {
    const previewUrl = new URL(request.url);
    previewUrl.host = "lianki-git-beta-snomiao.vercel.app";
    return NextResponse.redirect(previewUrl, 308);
  }

  // Special routes that don't need locale prefix
  if (pathname === "/next") {
    return NextResponse.next();
  }

  // Redirect legacy /cn/* → /zh/*
  if (pathname === "/cn" || pathname.startsWith("/cn/")) {
    return NextResponse.redirect(new URL(pathname.replace(/^\/cn/, "/zh"), request.url));
  }

  // Intlayer middleware: adds locale prefix to all routes, handles locale detection
  // This will redirect / → /en/, /list → /en/list, etc.
  // Locale root paths (e.g., /ko/) will render the landing page at app/[locale]/page.tsx
  return intlayerMiddleware(request);
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|.*\\.user\\.js|.*\\.meta\\.js).*)"],
};
