import { beforeEach, describe, expect, it } from "bun:test";
import { type ClickLike, inAppLeave, installLeaveGuard, type WinLike } from "@/lib/leave-guard";
import { type DocLike, type EventLike, type FieldLike, confirmLeave } from "@/lib/page-dirty";
import { DIRTY_KEY } from "@lianki/ui-state/dirty";

const HERE = "https://lianki.com/en/words";

function link(attrs: Record<string, string>) {
  const a = { getAttribute: (n: string) => attrs[n] ?? null };
  return { closest: (s: string) => (s === "a[href]" && "href" in attrs ? a : null) };
}
function click(target: unknown, o: Partial<ClickLike> = {}) {
  const e = {
    target,
    button: 0,
    prevented: false,
    stopped: false,
    preventDefault() {
      e.prevented = true;
    },
    stopImmediatePropagation() {
      e.stopped = true;
    },
    ...o,
  };
  return e;
}

describe("inAppLeave", () => {
  it("a same-origin link to another page", () => {
    expect(inAppLeave(click(link({ href: "/en/review" })), HERE)?.pathname).toBe("/en/review");
    expect(inAppLeave(click(link({ href: "/en/words?list=3" })), HERE)?.search).toBe("?list=3");
    expect(inAppLeave(click(link({ href: "/en/review", target: "_self" })), HERE)).not.toBeNull();
  });
  it("not: a hash on this page, another site, a new tab, a download, modifier keys, no link", () => {
    expect(inAppLeave(click(link({ href: "#top" })), HERE)).toBeNull();
    expect(inAppLeave(click(link({ href: "https://example.com/" })), HERE)).toBeNull();
    expect(inAppLeave(click(link({ href: "/en/review", target: "_blank" })), HERE)).toBeNull();
    expect(inAppLeave(click(link({ href: "/x.csv", download: "" })), HERE)).toBeNull();
    for (const k of ["metaKey", "ctrlKey", "shiftKey", "altKey"] as const)
      expect(inAppLeave(click(link({ href: "/en/review" }), { [k]: true }), HERE)).toBeNull();
    expect(inAppLeave(click(link({ href: "/en/review" }), { button: 1 }), HERE)).toBeNull();
    expect(
      inAppLeave(click(link({ href: "/en/review" }), { defaultPrevented: true }), HERE),
    ).toBeNull();
    expect(inAppLeave(click(link({})), HERE)).toBeNull();
    expect(inAppLeave(click(null), HERE)).toBeNull();
    expect(inAppLeave(click(link({ href: "http://[::1" })), HERE)).toBeNull();
  });
});

type L = (e: never) => void;
function fakeWin() {
  const ls = new Map<string, Set<L>>();
  return {
    location: { href: HERE },
    addEventListener: (t: string, f: L) => {
      if (!ls.has(t)) ls.set(t, new Set());
      ls.get(t)!.add(f);
    },
    removeEventListener: (t: string, f: L) => void ls.get(t)?.delete(f),
    fire(t: string, e: unknown) {
      for (const f of [...(ls.get(t) ?? [])]) (f as (e: unknown) => void)(e);
    },
    count: (t: string) => ls.get(t)?.size ?? 0,
  } satisfies WinLike & Record<string, unknown>;
}
function fakeDoc(fields: FieldLike[]) {
  const ls = new Map<string, Set<(e: EventLike) => void>>();
  return {
    activeElement: null,
    querySelectorAll: () => fields,
    addEventListener: (t: string, f: (e: EventLike) => void) => {
      if (!ls.has(t)) ls.set(t, new Set());
      ls.get(t)!.add(f);
    },
    removeEventListener: (t: string, f: (e: EventLike) => void) => void ls.get(t)?.delete(f),
    fire(t: string, e: EventLike) {
      for (const f of [...(ls.get(t) ?? [])]) f(e);
    },
  } satisfies DocLike & Record<string, unknown>;
}
const input = (): FieldLike & { value: string } => ({
  tagName: "INPUT",
  type: "text",
  value: "",
  defaultValue: "",
  getAttribute: () => null,
});

beforeEach(() => {
  delete (globalThis as Record<string, unknown>)[DIRTY_KEY];
  delete (globalThis as Record<string, unknown>).__lkFieldEdits;
});

describe("installLeaveGuard", () => {
  function setup() {
    const f = input();
    const win = fakeWin();
    const doc = fakeDoc([f]);
    const asked: string[] = [];
    let answer = false;
    let t = 1000;
    const stop = installLeaveGuard(
      win,
      doc,
      "有未保存的内容，确定离开吗？",
      (m) => (asked.push(m), answer),
      () => t,
    );
    const typeIn = (v: string) => {
      doc.fire("focusin", { target: f });
      f.value = v;
      doc.fire("input", { target: f, isTrusted: true });
    };
    return {
      win,
      asked,
      stop,
      typeIn,
      say: (a: boolean) => (answer = a),
      tick: (ms: number) => (t += ms),
    };
  }

  it("a clean page: links go, unload does not ask", () => {
    const s = setup();
    const c = click(link({ href: "/en/review" }));
    s.win.fire("click", c);
    const u = { prevented: false, preventDefault: () => (u.prevented = true) };
    s.win.fire("beforeunload", u);
    expect(c.prevented || u.prevented).toBe(false);
    expect(s.asked).toEqual([]);
    s.stop();
  });

  it("dirty: an in-app link asks; Cancel stays, OK goes and unload does not ask again", () => {
    const s = setup();
    s.typeIn("half a sentence");
    const c = click(link({ href: "/en/review" }));
    s.win.fire("click", c);
    expect(s.asked.length).toBe(1);
    expect(c.prevented && c.stopped).toBe(true);
    s.say(true);
    const c2 = click(link({ href: "/en/review" }));
    s.win.fire("click", c2);
    expect(c2.prevented).toBe(false);
    const u = {
      prevented: false,
      returnValue: undefined as unknown,
      preventDefault: () => (u.prevented = true),
    };
    s.win.fire("beforeunload", u);
    expect(u.prevented).toBe(false);
    // Later, a reload or close asks the browser's own prompt.
    s.tick(5000);
    s.win.fire("beforeunload", u);
    expect(u.prevented).toBe(true);
    expect(u.returnValue).toBe("");
    s.stop();
  });

  it("an external link is left to beforeunload", () => {
    const s = setup();
    s.typeIn("x");
    const c = click(link({ href: "https://example.com/" }));
    s.win.fire("click", c);
    expect(s.asked).toEqual([]);
    expect(c.prevented).toBe(false);
    s.stop();
  });

  it("installs confirmLeave's judgement, and removes everything on stop", () => {
    const s = setup();
    s.typeIn("x");
    expect(confirmLeave(() => false)).toBe(false);
    s.stop();
    expect(s.win.count("click") + s.win.count("beforeunload")).toBe(0);
    expect(confirmLeave(() => false)).toBe(true);
  });

  it("defaults to the browser's confirm", () => {
    const f = input();
    const win = fakeWin();
    const doc = fakeDoc([f]);
    const stop = installLeaveGuard(win, doc, "Leave?");
    doc.fire("focusin", { target: f });
    f.value = "x";
    doc.fire("input", { target: f, isTrusted: true });
    const prev = globalThis.confirm;
    const asked: string[] = [];
    globalThis.confirm = (m?: string) => (asked.push(String(m)), false);
    try {
      const c = click(link({ href: "/en/review" }));
      win.fire("click", c);
      expect(asked).toEqual(["Leave?"]);
      expect(c.prevented).toBe(true);
    } finally {
      globalThis.confirm = prev;
      stop();
    }
  });
});
