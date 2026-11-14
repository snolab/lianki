import { describe, expect, it } from "bun:test";
import { sameOriginHref, linkDestinations } from "@lianki/debug-chat/link-destination";
const preview = { origin: "https://preview.lianki.com" };
const prod = { origin: "https://lianki.com" };
describe("chat link destinations", () => {
  it("defaults production links to preview without losing query/hash", () => {
    expect(sameOriginHref("https://lianki.com/my/preferences?q=a%20b&x=2#tokens", preview)).toBe(
      "https://preview.lianki.com/my/preferences?q=a%20b&x=2#tokens",
    );
    expect(sameOriginHref("https://www.lianki.com/en", preview)).toBe(
      "https://preview.lianki.com/en",
    );
  });
  it("leaves production pages and other origins unchanged", () => {
    const href = "https://lianki.com/en?a=1#x";
    expect(sameOriginHref(href, prod)).toBe(href);
    expect(sameOriginHref(href, { origin: "https://custom.example" })).toBe(href);
  });
  it("leaves external hosts and non-production protocols unchanged", () => {
    for (const href of [
      "https://example.test/x?q=1#x",
      "https://lianki.com.evil.test/x",
      "https://lianki.com@evil.test/x",
      "http://lianki.com/x",
      "not a URL",
    ])
      expect(sameOriginHref(href, preview)).toBe(href);
  });
  it("preserves explicit site=prod and #prod verbatim", () => {
    for (const href of [
      "https://lianki.com/my?site=prod&x=1#tokens",
      "https://lianki.com/my?x=1#prod",
    ]) {
      expect(sameOriginHref(href, preview)).toBe(href);
      expect(linkDestinations(href, preview)).toEqual({ href, prod: href, forceProd: true });
    }
  });
  it("only preview Lianki links have a production menu action", () => {
    expect(linkDestinations("https://lianki.com/my?a=1#x", preview)).toEqual({
      href: "https://preview.lianki.com/my?a=1#x",
      prod: "https://lianki.com/my?a=1#x",
      forceProd: false,
    });
    expect(linkDestinations("https://preview.lianki.com/my?a=1#x", preview).prod).toBe(
      "https://lianki.com/my?a=1#x",
    );
    expect(linkDestinations("https://example.test/my?site=prod", preview)).toEqual({
      href: "https://example.test/my?site=prod",
      prod: null,
      forceProd: false,
    });
    expect(linkDestinations("https://lianki.com/my", prod).prod).toBeNull();
  });
  it("an explicit prod marker on a preview URL makes the first action production too", () => {
    expect(linkDestinations("https://preview.lianki.com/my?site=prod#x", preview)).toEqual({
      href: "https://lianki.com/my?site=prod#x",
      prod: "https://lianki.com/my?site=prod#x",
      forceProd: true,
    });
  });
});
