import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  addAllowedHost,
  hostIsAllowed,
  hostToConfirm,
  isOwnHost,
  leavingHost,
  parseAllowedHosts,
  allowedHostOf,
  ALLOWED_HOSTS_BYTES,
  ALLOWED_HOSTS_MAX,
} from "@lianki/core/externalLink";
import {
  allowHost,
  followLink,
  forgetAllowedHosts,
  guardRel,
  LINK_ALLOWED_KEY,
  LINK_CONFIRM_KEY,
  LINK_POLICY_EVENT,
  leavingClick,
  openExternal,
  readLinkPolicy,
  setLeavePresenter,
  setLinkConfirm,
} from "@/lib/external-link";
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
    expect(allowedHostOf("www.YouTube.com")).toBe("youtube.com");
    expect(allowedHostOf("en.wikipedia.org")).toBe("en.wikipedia.org");
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
      expect(allowedHostOf(h)).toBeNull();
  });

  it("matches the site and its subdomains, not look-alikes", () => {
    const hosts = ["wikipedia.org", "youtube.com"];
    expect(hostIsAllowed("wikipedia.org", hosts)).toBe(true);
    expect(hostIsAllowed("ja.wikipedia.org", hosts)).toBe(true);
    expect(hostIsAllowed("www.youtube.com", hosts)).toBe(true);
    expect(hostIsAllowed("notwikipedia.org", hosts)).toBe(false);
    expect(hostIsAllowed("youtube.com.evil.io", hosts)).toBe(false);
  });

  it("adds at the end without duplicates, dropping the oldest over the caps", () => {
    expect(addAllowedHost(["a.com", "b.com"], "www.a.com")).toEqual(["b.com", "a.com"]);
    expect(addAllowedHost(["a.com"], "localhost")).toEqual(["a.com"]);
    let list: string[] = [];
    for (let i = 0; i < 200; i++) list = addAllowedHost(list, `site-number-${i}.example.com`);
    expect(list.length).toBeLessThanOrEqual(ALLOWED_HOSTS_MAX);
    expect(JSON.stringify(list).length).toBeLessThanOrEqual(ALLOWED_HOSTS_BYTES);
    expect(list.at(-1)).toBe("site-number-199.example.com");
    expect(checkPref("links.allowedHosts", list)).toEqual(list);
  });

  it("a stored list is cleaned on read", () => {
    expect(parseAllowedHosts(["a.com", "a.com", "x.ts.net", 3, "b.org"])).toEqual([
      "a.com",
      "b.org",
    ]);
    expect(parseAllowedHosts("a.com")).toEqual([]);
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
    expect(checkPref("links.allowedHosts", ["youtube.com"])).toEqual(["youtube.com"]);
    for (const bad of [
      "www.youtube.com",
      "https://youtube.com",
      "a.ts.net",
      "localhost",
      "10.0.0.1",
    ])
      expect(checkPref("links.allowedHosts", [bad])).toBeUndefined();
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

  it("finds a link through closest() when there is no composed path", () => {
    const a = {
      tagName: "A",
      getAttribute: (n: string) => (n === "href" ? "https://example.com/" : null),
      hasAttribute: (n: string) => n === "href",
    };
    const span = { tagName: "SPAN", closest: () => a };
    expect(leavingClick({ target: span }, HERE, ASK)?.ask).toBe("example.com");
    expect(leavingClick({ target: { closest: () => null } }, HERE, ASK)).toBeNull();
  });
});

describe("external links: on the device", () => {
  const g = globalThis as unknown as Record<string, unknown>;
  const saved: Record<string, unknown> = {};
  let store: Map<string, string>;
  let events: string[];
  let clicked: { href: string; rel: string; target: string; ok: boolean }[];
  let opened: unknown[][];
  let broken: boolean;
  beforeEach(() => {
    for (const k of ["localStorage", "window", "document"]) saved[k] = g[k];
    store = new Map();
    events = [];
    clicked = [];
    opened = [];
    broken = false;
    g.localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    g.window = {
      location: { href: HERE, assign: (u: string) => opened.push(["assign", u]) },
      dispatchEvent: (e: Event) => void events.push(e.type),
      open: (...a: unknown[]) => void opened.push(a),
    };
    g.document = {
      body: { appendChild: () => {} },
      createElement: () => {
        if (broken) throw new Error("no DOM");
        const a = {
          href: "",
          rel: "",
          target: "",
          dataset: {} as Record<string, string>,
          style: {},
        };
        return Object.assign(a, {
          click: () =>
            clicked.push({
              href: a.href,
              rel: a.rel,
              target: a.target,
              ok: "lkExtOk" in a.dataset,
            }),
          remove: () => {},
        });
      },
    };
  });
  afterEach(() => {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete g[k];
      else g[k] = saved[k];
    }
  });

  it("reads asking as on, with no sites, when nothing is stored or it is garbage", () => {
    expect(readLinkPolicy()).toEqual({ confirm: true, hosts: [] });
    store.set(LINK_ALLOWED_KEY, "{not json");
    expect(readLinkPolicy()).toEqual({ confirm: true, hosts: [] });
  });

  it("writes both settings where the prefs sync reads them, and tells the page", () => {
    setLinkConfirm(false);
    expect(store.get(LINK_CONFIRM_KEY)).toBe("0");
    expect(readLinkPolicy().confirm).toBe(false);
    setLinkConfirm(true);
    expect(store.get(LINK_CONFIRM_KEY)).toBe("1");
    allowHost("www.youtube.com");
    allowHost("en.wikipedia.org");
    allowHost("localhost");
    expect(JSON.parse(store.get(LINK_ALLOWED_KEY)!)).toEqual(["youtube.com", "en.wikipedia.org"]);
    forgetAllowedHosts(["youtube.com"]);
    expect(readLinkPolicy().hosts).toEqual(["en.wikipedia.org"]);
    forgetAllowedHosts();
    expect(readLinkPolicy().hosts).toEqual([]);
    expect(events.filter((e) => e === LINK_POLICY_EVENT).length).toBe(7);
  });

  it("follows a link without opener or referrer, in this tab or a new one", () => {
    followLink("https://example.com/a", false);
    followLink("https://example.com/b", true);
    expect(clicked).toEqual([
      { href: "https://example.com/a", rel: "noopener noreferrer", target: "", ok: true },
      { href: "https://example.com/b", rel: "noopener noreferrer", target: "_blank", ok: true },
    ]);
    broken = true;
    followLink("https://example.com/c", true);
    followLink("https://example.com/d", false);
    expect(opened).toEqual([
      ["https://example.com/c", "_blank", "noopener,noreferrer"],
      ["assign", "https://example.com/d"],
    ]);
  });

  it("openExternal asks through the mounted guard, else goes at once", () => {
    openExternal("https://example.com/x");
    expect(clicked.length).toBe(1);
    const asked: unknown[] = [];
    const off = setLeavePresenter((r) => asked.push(r));
    openExternal("https://example.com/y", { newTab: false });
    expect(asked).toEqual([{ host: "example.com", href: "https://example.com/y", newTab: false }]);
    allowHost("example.com");
    openExternal("https://example.com/z");
    expect(clicked.length).toBe(2);
    off();
    off();
    store.delete(LINK_ALLOWED_KEY);
    openExternal("https://example.org/");
    expect(asked.length).toBe(1);
    expect(clicked.length).toBe(3);
  });
});
