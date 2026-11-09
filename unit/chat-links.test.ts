import { describe, expect, it } from "bun:test";
import {
  httpHref,
  linkAtStart,
  linkClick,
  parseLinks,
  safeHref,
  safeImageSrc,
  sameTab,
} from "@lianki/debug-chat/chat-links";

/** The texts of the links found, in order. */
const links = (t: string) => parseLinks(t).flatMap((s) => (s.href ? [s.text] : []));

describe("parseLinks", () => {
  it("joined, the pieces are the text", () => {
    const t = "见 https://lianki.com/en，然后 lianki.com/dev/flags#words.voice-mode。 done";
    expect(
      parseLinks(t)
        .map((s) => s.text)
        .join(""),
    ).toBe(t);
  });

  it("finds http(s) and bare lianki.com paths, with dots and hashes", () => {
    expect(links("https://lianki.com/dev/flags#words.voice-mode")).toEqual([
      "https://lianki.com/dev/flags#words.voice-mode",
    ]);
    expect(links("see http://example.com/a?b=1&c=2 ok")).toEqual(["http://example.com/a?b=1&c=2"]);
    expect(parseLinks("lianki.com/en")[0]).toEqual({
      text: "lianki.com/en",
      href: "https://lianki.com/en",
    });
    expect(links("www.lianki.com/en and HTTPS://LIANKI.COM/x")).toEqual([
      "www.lianki.com/en",
      "HTTPS://LIANKI.COM/x",
    ]);
  });

  it("no other scheme, ever", () => {
    for (const t of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:x",
      "file:///etc/passwd",
      "ftp://example.com/x",
      "ftp://lianki.com/x",
      "mailto:a@b.c",
    ])
      expect(links(t)).toEqual([]);
    // A real URL after one of them is that URL, and only that.
    const [, link] = parseLinks("javascript:https://evil.example/");
    expect(link).toEqual({ text: "https://evil.example/", href: "https://evil.example/" });
  });

  it("is not fooled by hosts that merely contain lianki.com", () => {
    for (const t of [
      "notlianki.com/x",
      "a.lianki.com/x",
      "lianki.com.evil.example/x",
      "me@lianki.com/x",
      "lianki.com",
    ])
      expect(links(t)).toEqual([]);
    expect(parseLinks("https://lianki.com@evil.example/")[0]?.href).toBe(
      "https://lianki.com@evil.example/",
    );
    expect(links("xhttps://a.example/")).toEqual([]);
  });

  it("leaves punctuation and closing brackets out", () => {
    const cases: [string, string][] = [
      ["see https://a.example/x.", "https://a.example/x"],
      ["https://a.example/x, then", "https://a.example/x"],
      ["(https://a.example/x)", "https://a.example/x"],
      ["[https://a.example/x]", "https://a.example/x"],
      ["**https://a.example/x**", "https://a.example/x"],
      ["'https://a.example/x'", "https://a.example/x"],
      ['"https://a.example/x"', "https://a.example/x"],
      ["https://a.example/x?!", "https://a.example/x"],
      ["https://a.example/x。", "https://a.example/x"],
      ["https://a.example/x，好", "https://a.example/x"],
      ["（https://a.example/x）", "https://a.example/x"],
      ["「https://a.example/x」", "https://a.example/x"],
      ["https://a.example/x）。", "https://a.example/x"],
    ];
    for (const [t, want] of cases) expect(links(t)).toEqual([want]);
  });

  it("keeps a closer the URL opened itself", () => {
    expect(links("https://en.wikipedia.org/wiki/Foo_(bar)")).toEqual([
      "https://en.wikipedia.org/wiki/Foo_(bar)",
    ]);
    expect(links("(https://en.wikipedia.org/wiki/Foo_(bar))")).toEqual([
      "https://en.wikipedia.org/wiki/Foo_(bar)",
    ]);
  });

  it("text touching a URL in a script without spaces is not swallowed", () => {
    expect(parseLinks("打开https://lianki.com/en就好")).toEqual([
      { text: "打开" },
      { text: "https://lianki.com/en", href: "https://lianki.com/en" },
      { text: "就好" },
    ]);
    expect(links("开lianki.com/en了")).toEqual(["lianki.com/en"]);
    expect(links("見てhttps://a.example/xください")).toEqual(["https://a.example/x"]);
    expect(links("보기https://a.example/x에서")).toEqual(["https://a.example/x"]);
    expect(links("ดูhttps://a.example/xก่อน")).toEqual(["https://a.example/x"]);
    // Other letters stay in a path.
    expect(links("https://fr.wikipedia.org/wiki/Café ok")).toEqual([
      "https://fr.wikipedia.org/wiki/Café",
    ]);
  });

  it("a host that isn't ASCII is not a link, so none reads as ours", () => {
    expect(links("https://lіanki.com/x")).toEqual([]);
    expect(links("https://中文.example/x")).toEqual([]);
    expect(links("https://")).toEqual([]);
    expect(links("https://[bad/")).toEqual([]);
  });

  it("markup in a message ends the URL and stays text", () => {
    expect(links("https://a.example/<script>alert(1)</script>")).toEqual(["https://a.example/"]);
    expect(links('https://a.example/"onmouseover="alert(1)')).toEqual(["https://a.example/"]);
    expect(links("https://a.example/`x`")).toEqual(["https://a.example/"]);
    // Bidi and zero-width controls are not URL characters.
    expect(links("https://a.example/‮fdp.exe")).toEqual(["https://a.example/"]);
    expect(links("https://a.example/​x")).toEqual(["https://a.example/"]);
  });
});

describe("linkAtStart", () => {
  it("only at the start", () => {
    expect(linkAtStart("https://a.example/_x_/y more")).toBe("https://a.example/_x_/y");
    expect(linkAtStart("www.a.example")).toBeNull();
    expect(linkAtStart("x https://a.example")).toBeNull();
    expect(linkAtStart("https://[bad/")).toBeNull();
  });
});

describe("safeHref", () => {
  it("http(s) and lianki.com paths", () => {
    expect(safeHref("https://a.example/x")).toBe("https://a.example/x");
    expect(safeHref(" http://a.example/ ")).toBe("http://a.example/");
    expect(safeHref("/dev/flags#a.b")).toBe("https://lianki.com/dev/flags#a.b");
  });

  it("nothing else", () => {
    for (const h of [
      "javascript:alert(1)",
      " JAVASCRIPT:alert(1)",
      "java\tscript:alert(1)",
      "java\nscript:alert(1)",
      "\u0001javascript:alert(1)",
      "data:text/html,x",
      "vbscript:x",
      "blob:https://lianki.com/x",
      "file:///etc/passwd",
      "//evil.example/x",
      "/\\evil.example/x",
      "/\t/evil.example/x",
      "//",
      "relative/path",
      "",
    ])
      expect(safeHref(h)).toBeNull();
    expect(httpHref("nope")).toBeNull();
  });

  it("images: an allowed origin over https only", () => {
    expect(safeImageSrc("https://lianki.com/a.png")).toBe("https://lianki.com/a.png");
    expect(safeImageSrc("/a.png")).toBe("https://lianki.com/a.png");
    expect(safeImageSrc("http://lianki.com/a.png")).toBeNull();
    expect(safeImageSrc("https://evil.example/a.png")).toBeNull();
    expect(safeImageSrc("https://lianki.com.evil.example/a.png")).toBeNull();
    expect(safeImageSrc("data:image/png;base64,AAAA")).toBeNull();
    expect(safeImageSrc("https://cdn.example/a.png", ["https://cdn.example"])).toBe(
      "https://cdn.example/a.png",
    );
  });
});

describe("where a click goes", () => {
  const base = {
    href: "https://lianki.com/dev/flags?x=1#a.b",
    hereHost: "lianki.com",
    movedPx: 0,
    modified: false,
    hasRouter: true,
  };

  it("ours on lianki.com stays, in-app when the host has a router", () => {
    expect(sameTab(base.href, "lianki.com")).toBe(true);
    expect(sameTab("https://www.lianki.com/x", "lianki.com")).toBe(true);
    expect(linkClick(base)).toEqual({ to: "app", path: "/dev/flags?x=1#a.b" });
    expect(linkClick({ ...base, hasRouter: false })).toEqual({ to: "native" });
  });

  it("anywhere else, or another site's link, is a new tab", () => {
    expect(sameTab(base.href, "example.com")).toBe(false);
    expect(sameTab(base.href, undefined)).toBe(false);
    expect(sameTab("https://evil.example/", "lianki.com")).toBe(false);
    expect(sameTab("https://lianki.com@evil.example/", "lianki.com")).toBe(false);
    expect(linkClick({ ...base, href: "https://evil.example/" })).toEqual({ to: "native" });
  });

  it("a modifier key is the browser's, a drag is a selection", () => {
    expect(linkClick({ ...base, modified: true })).toEqual({ to: "native" });
    expect(linkClick({ ...base, movedPx: 11 })).toEqual({ to: "drag" });
    expect(linkClick({ ...base, movedPx: 10 }).to).toBe("app");
  });
});
