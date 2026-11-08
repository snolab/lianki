import { describe, expect, it } from "bun:test";
import { NextRequest } from "next/server";
import { middleware } from "@/middleware";
import { MOVED_ROUTES, movedHref, movedPath } from "@/lib/moved-routes";
import { cleanNavPins } from "@/lib/nav/ui-store";
import { isAppRoute } from "@/lib/app-locale";

// docs/url-principles.md, rule 9: an old address never breaks.

describe("movedPath", () => {
  it("moves the page and everything under it", () => {
    expect(movedPath("/ai-vocab")).toBe("/lab/ai-vocab");
    expect(movedPath("/ai-vocab/")).toBe("/lab/ai-vocab");
    expect(movedPath("/ai-vocab/ja")).toBe("/lab/ai-vocab/ja");
    expect(movedPath("/polyglot")).toBe("/lab/polyglot");
    expect(movedPath("/polyglot/x/y")).toBe("/lab/polyglot/x/y");
  });

  it("matches whole segments only, and leaves the new paths alone", () => {
    expect(movedPath("/ai-vocabulary")).toBeNull();
    expect(movedPath("/polyglots")).toBeNull();
    expect(movedPath("/lab/ai-vocab")).toBeNull();
    expect(movedPath("/lab/polyglot")).toBeNull();
    expect(movedPath("/words")).toBeNull();
  });

  it("points every row at an app route, never at another moved one", () => {
    for (const [, to] of MOVED_ROUTES) {
      expect(isAppRoute(to)).toBe(true);
      expect(movedPath(to)).toBeNull();
    }
  });
});

describe("middleware", () => {
  const go = (path: string) => middleware(new NextRequest(`https://lianki.com${path}`));

  it("answers an old path with one permanent redirect, query kept", () => {
    const res = go("/ai-vocab/zh?lang=ja&x=1");
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe("https://lianki.com/lab/ai-vocab/zh?lang=ja&x=1");
  });

  it("drops a legacy locale prefix into ?lang= in the same hop", () => {
    const ja = go("/ja/polyglot");
    expect(ja.status).toBe(308);
    expect(ja.headers.get("location")).toBe("https://lianki.com/lab/polyglot?lang=ja");
    const en = go("/en/polyglot");
    expect(en.headers.get("location")).toBe("https://lianki.com/lab/polyglot");
  });

  it("serves the new path as an app route", () => {
    const res = go("/lab/polyglot");
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  // 2026-11-09 (owner): /read is /reader. An open tab, a saved link, a chat
  // link or a pinned page lands on the same book, review and query.
  it("moves the reader, its books, their reviews and the YouTube import", () => {
    const at = (p: string) => go(p).headers.get("location");
    expect(go("/read").status).toBe(308);
    expect(at("/read")).toBe("https://lianki.com/reader");
    expect(at("/read?gdoc=abc&pick=drive")).toBe("https://lianki.com/reader?gdoc=abc&pick=drive");
    expect(at("/read/0123456789abcdef?review=p12&streamingFrom=google-docs")).toBe(
      "https://lianki.com/reader/0123456789abcdef?review=p12&streamingFrom=google-docs",
    );
    expect(at("/read/youtube")).toBe("https://lianki.com/reader/youtube");
    expect(at("/zh/read/abc")).toBe("https://lianki.com/reader/abc?lang=zh");
    // The new address, the API and a longer word are left alone.
    expect(at("/reader/abc")).toBeNull();
    expect(movedPath("/api/read/abc/items")).toBeNull();
    expect(movedPath("/reading")).toBeNull();
  });
});

describe("movedHref: kept hrefs (pins, recent pages)", () => {
  it("moves the path and keeps the query and hash", () => {
    expect(movedHref("/read/abc?review=p1#p=4")).toBe("/reader/abc?review=p1#p=4");
    expect(movedHref("/read")).toBe("/reader");
    expect(movedHref("/read#x")).toBe("/reader#x");
    expect(movedHref("/words?x=1")).toBe("/words?x=1");
  });
  it("a pinned /read comes back as /reader", () => {
    expect(cleanNavPins({ pinned: ["/words", "/read", "/reader"] })).toEqual({
      pinned: ["/words", "/reader"],
    });
  });
});
