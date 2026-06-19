import { describe, expect, it } from "vitest";
import { normalizeUrl } from "../lib/normalizeUrl";

describe("normalizeUrl", () => {
  it("returns the same URL for a simple case", () => {
    expect(normalizeUrl("https://example.com/page")).toBe("https://example.com/page");
  });

  it("converts youtu.be short links to youtube.com/watch", () => {
    expect(normalizeUrl("https://youtu.be/dQw4w9WgXcQ")).toBe(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    );
  });

  it("strips mobile subdomain (m.youtube.com → www.youtube.com)", () => {
    expect(normalizeUrl("https://m.youtube.com/watch?v=abc")).toBe(
      "https://www.youtube.com/watch?v=abc",
    );
  });

  it("strips tracking params (utm_source, fbclid, etc.)", () => {
    const url = "https://example.com/page?foo=bar&utm_source=twitter&utm_medium=social&fbclid=abc";
    const normalized = normalizeUrl(url);
    expect(normalized).toBe("https://example.com/page?foo=bar");
  });

  it("strips theme param so display preference doesn't fork the card URL", () => {
    expect(normalizeUrl("https://www.zhihu.com/question/23857983?theme=dark")).toBe(
      "https://www.zhihu.com/question/23857983",
    );
    // both variants must normalize to the same identity
    expect(normalizeUrl("https://www.zhihu.com/question/23857983?theme=dark")).toBe(
      normalizeUrl("https://www.zhihu.com/question/23857983"),
    );
  });

  it("strips si param from YouTube", () => {
    const url = "https://www.youtube.com/watch?v=abc&si=tracking123";
    expect(normalizeUrl(url)).toBe("https://www.youtube.com/watch?v=abc");
  });

  it("strips pp param", () => {
    const url = "https://www.youtube.com/watch?v=abc&pp=xyz";
    expect(normalizeUrl(url)).toBe("https://www.youtube.com/watch?v=abc");
  });

  it("sorts remaining search params", () => {
    const url = "https://example.com/page?z=1&a=2";
    expect(normalizeUrl(url)).toBe("https://example.com/page?a=2&z=1");
  });

  it("returns original string for invalid URLs", () => {
    expect(normalizeUrl("not-a-url")).toBe("not-a-url");
  });

  it("strips all known tracking params", () => {
    const params = [
      "si",
      "pp",
      "feature",
      "ref",
      "source",
      "theme",
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
      "fbclid",
      "gclid",
      "mc_cid",
      "mc_eid",
      "igshid",
    ];
    const url = `https://example.com/page?keep=1&${params.map((p) => `${p}=x`).join("&")}`;
    expect(normalizeUrl(url)).toBe("https://example.com/page?keep=1");
  });

  it("handles m. subdomain on non-YouTube domains", () => {
    expect(normalizeUrl("https://m.example.com/page")).toBe("https://www.example.com/page");
  });

  it("strips index param from YouTube watch URLs", () => {
    expect(
      normalizeUrl(
        "https://www.youtube.com/watch?v=__Cu2nwgAjA&list=PLnazreCxpqRlvlt5Pf4qn4bUoua5nU2Im&index=3",
      ),
    ).toBe("https://www.youtube.com/watch?list=PLnazreCxpqRlvlt5Pf4qn4bUoua5nU2Im&v=__Cu2nwgAjA");
  });

  it("does not strip index from non-YouTube URLs", () => {
    expect(normalizeUrl("https://example.com/page?index=3")).toBe(
      "https://example.com/page?index=3",
    );
  });
});
