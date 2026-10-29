import { describe, expect, it } from "bun:test";
import { isAppRoute, localeFromAcceptLanguage, resolveLocale } from "@/lib/app-locale";

describe("isAppRoute", () => {
  it("matches app routes and their subpaths", () => {
    expect(isAppRoute("/list")).toBe(true);
    expect(isAppRoute("/read/abc123")).toBe(true);
    expect(isAppRoute("/ai-vocab/ja")).toBe(true);
    expect(isAppRoute("/dev/roadmap")).toBe(true);
  });

  it("does not match the landing page or blog, which keep /{locale}/ prefixes", () => {
    expect(isAppRoute("/")).toBe(false);
    expect(isAppRoute("/blog")).toBe(false);
    expect(isAppRoute("/blog/2025-01-01-introduction")).toBe(false);
    expect(isAppRoute("/ja")).toBe(false);
  });
});

describe("resolveLocale", () => {
  it("falls back to the default for unsupported or missing values", () => {
    expect(resolveLocale("ja")).toBe("ja");
    expect(resolveLocale("klingon")).toBe("en");
    expect(resolveLocale(null)).toBe("en");
    expect(resolveLocale(undefined)).toBe("en");
  });
});

describe("localeFromAcceptLanguage", () => {
  it("matches a regional tag down to its base locale", () => {
    expect(localeFromAcceptLanguage("ja-JP,ja;q=0.9,en;q=0.8")).toBe("ja");
  });

  it("skips unsupported locales and takes the first supported one", () => {
    expect(localeFromAcceptLanguage("nl-NL,nl;q=0.9,de;q=0.7")).toBe("de");
  });

  it("defaults to English when nothing matches", () => {
    expect(localeFromAcceptLanguage("nl,fi")).toBe("en");
    expect(localeFromAcceptLanguage(null)).toBe("en");
  });
});

it("every sidebar page is an app route, so the locale middleware leaves it alone", async () => {
  const { APP_NAV } = await import("@/lib/app-nav");
  for (const item of APP_NAV) expect(isAppRoute(item.href)).toBe(true);
});

it("activeNavKey picks the longest matching sidebar href", async () => {
  const { activeNavKey } = await import("@/lib/app-nav");
  expect(activeNavKey("/words")).toBe("words");
  expect(activeNavKey("/read/abc")).toBe("read");
  expect(activeNavKey("/nowhere")).toBeNull();
});
