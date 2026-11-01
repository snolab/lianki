/**
 * The Learning Partner on other sites (docs/dev-debug-widget.md, "On every
 * site"): style isolation, key isolation, when it may run, its socket, the
 * userscript's side, and the build's shims. The real-browser check against a
 * hostile page is scripts/qa/qa-partner-embed.mjs.
 */
import { describe, expect, it } from "bun:test";
import {
  FONT_STACK,
  GUARDED_KEYS,
  HOST_STYLE,
  HOST_TAG,
  applyHostStyle,
  attachStyles,
  baseCss,
  createShadowHost,
  dropGlobalRules,
  guardKeys,
  isolateCss,
  remToPx,
  rootToHost,
} from "@lianki/debug-chat/embed/isolation";
import {
  blockerText,
  cspBlocker,
  isolatedWorld,
  partnerWanted,
} from "@lianki/debug-chat/embed/guard";
import {
  PARTNER_SUBPROTOCOL,
  createPartnerClient,
  pageLabel,
} from "@lianki/debug-chat/embed/partner-client";
import { EMBED_NAME, EMBED_STRINGS, embedLang } from "@lianki/debug-chat/ui-strings";
import {
  PARTNER_HIDDEN_KEY,
  NOOP,
  PARTNER_ON_KEY,
  mirrorPartnerSwitch,
  pageRealmNote,
  startPartner,
} from "@/src/partner";
import {
  cleanClientId,
  cleanErrorReport,
  isPublicRequest,
  pruneClients,
  readCapped,
} from "@/scripts/dev-loader-render";
import {
  PROLOGUE,
  SHADOWED,
  appCss,
  buildPartner,
  rewriteGlobals,
} from "@/scripts/build-partner-embed";

// ── a minimal DOM: just what isolation.ts touches ────────────────────────────

type Listener = (e: { stopPropagation(): void; type: string }) => void;
class FakeTarget {
  listeners = new Map<string, Set<Listener>>();
  addEventListener(t: string, f: Listener) {
    if (!this.listeners.has(t)) this.listeners.set(t, new Set());
    this.listeners.get(t)!.add(f);
  }
  removeEventListener(t: string, f: Listener) {
    this.listeners.get(t)?.delete(f);
  }
  /** Bubble from this node: returns whether propagation was stopped here. */
  fire(type: string) {
    let stopped = false;
    for (const f of this.listeners.get(type) ?? [])
      f({ type, stopPropagation: () => (stopped = true) });
    return stopped;
  }
}
class FakeEl extends FakeTarget {
  children: FakeEl[] = [];
  className = "";
  textContent = "";
  sheet: unknown = {};
  props = new Map<string, [string, string]>();
  shadowMode?: string;
  shadow?: FakeRoot;
  parent?: FakeEl;
  style = {
    setProperty: (k: string, v: string, p: string) => this.props.set(k, [v, p]),
  };
  constructor(
    public tag: string,
    public ownerDocument: FakeDoc,
  ) {
    super();
  }
  append(...els: FakeEl[]) {
    for (const e of els) {
      e.parent = this;
      this.children.push(e);
    }
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
  }
  attrs = new Map<string, string>();
  setAttribute(k: string, v: string) {
    this.attrs.set(k, v);
  }
  attachShadow(o: { mode: string }) {
    this.shadowMode = o.mode;
    this.shadow = new FakeRoot(this.ownerDocument);
    return this.shadow;
  }
}
class FakeRoot extends FakeEl {
  adoptedStyleSheets: unknown[] = [];
  constructor(doc: FakeDoc) {
    super("#shadow-root", doc);
  }
  querySelectorAll(sel: string) {
    return this.children.filter((c) => c.tag === sel);
  }
}
class FakeSheet {
  text = "";
  replaceSync(t: string) {
    this.text = t;
  }
}
class FakeDoc {
  documentElement: FakeEl;
  defaultView: { CSSStyleSheet?: unknown };
  constructor(withSheets = true) {
    this.documentElement = new FakeEl("html", this);
    this.defaultView = withSheets ? { CSSStyleSheet: FakeSheet } : {};
  }
  createElement(tag: string) {
    return new FakeEl(tag, this);
  }
}
const asDoc = (d: FakeDoc) => d as unknown as Document;
const asRoot = (r: FakeRoot) => r as unknown as ShadowRoot;

describe("style isolation helpers", () => {
  it("turns every rem into px at 16px, calc() and negatives included", () => {
    expect(remToPx("a{padding:.5rem 1rem;margin:-0.25rem;width:calc(100vw - 1.5rem)}")).toBe(
      "a{padding:8px 16px;margin:-4px;width:calc(100vw - 24px)}",
    );
    expect(remToPx("b{x:0.3333rem}")).toBe("b{x:5.3328px}");
    expect(remToPx("c{line-height:1.5;font-size:2em}")).toBe("c{line-height:1.5;font-size:2em}");
  });

  it("moves :root, html and body rules onto the host", () => {
    expect(rootToHost(":root{--a:1}")).toBe(":host{--a:1}");
    expect(rootToHost(":root, :host{--a:1}")).toBe(":host{--a:1}");
    expect(rootToHost("html{color:red}\nbody{margin:0}")).toBe(":host{color:red}\n:host{margin:0}");
    expect(rootToHost(".html-ish{x:1}")).toBe(".html-ish{x:1}");
  });

  it("drops what would leak out or is ignored in a shadow root", () => {
    const css =
      '@import "x.css";@font-face{font-family:Evil;src:url(a.woff)}@property --tw-x{syntax:"*";inherits:false}.a{color:red}';
    expect(dropGlobalRules(css)).toBe(".a{color:red}");
    expect(isolateCss(":root{--s:.25rem}@font-face{font-family:X}")).toBe(":host{--s:4px}");
  });

  it("the base resets the host and starts from the font stack, in px, unspoofable first", () => {
    const b = baseCss();
    expect(b).toContain(":host{all:initial!important");
    expect(b).toContain(`font-family:${FONT_STACK}`);
    expect(b).toContain("font-size:14px");
    expect(b).not.toMatch(/\drem/);
    expect(FONT_STACK.startsWith("system-ui,")).toBe(true);
    expect(b).not.toContain("@font-face");
  });

  it("styles the host inline, every declaration important (beats `* { all: unset !important }`)", () => {
    const el = new FakeEl("x", new FakeDoc());
    applyHostStyle(el as unknown as HTMLElement);
    expect(el.props.size).toBe(HOST_STYLE.length);
    for (const [, [, prio]] of el.props) expect(prio).toBe("important");
    expect(el.props.get("all")?.[0]).toBe("initial");
    expect(el.props.get("z-index")?.[0]).toBe("2147483647");
  });

  it("adopts constructed sheets where it can, else <style> inside the root, and says if blocked", () => {
    const d = new FakeDoc();
    const r = new FakeRoot(d);
    expect(attachStyles(asRoot(r), ["a{}", "b{}"])).toBe("adopted");
    expect((r.adoptedStyleSheets as FakeSheet[]).map((s) => s.text)).toEqual(["a{}", "b{}"]);
    expect(r.children).toEqual([]);

    const old = new FakeDoc(false);
    const r2 = new FakeRoot(old);
    delete (r2 as { adoptedStyleSheets?: unknown }).adoptedStyleSheets;
    const g = globalThis as { CSSStyleSheet?: unknown };
    const had = g.CSSStyleSheet;
    g.CSSStyleSheet = undefined;
    try {
      expect(attachStyles(asRoot(r2), ["a{}"])).toBe("style");
      expect(r2.children.map((c) => [c.tag, c.textContent])).toEqual([["style", "a{}"]]);
      // A strict style-src leaves the <style> without a sheet.
      const r3 = new FakeRoot(old);
      delete (r3 as { adoptedStyleSheets?: unknown }).adoptedStyleSheets;
      const blocked = r3.append.bind(r3);
      r3.append = (...els: FakeEl[]) => {
        for (const e of els) e.sheet = null;
        blocked(...els);
      };
      expect(attachStyles(asRoot(r3), ["a{}"])).toBe("blocked");
    } finally {
      g.CSSStyleSheet = had;
    }
  });

  it("a throwing constructed sheet falls back to <style>", () => {
    const d = new FakeDoc();
    d.defaultView.CSSStyleSheet = class extends FakeSheet {
      replaceSync() {
        throw new Error("nope");
      }
    };
    const r = new FakeRoot(d);
    expect(attachStyles(asRoot(r), ["a{}"])).toBe("style");
  });
});

describe("key isolation", () => {
  it("stops keys at the shadow root, and stops nothing once removed", () => {
    const r = new FakeRoot(new FakeDoc());
    const off = guardKeys(asRoot(r));
    for (const t of GUARDED_KEYS) expect(r.fire(t)).toBe(true);
    expect(r.fire("click")).toBe(false);
    off();
    for (const t of GUARDED_KEYS) expect(r.fire(t)).toBe(false);
  });

  it("never listens on the document or window: a key pressed on the page is never touched", () => {
    const d = new FakeDoc();
    const h = createShadowHost(asDoc(d), []);
    expect(d.documentElement.listeners.size).toBe(0);
    expect((d as unknown as FakeTarget).listeners).toBeUndefined();
    h.destroy();
  });
});

describe("createShadowHost", () => {
  it("one host element on <html>, a closed root, the reset first, and nothing else in the document", () => {
    const d = new FakeDoc();
    const h = createShadowHost(asDoc(d), [":root{--a:.5rem}"]);
    const host = h.host as unknown as FakeEl;
    expect(d.documentElement.children).toEqual([host]);
    expect(host.tag).toBe(HOST_TAG);
    expect(HOST_TAG).toBe("div"); // never a custom tag a page could predefine
    expect(host.shadowMode).toBe("closed");
    expect(h.styles).toBe("adopted");
    const sheets = (h.root as unknown as FakeRoot).adoptedStyleSheets as FakeSheet[];
    expect(sheets[0].text).toBe(baseCss());
    expect(sheets[1].text).toBe(":host{--a:8px}");
    expect((h.container as unknown as FakeEl).className).toBe("lk-partner-root");
    expect((h.root as unknown as FakeRoot).fire("keydown")).toBe(true);
    h.destroy();
    expect(d.documentElement.children).toEqual([]);
    expect((h.root as unknown as FakeRoot).fire("keydown")).toBe(false);
  });
});

describe("guard: when the partner may run", () => {
  it("counts only another world as isolated", () => {
    expect(isolatedWorld(undefined, { Object: class {} })).toBe(true);
    expect(isolatedWorld(undefined, { Object })).toBe(false);
    expect(isolatedWorld({ injectInto: "content" }, undefined)).toBe(true);
    expect(isolatedWorld({ injectInto: "page" }, undefined)).toBe(false);
    expect(isolatedWorld({ sandboxMode: "DOM" }, undefined)).toBe(true);
    expect(isolatedWorld({ sandboxMode: "raw" }, undefined)).toBe(false);
    expect(isolatedWorld({ sandboxMode: "js" }, { Object })).toBe(false);
    expect(isolatedWorld(undefined, undefined)).toBe(false);
    const throwing = new Proxy(
      {},
      {
        get() {
          throw new Error("cross-world");
        },
      },
    );
    expect(isolatedWorld(undefined, throwing)).toBe(true);
  });

  it("reads a CSP report about us as the right blocker, and ignores the page's own", () => {
    const o = ["https://lianki.com"];
    expect(
      cspBlocker(
        { effectiveDirective: "connect-src", blockedURI: "wss://lianki.com/api/version/debug" },
        o,
      ),
    ).toBe("connect");
    expect(
      cspBlocker({ effectiveDirective: "connect-src", blockedURI: "https://ads.example/x" }, o),
    ).toBeNull();
    expect(cspBlocker({ effectiveDirective: "style-src-elem", blockedURI: "inline" }, o)).toBe(
      "styles",
    );
    expect(cspBlocker({ violatedDirective: "script-src 'self'", blockedURI: "eval" }, o)).toBe(
      "script",
    );
    expect(
      cspBlocker(
        { effectiveDirective: "require-trusted-types-for", blockedURI: "trusted-types-sink" },
        o,
      ),
    ).toBe("script");
    expect(
      cspBlocker(
        { effectiveDirective: "img-src", blockedURI: "https://lianki.com/icon-192.png" },
        o,
      ),
    ).toBeNull();
    expect(
      cspBlocker({ effectiveDirective: "connect-src", blockedURI: "wss://lianki.com/x" }, [
        "not a url",
      ]),
    ).toBeNull();
  });

  it("fills the note with the localized name", () => {
    for (const lang of ["en", "zh", "ja"] as const)
      for (const b of ["pageRealm", "connect", "styles", "script", "load"] as const) {
        const t = blockerText(b, EMBED_STRINGS[lang], EMBED_NAME[lang]);
        expect(t).toContain(EMBED_NAME[lang]);
        expect(t).not.toContain("{name}");
      }
    expect(embedLang("zh-CN")).toBe("zh");
    expect(embedLang("ja-JP")).toBe("ja");
    expect(embedLang("en-US")).toBe("en");
  });

  it("is wanted only in the top window, switched on, and not hidden on this site", () => {
    const base = { enabled: true, hiddenHosts: ["news.example"], host: "github.com", top: true };
    expect(partnerWanted(base)).toBe(true);
    expect(partnerWanted({ ...base, enabled: false })).toBe(false);
    expect(partnerWanted({ ...base, top: false })).toBe(false);
    expect(partnerWanted({ ...base, host: "news.example" })).toBe(false);
  });
});

// ── the socket ──────────────────────────────────────────────────────────────

class FakeWs {
  static made: FakeWs[] = [];
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  closed?: number;
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  constructor(
    public url: string,
    public protocols: string[],
  ) {
    FakeWs.made.push(this);
  }
  send(d: string) {
    this.sent.push(JSON.parse(d));
  }
  close(code?: number) {
    this.closed = code;
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  hear(m: unknown) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
  drop(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

function clientSetup(tickets: (string | null)[] = ["t1", "t2", "t3", "t4"]) {
  FakeWs.made = [];
  const doc = new FakeTarget() as FakeTarget & { visibilityState: string };
  doc.visibilityState = "visible";
  let label = "github.com/a Chrome";
  const asked: number[] = [];
  const blocked: string[] = [];
  const c = createPartnerClient({
    url: "wss://lianki.com/api/version/debug",
    ticket: async () => {
      asked.push(1);
      return tickets.shift() ?? null;
    },
    open: (u, p) => new FakeWs(u, p),
    label: () => label,
    doc: doc as unknown as Document,
    onBlocked: (b) => blocked.push(b),
  });
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return {
    c,
    doc,
    flush,
    asked,
    blocked,
    setLabel: (l: string) => (label = l),
    show(v: "visible" | "hidden") {
      doc.visibilityState = v;
      doc.fire("visibilitychange");
    },
  };
}

describe("partner client: the ticket socket", () => {
  it("offers the ticket in the subprotocol list, never in the URL", async () => {
    const { flush } = clientSetup();
    await flush();
    const ws = FakeWs.made[0];
    expect(ws.protocols).toEqual([PARTNER_SUBPROTOCOL, "t1"]);
    expect(ws.url).toBe("wss://lianki.com/api/version/debug?label=github.com%2Fa%20Chrome");
    expect(ws.url).not.toContain("t1");
  });

  it("takes history, chat, edits, the viewer, state and busy; ignores eval and the rest", async () => {
    const { c, flush } = clientSetup();
    await flush();
    const ws = FakeWs.made[0];
    let changes = 0;
    const off = c.subscribe(() => changes++);
    ws.open();
    expect(c.get().live).toBe(true);
    ws.hear({
      type: "history",
      messages: [{ id: "a", from: "owner", text: "hi", at: 1, label: "x" }],
    });
    ws.hear({ type: "me", sender: { id: "h", name: "Ada" } });
    ws.hear({ type: "state", listeners: 2, pending: null, sessions: [] });
    ws.hear({ type: "busy", at: 5, label: "agent" });
    expect(c.get().busy).toEqual({ label: "agent" });
    ws.hear({
      type: "chat",
      message: { id: "b", from: "agent", text: "hello", at: 2, label: "agent" },
    });
    ws.hear({
      type: "chat",
      message: { id: "b", from: "agent", text: "dup", at: 2, label: "agent" },
    });
    ws.hear({ type: "chat", message: { id: 3 } });
    ws.hear({
      type: "edited",
      id: "a",
      thread: "owner",
      text: "hi!",
      raw: "hi",
      edited: { at: 3, by: "x", count: 1 },
    });
    ws.hear({ type: "eval", id: "e", code: "document.cookie", to: "p" });
    ws.hear({ type: "rate-limited", retryIn: 1 });
    ws.onmessage?.({ data: "not json" });
    const s = c.get();
    expect(s.messages.map((m) => [m.id, m.text])).toEqual([
      ["a", "hi!"],
      ["b", "hello"],
    ]);
    expect(s.busy).toBeNull();
    expect(s.viewer).toEqual({ id: "h", name: "Ada" } as never);
    expect(s.listeners).toBe(2);
    expect(s.warning).toBeTruthy();
    expect(ws.sent).toEqual([]);
    expect(changes).toBeGreaterThan(5);
    off();
  });

  it("sends chat lines only (and the page's new place first)", async () => {
    const { c, flush, setLabel } = clientSetup();
    await flush();
    const ws = FakeWs.made[0];
    expect(c.send("too early")).toBe(false);
    ws.open();
    expect(c.send("hello", "/words")).toBe(true);
    setLabel("github.com/b Chrome");
    expect(c.send("again")).toBe(true);
    expect(ws.sent.map((m) => m.type)).toEqual(["chat", "page", "chat"]);
    expect(ws.sent[0]).toMatchObject({ type: "chat", text: "hello", to: "/words" });
    ws.send = () => {
      throw new Error("closed");
    };
    expect(c.send("x")).toBe(false);
  });

  it("reconnects with a fresh ticket after a drop, not after a hub close (4xxx)", async () => {
    const { flush, asked } = clientSetup();
    await flush();
    FakeWs.made[0].open();
    FakeWs.made[0].drop(1006);
    await flush();
    expect(FakeWs.made.length).toBe(2);
    expect(FakeWs.made[1].protocols[1]).toBe("t2");
    FakeWs.made[1].open();
    FakeWs.made[1].drop(4403);
    await flush();
    expect(FakeWs.made.length).toBe(2);
    expect(asked.length).toBe(2);
  });

  it("drops the socket after 30 s hidden, and comes back when shown", async () => {
    const { flush, show } = clientSetup();
    await flush();
    FakeWs.made[0].open();
    const realSet = globalThis.setTimeout;
    let fire: (() => void) | undefined;
    globalThis.setTimeout = ((f: () => void) => {
      fire = f;
      return 0;
    }) as unknown as typeof setTimeout;
    try {
      show("hidden");
    } finally {
      globalThis.setTimeout = realSet;
    }
    fire?.();
    expect(FakeWs.made[0].closed).toBe(1000);
    show("visible");
    await flush();
    expect(FakeWs.made.length).toBe(2);
  });

  it("no ticket (not the owner): no socket", async () => {
    const { flush } = clientSetup([null]);
    await flush();
    expect(FakeWs.made.length).toBe(0);
  });

  it("a throwing ticket fetch or socket constructor is handled; blocked stays blocked", async () => {
    FakeWs.made = [];
    const doc = Object.assign(new FakeTarget(), { visibilityState: "visible" });
    const blocked: string[] = [];
    const c = createPartnerClient({
      url: "wss://x",
      ticket: async () => "t",
      open: () => {
        throw new Error("Refused to connect: CSP");
      },
      label: () => "l",
      doc: doc as unknown as Document,
      onBlocked: (b) => blocked.push(b),
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(c.get().blocked).toBe("connect");
    c.block("styles");
    expect(c.get().blocked).toBe("connect");
    expect(blocked).toEqual(["connect"]);
    const c2 = createPartnerClient({
      url: "wss://x",
      ticket: async () => {
        throw new Error("network");
      },
      open: (u, p) => new FakeWs(u, p),
      label: () => "l",
      doc: doc as unknown as Document,
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(FakeWs.made.length).toBe(0);
    c2.stop();
    c.stop();
  });

  it("stop closes the socket and forgets its listeners", async () => {
    const { c, flush, doc } = clientSetup();
    await flush();
    FakeWs.made[0].open();
    c.stop();
    expect(FakeWs.made[0].closed).toBe(1000);
    expect(doc.listeners.get("visibilitychange")?.size).toBe(0);
    FakeWs.made[0].drop(1006); // a late close of the old socket does nothing
    await flush();
    expect(FakeWs.made.length).toBe(1);
  });

  it("labels the page with host and path only, never the query", () => {
    expect(pageLabel({ host: "github.com", pathname: "/a/b" }, "UA")).toBe("github.com/a/b UA");
    expect(pageLabel({ host: "x", pathname: "/" }, "U".repeat(400)).length).toBe(300);
  });
});

// ── the userscript's side ───────────────────────────────────────────────────

function hostDeps(o: {
  on?: boolean;
  hidden?: string[];
  ticketStatus?: number;
  code?: string;
  codeStatus?: number;
  pageWindow?: unknown;
}) {
  const store = new Map<string, unknown>([
    [PARTNER_ON_KEY, o.on ?? true],
    [PARTNER_HIDDEN_KEY, JSON.stringify(o.hidden ?? [])],
  ]);
  const calls: { url: string; opts?: Record<string, unknown> }[] = [];
  const reports: string[] = [];
  const doc = { kind: "doc" } as unknown as Document;
  return {
    store,
    calls,
    reports,
    deps: {
      origin: "https://lianki.com",
      src: "https://lianki.com/partner-embed.js",
      host: "github.com",
      top: true,
      doc,
      WebSocket: FakeWs as never,
      gmFetch: async (url: string, opts?: Record<string, unknown>) => {
        calls.push({ url, opts });
        const isTicket = url.endsWith("/partner-ticket");
        const status = isTicket ? (o.ticketStatus ?? 200) : (o.codeStatus ?? 200);
        return {
          ok: status === 200,
          status,
          json: async () => ({ ticket: `tk${calls.length}`, exp: 1 }),
          text: async () => o.code ?? "",
        };
      },
      getValue: (k: string, d?: unknown) => (store.has(k) ? store.get(k) : d),
      setValue: (k: string, v: unknown) => void store.set(k, v),
      deleteValue: (k: string) => void store.delete(k),
      listValues: () => [...store.keys()],
      info: {},
      pageWindow: o.pageWindow ?? { Object: class {} },
      report: (w: string, d: string) => void reports.push(`${w} ${d}`),
    },
  };
}

/** A stand-in for public/partner-embed.js: records what the userscript hands it. */
const FAKE_BUNDLE = `(function (gm) {
  return { css: ["a{}"], rev: "r1", api: { mountPartner: function (o) {
    globalThis.__partnerTest = { o: o, gm: gm };
    gm.set("k", "v");
    return { destroy: function () { globalThis.__partnerTest.destroyed = true; } };
  } } };
})`;
type Seen = {
  o: {
    css: string[];
    blocked?: string;
    ticket: () => Promise<string | null>;
    hide: () => void;
    doc: unknown;
    appOrigin: string;
  };
  gm: { get(k: string): unknown; del(k: string): void; keys(): string[] };
  destroyed?: boolean;
};
const seen = () => (globalThis as { __partnerTest?: Seen }).__partnerTest!;

describe("the userscript's side (src/partner.ts)", () => {
  it("mirrors lianki.com's debug switch (lk:agent, else lk:debug)", () => {
    const set = new Map<string, unknown>();
    const put = (k: string, v: unknown) => void set.set(k, v);
    mirrorPartnerSwitch({ getItem: (k) => (k === "lk:debug" ? "1" : null) }, put);
    expect(set.get(PARTNER_ON_KEY)).toBe(true);
    mirrorPartnerSwitch({ getItem: (k) => (k === "lk:agent" ? "0" : "1") }, put);
    expect(set.get(PARTNER_ON_KEY)).toBe(false);
    mirrorPartnerSwitch(
      {
        getItem: () => {
          throw new Error("denied");
        },
      },
      put,
    );
    expect(set.get(PARTNER_ON_KEY)).toBe(false);
  });

  it("off, or hidden on this site: asks nothing, downloads nothing", async () => {
    for (const o of [{ on: false }, { hidden: ["github.com"] }]) {
      const h = hostDeps(o);
      await startPartner(h.deps);
      expect(h.calls).toEqual([]);
    }
    const h = hostDeps({});
    h.store.set(PARTNER_HIDDEN_KEY, "not json");
    const stop = await startPartner({ ...h.deps, top: false });
    expect(h.calls).toEqual([]);
    expect(stop).toBe(NOOP);
    stop();
  });

  it("a ticket fetch that throws counts as no ticket", async () => {
    const h = hostDeps({});
    await startPartner({
      ...h.deps,
      gmFetch: async () => {
        throw new Error("Network error");
      },
    });
    expect(h.reports).toEqual(["partner-mode isolated github.com"]); // and nothing loaded
  });

  it("not the owner (no ticket): downloads nothing", async () => {
    const h = hostDeps({ ticketStatus: 404 });
    await startPartner(h.deps);
    expect(h.calls.map((c) => c.url)).toEqual(["https://lianki.com/api/debug/partner-ticket"]);
    expect(h.calls[0].opts).toMatchObject({
      method: "POST",
      headers: { "x-lianki-userscript": "1" },
      credentials: "include",
    });
  });

  it("the owner: mounts with the CSS, the first ticket, and storage of its own", async () => {
    const h = hostDeps({ code: FAKE_BUNDLE });
    const stop = await startPartner(h.deps);
    const s = seen();
    expect(s.o.css).toEqual(["a{}"]);
    expect(s.o.blocked).toBeUndefined();
    expect(s.o.appOrigin).toBe("https://lianki.com");
    expect(await s.o.ticket()).toBe("tk1");
    expect(await s.o.ticket()).toBe("tk3");
    // The widget's localStorage is the userscript's, namespaced.
    expect(h.store.get("lianki_partner_ls:k")).toBe("v");
    expect(s.gm.get("k")).toBe("v");
    expect(s.gm.keys()).toEqual(["k"]);
    s.gm.del("k");
    expect(h.store.has("lianki_partner_ls:k")).toBe(false);
    expect(h.reports).toEqual(["partner-mode isolated github.com"]);
    s.o.hide();
    expect(JSON.parse(String(h.store.get(PARTNER_HIDDEN_KEY)))).toEqual(["github.com"]);
    expect(s.destroyed).toBe(true);
    stop();
  });

  it("in the page's own realm: no ticket, no download, no eval, no callbacks; only our own note", async () => {
    const g = globalThis as { __partnerTest?: unknown; eval: typeof eval };
    g.__partnerTest = undefined;
    const realEval = g.eval;
    let evals = 0;
    g.eval = ((c: string) => (evals++, realEval(c))) as typeof eval;
    const h = hostDeps({ code: FAKE_BUNDLE, pageWindow: { Object } });
    const d = new FakeDoc();
    try {
      const stop = await startPartner({ ...h.deps, doc: asDoc(d) });
      expect(h.calls).toEqual([]); // not even the ticket
      expect(evals).toBe(0);
      expect(g.__partnerTest).toBeUndefined();
      expect(h.reports).toEqual(["partner-mode page-realm github.com"]);
      // The note: a plain div with a closed root, holding text, a link and ×.
      const host = d.documentElement.children[0];
      expect(host.tag).toBe("div");
      expect(host.shadowMode).toBe("closed");
      const box = host.shadow!.children[0];
      const [text, close] = box.children;
      expect(text.textContent).toContain(EMBED_NAME.en);
      expect(text.children[0].tag).toBe("a");
      expect(close.tag).toBe("button");
      close.fire("click");
      expect(JSON.parse(String(h.store.get(PARTNER_HIDDEN_KEY)))).toEqual(["github.com"]);
      expect(d.documentElement.children).toEqual([]);
      stop();
    } finally {
      g.eval = realEval;
    }
  });

  it("the page-realm note is drawn into <body> when there is no documentElement", () => {
    const d = new FakeDoc();
    const body = new FakeEl("body", d);
    (d as unknown as { documentElement: null; body: FakeEl }).documentElement = null;
    (d as unknown as { body: FakeEl }).body = body;
    const remove = pageRealmNote(asDoc(d), "https://lianki.com", () => {});
    expect(body.children.length).toBe(1);
    remove();
    expect(body.children.length).toBe(0);
  });

  it("reports a failed download, a refused eval or a broken mount, and never throws", async () => {
    const a = hostDeps({ codeStatus: 500 });
    await startPartner(a.deps);
    expect(a.reports.at(-1)).toBe("partner-load HTTP 500");
    const b = hostDeps({ code: "(" });
    await startPartner(b.deps);
    expect(b.reports.at(-1)).toMatch(/^partner-eval /);
    const c = hostDeps({
      code: "(function(){return {css:[],rev:'',api:{mountPartner:function(){throw new Error('boom')}}}})",
    });
    const stop = await startPartner(c.deps);
    expect(c.reports.at(-1)).toBe("partner-mount boom");
    stop();
  });
});

// ── the dev loader server (public: bounded, cleaned) ─────────────────────────

describe("dev loader server: what the public tunnel may see and send", () => {
  it("accepts only loader-shaped client ids", () => {
    expect(cleanClientId("abc_DEF-123")).toBe("abc_DEF-123");
    for (const bad of ["", "a".repeat(41), "id\u001b[2J", "a b", "../x", null, undefined])
      expect(cleanClientId(bad as string)).toBe("");
  });

  it("reads an /error body only up to the cap, while it streams", async () => {
    const post = (body: BodyInit | null, headers: Record<string, string> = {}) =>
      new Request("http://x/error", { method: "POST", body, headers });
    expect(await readCapped(post("hello"), 8)).toBe("hello");
    expect(await readCapped(post(null), 8)).toBe("");
    expect(await readCapped(post("x".repeat(9)), 8)).toBeNull();
    expect(await readCapped(post("x", { "content-length": "99999" }), 8)).toBeNull();
    // A stream that never ends is cut at the cap, not read to the end.
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled++;
        c.enqueue(new Uint8Array(1024));
      },
    });
    expect(await readCapped(post(endless), 8192)).toBeNull();
    expect(pulled).toBeLessThan(20);
  });

  it("keeps the client table bounded and forgets old clients", () => {
    const m = new Map<string, { last: number }>();
    for (let i = 0; i < 10; i++) m.set(`c${i}`, { last: i * 1000 });
    pruneClients(m, 10_000, 5, 7_500);
    expect([...m.keys()]).toEqual(["c5", "c6", "c7", "c8", "c9"]);
    pruneClients(m, 10_000, 3, 1e9);
    expect([...m.keys()]).toEqual(["c7", "c8", "c9"]);
  });

  it("tells tunnel requests from local ones", () => {
    expect(isPublicRequest(new Headers({ "cf-connecting-ip": "1.2.3.4" }))).toBe(true);
    expect(isPublicRequest(new Headers({ "cf-ray": "x" }))).toBe(true);
    expect(isPublicRequest(new Headers())).toBe(false);
  });

  it("cleans an error report: no terminal escapes, no query, bounded", () => {
    const r = cleanErrorReport(
      JSON.stringify({
        what: "boom\u001b[2J",
        detail: `line1\nline2\u0007${"x".repeat(5000)}`,
        page: "https://github.com/a?token=secret#frag",
      }),
      "c1\u001b;rm",
    );
    expect(r.what).toBe("boom[2J");
    expect(r.page).toBe("https://github.com/a");
    expect(r.detail.startsWith("line1\n   line2x")).toBe(true);
    expect(r.detail.length).toBeLessThan(2100);
    expect(r.id).toBe("c1rm");
    expect(cleanErrorReport("not json", "i")).toEqual({
      id: "i",
      what: "error",
      detail: "not json",
      page: "",
    });
    expect(cleanErrorReport("null", "i").what).toBe("error");
  });
});

// ── the build: what the widget's code may reach ─────────────────────────────

describe("build-partner-embed: shadowed globals", () => {
  it("rewrites window./globalThis./self. access to the shadowed names", () => {
    expect(
      rewriteGlobals(
        "window.localStorage.getItem(k); globalThis.fetch(u); self . sessionStorage; x.fetch",
      ),
    ).toBe("localStorage.getItem(k); fetch(u); sessionStorage; x.fetch");
    expect(SHADOWED).toContain("WebSocket");
  });

  it("the prologue keeps storage off the site, and refuses the network", async () => {
    const real = { ls: 0 };
    const g = globalThis as { localStorage?: unknown };
    const had = g.localStorage;
    g.localStorage = {
      setItem: () => real.ls++,
      getItem: () => null,
    };
    const gm = new Map<string, string>();
    try {
      const run = (0, eval)(`(function (gm) {${PROLOGUE}
        localStorage.setItem("lk:x", "1");
        sessionStorage.setItem("s", "2");
        var out = {
          l: localStorage.getItem("lk:x"), n: localStorage.length, k: localStorage.key(0), k9: localStorage.key(9),
          s: sessionStorage.getItem("s"), none: sessionStorage.getItem("nope"),
          media: navigator.mediaDevices, beacon: "sendBeacon" in navigator, ua: typeof navigator.userAgent,
          env: process.env.NODE_ENV,
        };
        localStorage.removeItem("lk:x");
        sessionStorage.clear();
        out.after = localStorage.getItem("lk:x"); out.sAfter = sessionStorage.length;
        try { new WebSocket("wss://x"); } catch (e) { out.ws = e.message; }
        try { new EventSource("/x"); } catch (e) { out.es = e.message; }
        try { new XMLHttpRequest(); } catch (e) { out.xhr = e.message; }
        return fetch("/api/words/tts").then(function () { out.fetch = "went"; return out; }, function (e) { out.fetch = e.message; return out; });
      })`);
      const out = await run({
        get: (k: string) => gm.get(k),
        set: (k: string, v: string) => void gm.set(k, v),
        del: (k: string) => void gm.delete(k),
        keys: () => [...gm.keys()],
      });
      expect(real.ls).toBe(0);
      expect(out).toMatchObject({
        l: "1",
        n: 1,
        k: "lk:x",
        k9: null,
        s: "2",
        none: null,
        media: undefined,
        beacon: false,
        ua: "string",
        env: "production",
        after: null,
        sAfter: 0,
      });
      for (const k of ["ws", "es", "xhr", "fetch"]) expect(out[k]).toMatch(/off on other sites/);
      // Without the userscript's storage: memory only, still never the site's.
      const mem = await (0, eval)(`(function (gm) {${PROLOGUE}
        localStorage.setItem("a", "1"); var v = [localStorage.getItem("a"), localStorage.length];
        localStorage.clear(); v.push(localStorage.length); return v; })`)(null);
      expect(mem).toEqual(["1", 1, 0]);
      expect(real.ls).toBe(0);
    } finally {
      g.localStorage = had;
    }
  });

  it("a real build: one function, its own React, no escaping storage or network access", async () => {
    const b = await buildPartner();
    expect(b.code.startsWith("(function (gm) {")).toBe(true);
    expect(b.code.trimEnd().endsWith("})")).toBe(true);
    expect(b.rev).toMatch(/^[0-9a-z]{4,8}$/);
    const body = b.code.slice(b.code.indexOf(PROLOGUE) + PROLOGUE.length);
    for (const n of SHADOWED)
      expect(body).not.toMatch(new RegExp(`\\b(?:window|globalThis|self)\\.${n}\\b`));
    expect(b.code).toContain(PROLOGUE);
    expect(b.inputs.some((p) => p.endsWith("embed/partner-embed.tsx"))).toBe(true);
    expect(b.code).toContain("mountPartner");
  }, 60_000);

  it("takes the app's colours and halo from globals.css, light and dark", () => {
    const css = appCss();
    expect(css).toContain("--background:");
    expect(css).toContain("prefers-color-scheme: dark");
    expect(css).toContain(".lk-halo");
    expect(css).not.toMatch(/#[0-9a-f]{3,6}\b|rgb\(/i);
  });
});
