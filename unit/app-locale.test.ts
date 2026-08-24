import { describe, expect, it } from "vitest";
import { appHref, isAppRoute, localeFromAcceptLanguage, resolveLocale } from "@/lib/app-locale";

describe("isAppRoute", () => {
  it("matches app routes and their subpaths", () => {
    expect(isAppRoute("/list")).toBe(true);
    expect(isAppRoute("/read/abc123")).toBe(true);
    expect(isAppRoute("/ai-vocab/ja")).toBe(true);
  });

  it("does not match the landing page or blog, which keep /{locale}/ prefixes", () => {
    expect(isAppRoute("/")).toBe(false);
    expect(isAppRoute("/blog")).toBe(false);
    expect(isAppRoute("/blog/2025-01-01-introduction")).toBe(false);
    expect(isAppRoute("/ja")).toBe(false);
  });
});

describe("appHref", () => {
  it("leaves the default locale as a bare path so it stays the canonical URL", () => {
    expect(appHref("/list", "en")).toBe("/list");
  });

  it("appends ?lang= for non-default locales", () => {
    expect(appHref("/list", "ja")).toBe("/list?lang=ja");
    expect(appHref("/read/abc", "ko")).toBe("/read/abc?lang=ko");
  });

  it("merges into an existing query string instead of starting a new one", () => {
    expect(appHref("/list?due=today", "ja")).toBe("/list?due=today&lang=ja");
  });

  it("keeps the fragment last so the anchor still resolves", () => {
    expect(appHref("/learn#imports", "ja")).toBe("/learn?lang=ja#imports");
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
