import { describe, expect, it } from "bun:test";
import { extractLinks } from "@/lib/extract-urls";

const urls = (text: string) => extractLinks(text).map((l) => l.url);

describe("extractLinks", () => {
  it("finds urls inside markdown list items, which a line filter dropped", () => {
    // /learn kept only lines *starting* with http, so this imported nothing.
    const text = `
- https://a.test/one
* https://a.test/two
1. https://a.test/three
    `;
    expect(urls(text)).toEqual([
      "https://a.test/one",
      "https://a.test/two",
      "https://a.test/three",
    ]);
  });

  it("reads markdown links and keeps the title", () => {
    expect(extractLinks("- [Two-sum](https://leetcode.com/problems/two-sum/)")).toEqual([
      { url: "https://leetcode.com/problems/two-sum/", title: "Two-sum" },
    ]);
  });

  it("does not let a markdown link's closing paren leak into the url", () => {
    // Posted raw, `[t](https://a.test/x)` became a card whose url was that
    // literal string. The bare-url pass must not see the `)` either.
    expect(urls("see [t](https://a.test/x) and more")).toEqual(["https://a.test/x"]);
  });

  it("handles autolinks and urls mid-sentence", () => {
    expect(urls("check <https://a.test/x> then https://a.test/y today")).toEqual([
      "https://a.test/x",
      "https://a.test/y",
    ]);
  });

  it("trims trailing sentence punctuation, which is almost never part of the url", () => {
    expect(urls("Read https://a.test/x. Then https://a.test/y, and https://a.test/z!")).toEqual([
      "https://a.test/x",
      "https://a.test/y",
      "https://a.test/z",
    ]);
  });

  it("drops an unbalanced trailing paren but keeps a balanced one", () => {
    // Wikipedia-style urls legitimately end in `)`; a parenthetical aside does not.
    expect(urls("(see https://a.test/x)")).toEqual(["https://a.test/x"]);
    expect(urls("https://en.wikipedia.org/wiki/Foo_(bar)")).toEqual([
      "https://en.wikipedia.org/wiki/Foo_(bar)",
    ]);
    expect(urls("(https://en.wikipedia.org/wiki/Foo_(bar))")).toEqual([
      "https://en.wikipedia.org/wiki/Foo_(bar)",
    ]);
  });

  it("dedupes through normalizeUrl, so the count matches the cards created", () => {
    // youtu.be and the tracking param both collapse onto the same card.
    const text = `
https://youtu.be/abc
https://www.youtube.com/watch?v=abc&si=track
https://www.youtube.com/watch?v=abc
    `;
    expect(urls(text)).toHaveLength(1);
  });

  it("fills a title in from a later markdown occurrence of the same url", () => {
    const text = "https://a.test/x\n\n[Named](https://a.test/x)";
    expect(extractLinks(text)).toEqual([{ url: "https://a.test/x", title: "Named" }]);
  });

  it("ignores a title that is just the url again", () => {
    expect(extractLinks("[https://a.test/x](https://a.test/x)")).toEqual([
      { url: "https://a.test/x" },
    ]);
  });

  it("rejects non-http schemes and things that only look like urls", () => {
    expect(urls("ftp://a.test/x mailto:a@b.test javascript:alert(1) http:// https://")).toEqual([]);
  });

  it("returns nothing for empty or link-free text", () => {
    expect(urls("")).toEqual([]);
    expect(urls("no links here, just words")).toEqual([]);
  });

  it("survives a realistic paste: chat log with mixed formatting", () => {
    const text = `
snomiao: worth a read → https://apenwarr.ca/log/20260704
snomiao: also this one: [thundersnap](https://apenwarr.ca/log/20260704) (same thing)
bot: "https://example.com/a?x=1&y=2"; and <https://example.com/b>.
    `;
    expect(extractLinks(text)).toEqual([
      { url: "https://apenwarr.ca/log/20260704", title: "thundersnap" },
      { url: "https://example.com/a?x=1&y=2" },
      { url: "https://example.com/b" },
    ]);
  });
});
