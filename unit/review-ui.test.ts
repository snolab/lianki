import { describe, expect, test } from "bun:test";
import { activeNavKey, APP_NAV } from "@/lib/app-nav";
import { isAppRoute } from "@/lib/app-locale";
import {
  api,
  bookmarkletSource,
  cardFromDue,
  cardFromGet,
  detectPlatform,
  gradeKey,
  installGuideHref,
  isHttpUrl,
  keyAction,
  optionsFrom,
  reviewHrefFor,
} from "@/lib/review-ui";

describe("cards out of the existing API", () => {
  test("the top of /api/fsrs/due", () => {
    expect(
      cardFromDue({
        cards: [
          { _id: "a1", url: "https://x.test/p", title: "P", card: { due: "2026-11-01T00:00:00Z" } },
          { _id: "a2", url: "https://x.test/q" },
        ],
      }),
    ).toEqual({ id: "a1", url: "https://x.test/p", title: "P", due: "2026-11-01T00:00:00Z" });
  });

  test("nothing due, or a malformed answer, is no card", () => {
    expect(cardFromDue({ cards: [] })).toBeNull();
    expect(cardFromDue(null)).toBeNull();
    expect(cardFromDue({ cards: [{ url: "https://x.test" }] })).toBeNull();
  });

  test("/api/fsrs/get: an empty title is no title", () => {
    expect(cardFromGet({ _id: "b", url: "https://x.test/r", title: "" })).toEqual({
      id: "b",
      url: "https://x.test/r",
      title: null,
      due: null,
    });
    expect(cardFromGet({ error: "note not found" })).toBeNull();
  });

  test("the four intervals, in grade order, junk dropped", () => {
    expect(
      optionsFrom({
        options: [
          { rating: 3, label: "Good", due: "10m" },
          { rating: 1, label: "Again", due: "1m" },
          { rating: 9, due: "x" },
          { rating: 4, due: "9d" },
          { rating: 2, due: "6m" },
        ],
      }),
    ).toEqual([
      { rating: 1, due: "1m" },
      { rating: 2, due: "6m" },
      { rating: 3, due: "10m" },
      { rating: 4, due: "9d" },
    ]);
    expect(optionsFrom(null)).toEqual([]);
  });
});

describe("API paths are the legacy page's own", () => {
  test("grading is the GET /api/fsrs/repeat sends", () => {
    expect(api.review("65a1", 3)).toBe("/api/fsrs/review/3/?id=65a1");
    expect(api.delete("65a1")).toBe("/api/fsrs/delete/?id=65a1");
  });
  test("the rest of the endpoints", () => {
    expect(api.due()).toBe("/api/fsrs/due?limit=1");
    expect(api.stats()).toBe("/api/fsrs/stats");
    expect(api.add()).toBe("/api/fsrs/add");
    expect(gradeKey(2)).toBe("2");
  });
  test("ids and urls are encoded", () => {
    expect(api.options("a b")).toBe("/api/fsrs/options?id=a%20b");
    expect(api.get("https://x.test/?a=1&b=2")).toBe(
      "/api/fsrs/get?url=https%3A%2F%2Fx.test%2F%3Fa%3D1%26b%3D2",
    );
  });
});

describe("keyboard", () => {
  test("the legacy page's keys: digits, a s w d / t, h j k l / m", () => {
    expect(keyAction({ code: "Digit1" })).toEqual({ kind: "grade", rating: 1 });
    expect(keyAction({ code: "Digit4" })).toEqual({ kind: "grade", rating: 4 });
    expect(keyAction({ code: "KeyA" })).toEqual({ kind: "grade", rating: 1 });
    expect(keyAction({ code: "KeyS" })).toEqual({ kind: "grade", rating: 2 });
    expect(keyAction({ code: "KeyW" })).toEqual({ kind: "grade", rating: 3 });
    expect(keyAction({ code: "KeyD" })).toEqual({ kind: "grade", rating: 4 });
    expect(keyAction({ code: "KeyH" })).toEqual({ kind: "grade", rating: 1 });
    expect(keyAction({ code: "KeyL" })).toEqual({ kind: "grade", rating: 4 });
    for (const code of ["Digit5", "KeyT", "KeyM"])
      expect(keyAction({ code })).toEqual({ kind: "delete" });
  });
  test("o / Enter open, Escape cancels", () => {
    expect(keyAction({ code: "KeyO" })).toEqual({ kind: "open" });
    expect(keyAction({ code: "Enter" })).toEqual({ kind: "open" });
    expect(keyAction({ code: "Escape" })).toEqual({ kind: "cancel" });
  });
  test("never with a modifier, never while typing, nothing for other keys", () => {
    expect(keyAction({ code: "Digit1", metaKey: true })).toBeNull();
    expect(keyAction({ code: "KeyS", ctrlKey: true })).toBeNull();
    expect(keyAction({ code: "KeyA", shiftKey: true })).toBeNull();
    expect(keyAction({ code: "KeyA", altKey: true })).toBeNull();
    expect(keyAction({ code: "KeyA", typing: true })).toBeNull();
    expect(keyAction({ code: "KeyZ" })).toBeNull();
  });
});

describe("tutorial platform", () => {
  test("Android says so; everything else gets the iPhone steps", () => {
    expect(
      detectPlatform("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130"),
    ).toBe("android");
    expect(
      detectPlatform("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15"),
    ).toBe("ios");
    expect(detectPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe("ios");
  });
  test("install guides are the en blog posts, under the locale", () => {
    expect(installGuideHref("ios")).toBe("/en/blog/2025-02-23-ios-installation-guide");
    expect(installGuideHref("android", "ja")).toBe(
      "/ja/blog/2026-02-25-android-installation-guide",
    );
  });
});

describe("bookmarklet", () => {
  const src = bookmarkletSource("https://lianki.com/");

  test("is a javascript: URL that opens /review for the current page", () => {
    expect(src.startsWith("javascript:(function(){")).toBe(true);
    expect(src).toContain('"https://lianki.com/review?url="+encodeURIComponent(location.href)');
    expect(src).toContain("window.open(u,'_blank')");
  });

  test("survives being a bookmark URL: no #, no %, no newline", () => {
    expect(src).not.toMatch(/[#%\n]/);
  });

  test("calls no API from the other site (cookies would not be sent)", () => {
    expect(src).not.toContain("fetch(");
    expect(src).not.toContain("XMLHttpRequest");
    expect(src).not.toContain("/api/");
  });

  test("runs: opens the tab, or falls back to a tappable link when blocked", () => {
    const body = src.slice("javascript:".length);
    const opened: string[] = [];
    const appended: { href: string; target: string }[] = [];
    const doc = {
      getElementById: () => null,
      createElement: () => ({ style: {} }) as Record<string, unknown>,
      body: { appendChild: (a: { href: string; target: string }) => appended.push(a) },
    };
    const run = (open: (u: string) => unknown) =>
      new Function("window", "document", "location", body)({ open }, doc, {
        href: "https://example.com/a?b=1",
      });

    run((u) => (opened.push(u), {}));
    expect(opened).toEqual(["https://lianki.com/review?url=https%3A%2F%2Fexample.com%2Fa%3Fb%3D1"]);
    expect(appended).toEqual([]);

    run(() => null);
    expect(appended).toHaveLength(1);
    expect(appended[0].href).toBe(opened[0]);
    expect(appended[0].target).toBe("_blank");
  });

  test("reviewHrefFor matches what the bookmarklet opens", () => {
    expect(reviewHrefFor("https://lianki.com", "https://example.com/a?b=1")).toBe(
      "https://lianki.com/review?url=https%3A%2F%2Fexample.com%2Fa%3Fb%3D1",
    );
  });
});

describe("routing", () => {
  test("only http(s) pages are opened", () => {
    expect(isHttpUrl("https://x.test/a")).toBe(true);
    expect(isHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isHttpUrl("not a url")).toBe(false);
    expect(isHttpUrl(null)).toBe(false);
  });

  test("/review is an app route, and the nav's Review points at it", () => {
    expect(isAppRoute("/review")).toBe(true);
    expect(APP_NAV.find((n) => n.key === "review")?.href).toBe("/review");
    expect(activeNavKey("/review")).toBe("review");
  });
});
