/**
 * The landing page's locale roots ("/zh", "/en", …) are served as they are.
 * intlayer's middleware rewrote "/zh" to "/zh/", next dev answered the slash
 * with a 308 back to "/zh", and the browser looped to ERR_TOO_MANY_REDIRECTS
 * (owner, 2026-11-03 14:56 JST, on the whole-page dev server).
 */
import { describe, expect, it } from "bun:test";
import { NextRequest } from "next/server";
import { middleware } from "@/middleware";
import { LOCALE_PARAM, localeRoot } from "@/lib/app-locale";

const passed = (res: Response, h: string) => res.headers.get(`x-middleware-request-${h}`);

describe("locale roots", () => {
  it("localeRoot: only a bare supported locale", () => {
    expect(localeRoot("/zh")).toBe("zh");
    expect(localeRoot("/en")).toBe("en");
    expect(localeRoot("/ko")).toBe("ko");
    expect(localeRoot("/zh/")).toBeNull();
    expect(localeRoot("/zh/blog")).toBeNull();
    expect(localeRoot("/xx")).toBeNull();
    expect(localeRoot("/cn")).toBeNull(); // the legacy redirect handles it
    expect(localeRoot("/")).toBeNull();
    expect(localeRoot("/words")).toBeNull();
  });

  it("middleware neither redirects nor rewrites /zh, and passes its locale down", () => {
    for (const l of ["zh", "en", "ja"]) {
      const res = middleware(new NextRequest(`https://preview.lianki.com/${l}`));
      expect(res.status).toBe(200);
      expect(res.headers.get("location")).toBeNull();
      expect(res.headers.get("x-middleware-rewrite")).toBeNull();
      expect(res.headers.get("x-middleware-next")).toBe("1");
      expect(passed(res, "x-intlayer-locale")).toBe(l);
    }
  });

  it("a first visit seeds the app's locale cookie; an existing one is kept", () => {
    const first = middleware(new NextRequest("https://lianki.com/ja"));
    expect(first.cookies.get(LOCALE_PARAM)?.value).toBe("ja");
    const kept = middleware(
      new NextRequest("https://lianki.com/ja", { headers: { cookie: `${LOCALE_PARAM}=zh` } }),
    );
    expect(kept.cookies.get(LOCALE_PARAM)).toBeUndefined();
  });

  it("the rest of the landing and blog still goes through intlayer", () => {
    const bare = middleware(new NextRequest("https://lianki.com/"));
    expect(bare.headers.get("location")).toContain("/en");
    const blog = middleware(new NextRequest("https://lianki.com/zh/blog"));
    expect(blog.headers.get("location")).toBeNull();
  });
});
