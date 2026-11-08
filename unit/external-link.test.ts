import { describe, expect, it } from "bun:test";
import {
  addTrustedHost,
  hostIsTrusted,
  hostToConfirm,
  isOwnHost,
  leavingHost,
  parseTrustedHosts,
  trustedHostOf,
  TRUSTED_HOSTS_BYTES,
  TRUSTED_HOSTS_MAX,
} from "@lianki/core/externalLink";
import { guardRel, leavingClick } from "@/lib/external-link";
import { checkPref } from "@/lib/prefs/schema";

const HERE = "https://lianki.com/en/read/abc";
const ASK = { confirm: true, hosts: [] as string[] };

describe("external links: the host check", () => {
  it("lianki.com and every subdomain are our own", () => {
    for (const h of [
      "lianki.com",
      "www.lianki.com",
      "dev.lianki.com",
      "a.b.lianki.com",
      "LIANKI.COM.",
    ])
      expect(isOwnHost(h)).toBe(true);
    for (const h of ["notlianki.com", "lianki.com.evil.io", "lianki.co", "example.com"])
      expect(isOwnHost(h)).toBe(false);
  });

  it("only http(s) links to another host leave", () => {
    expect(leavingHost("https://en.wikipedia.org/wiki/Cat", HERE)).toBe("en.wikipedia.org");
    expect(leavingHost("http://youtube.com/watch?v=x", HERE)).toBe("youtube.com");
    expect(leavingHost("//example.org/x", HERE)).toBe("example.org");
    for (const href of [
      "/en/words",
      "?q=1",
      "#top",
      "https://lianki.com/en",
      "https://www.lianki.com/",
      "https://dev.lianki.com/x",
      "mailto:a@b.c",
      "tel:123",
      "javascript:void(0)",
      "blob:https://lianki.com/1",
      "not a url at all",
    ])
      expect(leavingHost(href, HERE)).toBeNull();
  });

  it("the page's own host never leaves (the dev origin, a box)", () => {
    expect(leavingHost("http://localhost:3000/words", "http://localhost:3000/read")).toBeNull();
    expect(leavingHost("http://localhost:3001/", "http://localhost:3000/read")).toBe("localhost");
  });
});

describe("external links: the allowlist", () => {
  it("keeps public hosts only, without www.", () => {
    expect(trustedHostOf("www.YouTube.com")).toBe("youtube.com");
    expect(trustedHostOf("en.wikipedia.org")).toBe("en.wikipedia.org");
    for (const h of [
      "localhost",
      "taku.onca-tint.ts.net",
      "192.168.1.2",
      "printer.local",
      "https://example.com",
      "example.com/path",
      "",
      "x".repeat(130) + ".com",
    ])
      expect(trustedHostOf(h)).toBeNull();
  });

  it("matches the site and its subdomains, not look-alikes", () => {
    const hosts = ["wikipedia.org", "youtube.com"];
    expect(hostIsTrusted("wikipedia.org", hosts)).toBe(true);
    expect(hostIsTrusted("ja.wikipedia.org", hosts)).toBe(true);
    expect(hostIsTrusted("www.youtube.com", hosts)).toBe(true);
    expect(hostIsTrusted("notwikipedia.org", hosts)).toBe(false);
    expect(hostIsTrusted("youtube.com.evil.io", hosts)).toBe(false);
  });

  it("adds at the end without duplicates, dropping the oldest over the caps", () => {
    expect(addTrustedHost(["a.com", "b.com"], "www.a.com")).toEqual(["b.com", "a.com"]);
    expect(addTrustedHost(["a.com"], "localhost")).toEqual(["a.com"]);
    let list: string[] = [];
    for (let i = 0; i < 200; i++) list = addTrustedHost(list, `site-number-${i}.example.com`);
    expect(list.length).toBeLessThanOrEqual(TRUSTED_HOSTS_MAX);
    expect(JSON.stringify(list).length).toBeLessThanOrEqual(TRUSTED_HOSTS_BYTES);
    expect(list.at(-1)).toBe("site-number-199.example.com");
    expect(checkPref("links.trustedHosts", list)).toEqual(list);
  });

  it("a stored list is cleaned on read", () => {
    expect(parseTrustedHosts(["a.com", "a.com", "x.ts.net", 3, "b.org"])).toEqual([
      "a.com",
      "b.org",
    ]);
    expect(parseTrustedHosts("a.com")).toEqual([]);
  });

  it("decides when to ask", () => {
    const wiki = "https://ja.wikipedia.org/wiki/猫";
    expect(hostToConfirm(wiki, HERE, ASK)).toBe("ja.wikipedia.org");
    expect(hostToConfirm(wiki, HERE, { confirm: true, hosts: ["wikipedia.org"] })).toBeNull();
    expect(hostToConfirm(wiki, HERE, { confirm: false, hosts: [] })).toBeNull();
    expect(hostToConfirm("/en/words", HERE, ASK)).toBeNull();
  });
});

describe("external links: the prefs schema", () => {
  it("takes the two settings in their shapes only", () => {
    expect(checkPref("links.confirm", false)).toBe(false);
    expect(checkPref("links.confirm", "0")).toBeUndefined();
    expect(checkPref("links.trustedHosts", ["youtube.com"])).toEqual(["youtube.com"]);
    for (const bad of [
      "www.youtube.com",
      "https://youtube.com",
      "a.ts.net",
      "localhost",
      "10.0.0.1",
    ])
      expect(checkPref("links.trustedHosts", [bad])).toBeUndefined();
  });
});

type FakeA = {
  tagName: string;
  attrs: Record<string, string>;
  getAttribute(n: string): string | null;
  hasAttribute(n: string): boolean;
  setAttribute(n: string, v: string): void;
  closest(): FakeA;
};
const link = (attrs: Record<string, string>): FakeA => {
  const a: FakeA = {
    tagName: "A",
    attrs: { ...attrs },
    getAttribute: (n) => a.attrs[n] ?? null,
    hasAttribute: (n) => n in a.attrs,
    setAttribute: (n, v) => {
      a.attrs[n] = v;
    },
    closest: () => a,
  };
  return a;
};
const click = (a: FakeA, extra: Record<string, unknown> = {}) => ({
  type: "click",
  target: a,
  button: 0,
  composedPath: () => [a],
  ...extra,
});

describe("external links: the delegated click", () => {
  it("catches a link to another site, in the same tab or a new one", () => {
    const a = link({ href: "https://youtube.com/watch?v=1" });
    expect(leavingClick(click(a), HERE, ASK)).toMatchObject({
      ask: "youtube.com",
      newTab: false,
      href: "https://youtube.com/watch?v=1",
    });
    const b = link({ href: "https://youtube.com/", target: "_blank" });
    expect(leavingClick(click(b), HERE, ASK)?.newTab).toBe(true);
    expect(leavingClick(click(a, { metaKey: true }), HERE, ASK)?.newTab).toBe(true);
    expect(leavingClick(click(a, { type: "auxclick", button: 1 }), HERE, ASK)?.newTab).toBe(true);
  });

  it("leaves our links, handled clicks, downloads and its own follow-through alone", () => {
    expect(leavingClick(click(link({ href: "/en/words" })), HERE, ASK)).toBeNull();
    expect(leavingClick(click(link({ href: "https://lianki.com/x" })), HERE, ASK)).toBeNull();
    const ext = link({ href: "https://example.com/" });
    expect(leavingClick(click(ext, { defaultPrevented: true }), HERE, ASK)).toBeNull();
    expect(leavingClick(click(ext, { button: 2 }), HERE, ASK)).toBeNull();
    expect(
      leavingClick(click(link({ href: "https://example.com/", download: "" })), HERE, ASK),
    ).toBeNull();
    expect(
      leavingClick(click(link({ href: "https://example.com/", "data-lk-ext-ok": "" })), HERE, ASK),
    ).toBeNull();
  });

  it("goes without asking when bypassed, and still drops the opener and referrer", () => {
    const a = link({ href: "https://example.com/", rel: "external" });
    const hit = leavingClick(click(a), HERE, { confirm: false, hosts: [] });
    expect(hit?.ask).toBeNull();
    guardRel(hit!.anchor);
    expect(a.attrs.rel).toBe("external noopener noreferrer");
  });
});
