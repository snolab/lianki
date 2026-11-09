/**
 * Li chat from the userscript pill (docs/userscript-li-chat.md): the per-site
 * trust store, the gate's rules, the open path with fakes (no network before
 * allow, page realm, kill switch, a navigated frame), the dialogs' refusal of
 * untrusted clicks, and the flag route. A hostile page in a real browser is
 * scripts/qa/qa-pill-chat.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Window } from "happy-dom";
import { pillChatState } from "@/lib/pill-chat-route";
import { mirrorPillChatFlag, pillChat, type PillChatDeps } from "@/src/pill-chat";
import { PILL_CHAT_LOCALES, PILL_CHAT_STRINGS, pillChatLang } from "@/src/pill-chat-strings";
import {
  LICHAT_SITES_KEY,
  PILLCHAT_ON_KEY,
  allowedHere,
  applyChoice,
  flagMirrorOn,
  flagRecheckDue,
  parseSites,
  pillEntry,
  siteKey,
  trustStore,
  type TrustChoice,
} from "@/src/pill-chat-trust";
import { blockedNote, sitesDialog, trustDialog } from "@/src/pill-chat-ui";

const ORIGIN = "https://lianki.com";
const ISOLATED = { injectInto: "content" };
const PAGE_REALM = { injectInto: "page" };

function gm(init: Record<string, unknown> = {}) {
  const m = new Map<string, unknown>(Object.entries(init));
  return {
    m,
    getValue: (k: string, d?: unknown) => (m.has(k) ? m.get(k) : d),
    setValue: (k: string, v: unknown) => void m.set(k, v),
  };
}

describe("trust store", () => {
  it("keeps only valid hosts and exact values; junk is dropped, never trusted", () => {
    expect(parseSites("not json")).toEqual({});
    expect(parseSites("[1,2]")).toEqual({});
    expect(
      parseSites(
        JSON.stringify({
          "example.com": "allow",
          "evil.com": "yes",
          "Bad Host": "allow",
          "a..b": "never",
          "news.example.org": "never",
          __proto__: "allow",
        }),
      ),
    ).toEqual({ "example.com": "allow", "news.example.org": "never" });
  });

  it("keys by the exact lowercase hostname: no www folding, no port", () => {
    expect(siteKey("Example.COM")).toBe("example.com");
    expect(siteKey("www.example.com")).toBe("www.example.com");
    expect(siteKey("")).toBeNull();
    expect(siteKey("exa mple.com")).toBeNull();
  });

  it("set, forget and list read GM storage fresh each time", () => {
    const g = gm();
    const s = trustStore(g);
    s.set("b.com", "never");
    s.set("A.com", "allow");
    expect(s.list()).toEqual([
      ["a.com", "allow"],
      ["b.com", "never"],
    ]);
    // Another tab writes: seen at once.
    g.setValue(LICHAT_SITES_KEY, JSON.stringify({ "c.com": "allow" }));
    expect(s.decision("c.com")).toBe("allow");
    expect(s.decision("a.com")).toBeNull();
    s.forget("c.com");
    expect(s.list()).toEqual([]);
    expect(s.decision("www.c.com")).toBeNull();
  });
});

describe("the gate's rules", () => {
  it("once is memory only; always and never are stored; dismiss stores nothing and denies", () => {
    const g = gm();
    const s = trustStore(g);
    const once = new Set<string>();
    expect(applyChoice(s, once, "a.com", "dismiss")).toBe(false);
    expect(g.m.has(LICHAT_SITES_KEY)).toBe(false);
    expect(allowedHere(s, once, "a.com")).toBe(false);
    expect(applyChoice(s, once, "a.com", "once")).toBe(true);
    expect(allowedHere(s, once, "a.com")).toBe(true);
    expect(allowedHere(s, new Set(), "a.com")).toBe(false); // next page load asks again
    expect(g.m.has(LICHAT_SITES_KEY)).toBe(false);
    expect(applyChoice(s, once, "b.com", "always")).toBe(true);
    expect(allowedHere(s, new Set(), "b.com")).toBe(true);
    expect(applyChoice(s, once, "a.com", "never")).toBe(false);
    expect(allowedHere(s, once, "a.com")).toBe(false); // never beats an earlier once
  });

  it("the entry: hidden without the flag, in a frame, or on a never site; a note in the page realm", () => {
    const base = { flagOn: true, top: true, isolated: true, decision: null, host: "a.com" };
    expect(pillEntry(base)).toBe("show");
    expect(pillEntry({ ...base, flagOn: false })).toBe("hidden");
    expect(pillEntry({ ...base, top: false })).toBe("hidden");
    expect(pillEntry({ ...base, decision: "never" })).toBe("hidden");
    expect(pillEntry({ ...base, host: null })).toBe("hidden");
    expect(pillEntry({ ...base, isolated: false })).toBe("note");
    expect(pillEntry({ ...base, decision: "allow" })).toBe("show");
  });

  it("the flag mirror: only {on: true} is on; rechecked after a minute", () => {
    expect(flagMirrorOn(null)).toBe(false);
    expect(flagMirrorOn('{"on":"true"}')).toBe(false);
    expect(flagMirrorOn('{"on":true,"at":1}')).toBe(true);
    expect(flagMirrorOn({ on: true })).toBe(true);
    expect(flagRecheckDue(null, 1000)).toBe(true);
    expect(flagRecheckDue('{"on":true,"at":1000}', 30_000)).toBe(false);
    expect(flagRecheckDue('{"on":true,"at":1000}', 61_000)).toBe(true);
    expect(flagRecheckDue('{"on":true,"at":99999}', 1000)).toBe(true); // a clock from the future
  });
});

describe("strings", () => {
  it("16 locales, every key filled, {host} kept", () => {
    expect(PILL_CHAT_LOCALES.length).toBe(16);
    const keys = Object.keys(PILL_CHAT_STRINGS.en);
    for (const l of PILL_CHAT_LOCALES) {
      expect(Object.keys(PILL_CHAT_STRINGS[l]).sort()).toEqual([...keys].sort());
      for (const k of keys)
        expect((PILL_CHAT_STRINGS[l] as Record<string, string>)[k]).toBeTruthy();
      expect(PILL_CHAT_STRINGS[l].promptTitle).toContain("{host}");
    }
    expect(pillChatLang("zh-CN")).toBe("zh");
    expect(pillChatLang("pt_BR")).toBe("pt");
    expect(pillChatLang("xx")).toBe("en");
  });
});

// ── the open path, with fakes ────────────────────────────────────────────────

type Call = { url: string; method?: string };
function harness(opts: {
  info?: unknown;
  flag?: boolean;
  server?: boolean;
  sites?: Record<string, string>;
  choice?: TrustChoice;
  top?: boolean;
  frameResult?: "ready" | "blocked";
  fetchFail?: "throw" | "status";
}) {
  const g = gm({
    ...(opts.flag === false ? {} : { [PILLCHAT_ON_KEY]: JSON.stringify({ on: true, at: 1 }) }),
    ...(opts.sites ? { [LICHAT_SITES_KEY]: JSON.stringify(opts.sites) } : {}),
  });
  const calls: Call[] = [];
  const prompts: string[] = [];
  const frames: {
    label: string;
    destroyed: boolean;
    ticket: () => Promise<string | null>;
    loads: (() => void)[];
  }[] = [];
  const win = new Window();
  const doc = win.document as unknown as Document;
  const d: PillChatDeps = {
    origin: ORIGIN,
    hostname: "News.Example.com",
    path: "/story/1",
    top: opts.top ?? true,
    doc,
    win: win as unknown as PillChatDeps["win"],
    info: opts.info ?? ISOLATED,
    getValue: g.getValue,
    setValue: g.setValue,
    gmFetch: async (url: string, o?: { method?: string }) => {
      calls.push({ url, method: o?.method });
      if (opts.fetchFail === "throw") throw new Error("network");
      if (opts.fetchFail === "status" && !url.endsWith("/api/ext/pill-chat"))
        return { ok: false, status: 404, json: async () => ({}) };
      if (url.endsWith("/api/ext/pill-chat"))
        return { ok: true, status: 200, json: async () => ({ on: opts.server ?? true }) };
      return { ok: true, status: 200, json: async () => ({ ticket: "TK-1" }) };
    },
    prompt: async (h: string) => {
      prompts.push(h);
      return opts.choice ?? "dismiss";
    },
    frame: ((f: {
      label: string;
      ticket: () => Promise<string | null>;
      pos?: { get(): unknown; set(p: { x: number; y: number }): void };
    }) => {
      const rec = {
        pos: f.pos,
        label: f.label,
        destroyed: false,
        ticket: f.ticket,
        loads: [] as (() => void)[],
      };
      frames.push(rec);
      return {
        result: Promise.resolve(opts.frameResult ?? "ready"),
        iframe: { addEventListener: (_: string, fn: () => void) => rec.loads.push(fn) },
        host: {},
        destroy: () => void (rec.destroyed = true),
      };
    }) as never,
  };
  return { g, calls, prompts, frames, d, doc, win, pc: pillChat(d) };
}

describe("opening Li from the pill", () => {
  it("flag off for this account: no entry, no prompt, no request", async () => {
    const h = harness({ flag: false });
    expect(h.pc.entry()).toBe("hidden");
    expect(await h.pc.open()).toBe("hidden");
    expect(h.prompts).toEqual([]);
    expect(h.calls).toEqual([]);
    expect(h.pc.flagOn()).toBe(false);
  });

  it("not the top window: hidden", async () => {
    const h = harness({ top: false });
    expect(h.pc.entry()).toBe("hidden");
    expect(await h.pc.open()).toBe("hidden");
    expect(h.calls).toEqual([]);
  });

  it("default deny: a dismissed prompt sends nothing to lianki.com and stores nothing", async () => {
    const h = harness({ choice: "dismiss" });
    expect(await h.pc.open()).toBe("denied");
    expect(h.prompts).toEqual(["news.example.com"]);
    expect(h.calls).toEqual([]);
    expect(h.frames).toEqual([]);
    expect(h.g.m.has(LICHAT_SITES_KEY)).toBe(false);
    expect(h.pc.entry()).toBe("show"); // asks again next tap
  });

  it("never: stored, the entry hides, nothing fetched", async () => {
    const h = harness({ choice: "never" });
    expect(await h.pc.open()).toBe("never");
    expect(h.calls).toEqual([]);
    expect(h.pc.entry()).toBe("hidden");
    expect(await h.pc.open()).toBe("hidden");
    expect(h.prompts.length).toBe(1);
  });

  it("allow once: the flag is checked, then the frame; the ticket only when the frame asks", async () => {
    const h = harness({ choice: "once" });
    expect(await h.pc.open()).toBe("ready");
    expect(h.calls.map((c) => c.url)).toEqual([`${ORIGIN}/api/ext/pill-chat`]);
    expect(h.frames.length).toBe(1);
    // Host + path for the agent; never the query or hash.
    expect(h.frames[0].label).toBe("news.example.com/story/1");
    expect(await h.frames[0].ticket()).toBe("TK-1");
    expect(h.calls.at(-1)).toEqual({ url: `${ORIGIN}/api/debug/partner-ticket`, method: "POST" });
    // Tapping again closes it.
    expect(await h.pc.open()).toBe("closed");
    expect(h.frames[0].destroyed).toBe(true);
    // Same page load: no second prompt.
    expect(await h.pc.open()).toBe("ready");
    expect(h.prompts.length).toBe(1);
    // A new page load (a new instance on the same storage) asks again.
    const again = pillChat({ ...h.d, prompt: async () => "dismiss" });
    expect(await again.open()).toBe("denied");
  });

  it("always: stored; the next page load opens without asking", async () => {
    const h = harness({ choice: "always" });
    expect(await h.pc.open()).toBe("ready");
    const next = pillChat({
      ...h.d,
      prompt: async () => {
        throw new Error("must not ask");
      },
    });
    expect(await next.open()).toBe("ready");
  });

  it("the page realm: only the note, no prompt, no request", async () => {
    const h = harness({ info: PAGE_REALM, choice: "always" });
    expect(h.pc.entry()).toBe("note");
    expect(await h.pc.open()).toBe("note");
    expect(h.prompts).toEqual([]);
    expect(h.calls).toEqual([]);
    expect(h.frames).toEqual([]);
  });

  it("an unknown manager (no isolation word) counts as the page realm", async () => {
    const h = harness({ info: {}, choice: "always" });
    expect(await h.pc.open()).toBe("note");
    expect(h.calls).toEqual([]);
  });

  it("the kill switch: lianki.com says off → no frame, the mirror turns off", async () => {
    const h = harness({ choice: "always", server: false });
    expect(await h.pc.open()).toBe("off");
    expect(h.frames).toEqual([]);
    expect(h.pc.entry()).toBe("hidden");
  });

  it("a frame the page navigates away (a second load) is torn down", async () => {
    const h = harness({ choice: "once" });
    expect(await h.pc.open()).toBe("ready");
    h.frames[0].loads.forEach((f) => f()); // the first load: ours
    expect(h.frames[0].destroyed).toBe(false);
    h.frames[0].loads.forEach((f) => f()); // navigated
    expect(h.frames[0].destroyed).toBe(true);
    expect(h.pc.isOpen()).toBe(false);
  });

  it("blocked by the site's CSP: the frame goes, the note shows", async () => {
    const h = harness({ choice: "once", frameResult: "blocked" });
    expect(await h.pc.open()).toBe("blocked");
    expect(h.frames[0].destroyed).toBe(true);
    expect(h.doc.documentElement.children.length).toBeGreaterThan(0);
  });

  it("on lianki.com, the flag is mirrored at most once a minute", async () => {
    const g = gm();
    const calls: string[] = [];
    const deps = {
      origin: ORIGIN,
      getValue: g.getValue,
      setValue: g.setValue,
      gmFetch: async (url: string) => {
        calls.push(url);
        return { ok: true, status: 200, json: async () => ({ on: true }) };
      },
    };
    expect(await mirrorPillChatFlag({ ...deps, now: () => 10_000 })).toBe(true);
    expect(await mirrorPillChatFlag({ ...deps, now: () => 20_000 })).toBeNull();
    expect(await mirrorPillChatFlag({ ...deps, now: () => 80_000 })).toBe(true);
    expect(calls.length).toBe(2);
    expect(flagMirrorOn(g.getValue(PILLCHAT_ON_KEY))).toBe(true);
  });
});

// ── the dialogs: closed roots, trusted clicks only ───────────────────────────

describe("dialogs", () => {
  let roots: ShadowRoot[] = [];
  let orig: ((init: ShadowRootInit) => ShadowRoot) | undefined;
  let win: Window;
  beforeAll(() => {
    win = new Window();
    const proto = (win as unknown as { HTMLElement: typeof HTMLElement }).HTMLElement.prototype;
    orig = proto.attachShadow;
    proto.attachShadow = function (init: ShadowRootInit) {
      const r = orig!.call(this, init);
      roots.push(r);
      return r;
    };
  });
  afterAll(() => {
    const proto = (win as unknown as { HTMLElement: typeof HTMLElement }).HTMLElement.prototype;
    proto.attachShadow = orig!;
  });
  const click = (el: Element, trusted: boolean) => {
    const e = new (win as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent("click", {
      bubbles: true,
    });
    if (trusted) Object.defineProperty(e, "isTrusted", { value: true });
    el.dispatchEvent(e);
  };
  const buttons = (r: ShadowRoot) => [...r.querySelectorAll("button")] as HTMLButtonElement[];

  it("the prompt: a closed root on a plain div; the page's synthetic clicks do nothing", async () => {
    roots = [];
    const doc = win.document as unknown as Document;
    const strings = PILL_CHAT_STRINGS.en;
    const t = trustDialog({ doc, strings, host: "example.com" });
    const host = doc.documentElement.lastElementChild as HTMLElement;
    expect(host.localName).toBe("div");
    expect(host.shadowRoot).toBeNull(); // closed: the page cannot reach in
    const root = roots.at(-1)!;
    expect(root.textContent).toContain("Allow Li chat on example.com?");
    expect(root.textContent).toContain("Do not paste passwords");
    const [, always, once, never] = buttons(root);
    expect([always.textContent, once.textContent, never.textContent]).toEqual([
      strings.allowAlways,
      strings.allowOnce,
      strings.neverHere,
    ]);
    // Untrusted: el.click() and dispatchEvent from a page script.
    always.click();
    click(always, false);
    let settled: TrustChoice | null = null;
    void t.result.then((c) => (settled = c));
    await new Promise((r) => setTimeout(r, 5));
    expect(settled).toBeNull();
    click(once, true);
    expect(await t.result).toBe("once");
    expect(host.isConnected).toBe(false);
  });

  it("the prompt: × and Escape dismiss", async () => {
    roots = [];
    const doc = win.document as unknown as Document;
    const t = trustDialog({ doc, strings: PILL_CHAT_STRINGS.zh, host: "a.com" });
    const [x] = buttons(roots.at(-1)!);
    expect(x.getAttribute("aria-label")).toBe(PILL_CHAT_STRINGS.zh.notNow);
    click(x, true);
    expect(await t.result).toBe("dismiss");
  });

  it("the sites list: forget removes a decision (the revocation UI)", () => {
    roots = [];
    const doc = win.document as unknown as Document;
    const g = gm({ [LICHAT_SITES_KEY]: JSON.stringify({ "a.com": "allow", "b.com": "never" }) });
    const store = trustStore(g);
    const changed: string[] = [];
    const m = sitesDialog({
      doc,
      strings: PILL_CHAT_STRINGS.en,
      store,
      onChange: (h) => changed.push(h),
    });
    const root = roots.at(-1)!;
    expect(root.textContent).toContain("a.com");
    expect(root.textContent).toContain("Never");
    const forgetB = buttons(root).find((b) => b.getAttribute("aria-label") === "Forget: b.com")!;
    click(forgetB, false); // the page cannot revoke for him either
    expect(store.decision("b.com")).toBe("never");
    click(forgetB, true);
    expect(store.decision("b.com")).toBeNull();
    expect(changed).toEqual(["b.com"]);
    expect(root.textContent).not.toContain("b.com");
    m.remove();
  });
});

// ── the flag route ───────────────────────────────────────────────────────────

describe("GET /api/ext/pill-chat", () => {
  const req = () => new Request("https://lianki.com/api/ext/pill-chat");
  const deps = (o: { flag: boolean; email: string | null; owner: boolean }) => ({
    backend: () => "d1" as const,
    d1: () => ({}) as never,
    sessionEmail: async () => o.email,
    isOwner: async () => o.owner,
    flags: async () => ({ "ext.pill-chat": o.flag }),
  });
  const on = async (r: Response) => ((await r.json()) as { on: boolean }).on;

  it("on only with the flag on and the owner signed in; never cached", async () => {
    const r = await pillChatState(req(), deps({ flag: true, email: "o@x", owner: true }));
    expect(await on(r)).toBe(true);
    expect(r.headers.get("cache-control")).toContain("no-store");
    expect(
      await on(await pillChatState(req(), deps({ flag: false, email: "o@x", owner: true }))),
    ).toBe(false);
    expect(
      await on(await pillChatState(req(), deps({ flag: true, email: "u@x", owner: false }))),
    ).toBe(false);
    expect(
      await on(await pillChatState(req(), deps({ flag: true, email: null, owner: true }))),
    ).toBe(false);
  });
});

describe("opening Li: edges", () => {
  it("the frame's position is kept per device; junk reads as none", async () => {
    const h = harness({ choice: "once" });
    expect(await h.pc.open()).toBe("ready");
    const pos = (h.frames[0] as unknown as { pos: { get(): unknown; set(p: object): void } }).pos;
    expect(pos.get()).toBeNull();
    pos.set({ x: 10.4, y: -3.6 });
    expect(pos.get()).toEqual({ x: 10, y: -4 });
    h.g.setValue("lianki_partner_pos", { x: "a", y: 1 });
    expect(pos.get()).toBeNull();
  });

  it("lianki.com unreachable: off, no frame", async () => {
    const h = harness({ choice: "always", fetchFail: "throw" });
    expect(await h.pc.open()).toBe("off");
    expect(h.frames).toEqual([]);
  });

  it("no ticket for this account: the frame gets null", async () => {
    const h = harness({ choice: "once", fetchFail: "status" });
    expect(await h.pc.open()).toBe("ready");
    expect(await h.frames[0].ticket()).toBeNull();
  });

  it("a ticket request that throws: null", async () => {
    const h = harness({ choice: "once" });
    expect(await h.pc.open()).toBe("ready");
    h.d.gmFetch = async () => {
      throw new Error("x");
    };
    expect(await h.frames[0].ticket()).toBeNull();
  });

  it("a load after he closed it: that frame is destroyed, nothing else", async () => {
    const h = harness({ choice: "once" });
    expect(await h.pc.open()).toBe("ready");
    expect(await h.pc.open()).toBe("closed");
    h.frames[0].destroyed = false;
    h.frames[0].loads.forEach((f) => f());
    h.frames[0].loads.forEach((f) => f());
    expect(h.frames[0].destroyed).toBe(true);
  });

  it("the page realm note twice replaces the first; the sites list opens from manage()", async () => {
    const h = harness({ info: PAGE_REALM });
    expect(await h.pc.open()).toBe("note");
    expect(await h.pc.open()).toBe("note");
    h.pc.close();
    const m = h.pc.manage();
    m.remove();
    await m.closed;
  });
});

describe("dialogs: theme, keys, the blocked note", () => {
  const darkWin = (dark: boolean | "throw") => {
    const w = new Window();
    (w as unknown as { matchMedia: unknown }).matchMedia = () => {
      if (dark === "throw") throw new Error("no");
      return { matches: dark };
    };
    return w;
  };
  const ev = (w: Window, type: string, init: object, trusted = true) => {
    const C =
      type === "keydown"
        ? (w as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent
        : type === "click"
          ? (w as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent
          : (w as unknown as { FocusEvent: typeof FocusEvent }).FocusEvent;
    const e = new C(type, { bubbles: true, ...init });
    if (trusted) Object.defineProperty(e, "isTrusted", { value: true });
    return e;
  };

  it("dark mode, Escape on the host, focus rings, scrim click, remove()", async () => {
    const w = darkWin(true);
    const doc = w.document as unknown as Document;
    const t = trustDialog({ doc, win: w as never, strings: PILL_CHAT_STRINGS.en, host: "a.com" });
    const host = doc.documentElement.lastElementChild as HTMLElement;
    host.dispatchEvent(ev(w, "keydown", { key: "a" }));
    host.dispatchEvent(ev(w, "keydown", { key: "Escape" }));
    expect(await t.result).toBe("dismiss");

    const t2 = trustDialog({
      doc,
      win: darkWin("throw") as never,
      strings: PILL_CHAT_STRINGS.en,
      host: "b.com",
    });
    t2.remove();
    expect(await t2.result).toBe("dismiss");
  });

  it("buttons: focus and blur; the scrim dismisses only on itself", async () => {
    const w = darkWin(false);
    const roots: ShadowRoot[] = [];
    const proto = (w as unknown as { HTMLElement: typeof HTMLElement }).HTMLElement.prototype;
    const orig = proto.attachShadow;
    proto.attachShadow = function (init: ShadowRootInit) {
      const r = orig.call(this, init);
      roots.push(r);
      return r;
    };
    const doc = w.document as unknown as Document;
    const t = trustDialog({ doc, win: w as never, strings: PILL_CHAT_STRINGS.en, host: "a.com" });
    const root = roots.at(-1)!;
    const b = root.querySelector("button")!;
    b.dispatchEvent(ev(w, "focus", {}, false));
    b.dispatchEvent(ev(w, "blur", {}, false));
    const scrim = root.firstElementChild as HTMLElement;
    const panel = scrim.firstElementChild as HTMLElement;
    panel.dispatchEvent(ev(w, "click", {}));
    scrim.dispatchEvent(ev(w, "click", {}, false));
    scrim.dispatchEvent(ev(w, "click", {}));
    expect(await t.result).toBe("dismiss");

    // The sites list, empty; and the blocked note with its ×.
    const m = sitesDialog({
      doc,
      win: w as never,
      strings: PILL_CHAT_STRINGS.en,
      store: trustStore(gm()),
    });
    expect(roots.at(-1)!.textContent).toContain("No sites yet.");
    m.remove();
    const remove = blockedNote({
      doc,
      win: w as never,
      strings: PILL_CHAT_STRINGS.en,
      origin: ORIGIN,
    });
    const nr = roots.at(-1)!;
    expect(nr.textContent).toContain("Chat on lianki.com");
    expect(nr.querySelector("a")!.getAttribute("href")).toBe(ORIGIN);
    nr.querySelector("button")!.dispatchEvent(ev(w, "click", {}));
    expect(doc.documentElement.contains(nr.host)).toBe(false);
    remove();
    proto.attachShadow = orig;
  });
});

describe("opening Li: the real prompt", () => {
  it("without a prompt override the trust dialog asks; Escape denies", async () => {
    const h = harness({});
    const pc = pillChat({ ...h.d, prompt: undefined });
    const p = pc.open();
    await new Promise((r) => setTimeout(r, 0));
    const host = h.doc.documentElement.lastElementChild as HTMLElement;
    const e = new (h.win as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent(
      "keydown",
      { key: "Escape", bubbles: true },
    );
    Object.defineProperty(e, "isTrusted", { value: true });
    host.dispatchEvent(e);
    expect(await p).toBe("denied");
    expect(h.calls).toEqual([]);
  });
});
