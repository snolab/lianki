import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  type DocLike,
  type EventLike,
  type FieldLike,
  chatDraftDirty,
  confirmLeave,
  isSkipped,
  isTextField,
  markClean,
  micBusy,
  notifyDirty,
  pageIsDirty,
  registerDirtyCheck,
  reloadDecision,
  trackEdits,
  whenClean,
} from "@/lib/page-dirty";
import { DIRTY_KEY, anyDirtyCheck, onDirtyNotify, setLeaveGuard } from "@lianki/ui-state/dirty";
import { enrolBusy } from "@lianki/debug-chat/voiceprint";

type Fake = FieldLike & { attrs: Record<string, string>; skip?: boolean };
function field(tagName: string, o: Partial<Fake> = {}): Fake {
  const attrs = o.attrs ?? {};
  return {
    tagName,
    type: tagName === "INPUT" ? "text" : undefined,
    value: "",
    defaultValue: "",
    ...o,
    attrs,
    getAttribute: (n: string) => attrs[n] ?? null,
    closest: (s: string) => (s === '[data-dirty="skip"]' && o.skip ? {} : null),
  };
}

type Listener = (e: EventLike) => void;
function fakeDoc(fields: Fake[]) {
  const ls = new Map<string, Set<Listener>>();
  const doc = {
    activeElement: null as FieldLike | null,
    visibilityState: "visible",
    querySelectorAll: () => fields,
    addEventListener: (t: string, f: Listener) => {
      if (!ls.has(t)) ls.set(t, new Set());
      ls.get(t)!.add(f);
    },
    removeEventListener: (t: string, f: Listener) => void ls.get(t)?.delete(f),
    fire(t: string, e: EventLike) {
      for (const f of [...(ls.get(t) ?? [])]) f(e);
    },
    count: (t: string) => ls.get(t)?.size ?? 0,
  };
  return doc as DocLike & typeof doc;
}
/** Focus a field, then type `text` into it (a trusted input). */
function type(doc: ReturnType<typeof fakeDoc>, el: Fake, text: string) {
  doc.fire("focusin", { target: el });
  el.value = text;
  doc.fire("input", { target: el, isTrusted: true });
}

const g = globalThis as Record<string, unknown>;
let stop = () => {};
beforeEach(() => {
  delete g[DIRTY_KEY];
  delete g.__lkFieldEdits;
  delete g.__lkMic;
  delete g.__lkUiStores;
});
afterEach(() => stop());

describe("isTextField / isSkipped", () => {
  it("takes text inputs, textareas and contenteditables only", () => {
    expect(isTextField(field("INPUT"))).toBe(true);
    expect(isTextField(field("INPUT", { type: "email" }))).toBe(true);
    expect(isTextField(field("TEXTAREA"))).toBe(true);
    expect(isTextField(field("DIV", { isContentEditable: true }))).toBe(true);
    expect(isTextField(field("DIV"))).toBe(false);
    for (const t of ["hidden", "checkbox", "radio", "range", "submit", "file"])
      expect(isTextField(field("INPUT", { type: t }))).toBe(false);
  });
  it("ignores readonly, disabled and hidden fields", () => {
    expect(isTextField(field("INPUT", { readOnly: true }))).toBe(false);
    expect(isTextField(field("TEXTAREA", { disabled: true }))).toBe(false);
    expect(isTextField(field("INPUT", { attrs: { hidden: "" } }))).toBe(false);
    expect(isTextField(field("INPUT", { attrs: { "aria-hidden": "true" } }))).toBe(false);
  });
  it("skips search boxes and data-dirty=skip", () => {
    expect(isSkipped(field("INPUT", { type: "search" }))).toBe(true);
    expect(isSkipped(field("INPUT", { attrs: { role: "searchbox" } }))).toBe(true);
    expect(isSkipped(field("INPUT", { attrs: { enterkeyhint: "search" } }))).toBe(true);
    expect(isSkipped(field("INPUT", { skip: true }))).toBe(true);
    expect(isSkipped(field("INPUT"))).toBe(false);
  });
});

describe("pageIsDirty", () => {
  it("is clean on a page nobody typed in, even with prefilled (controlled) values", () => {
    const doc = fakeDoc([
      field("INPUT", { value: "Taku", defaultValue: "Taku" }),
      field("TEXTAREA", { value: "x" }),
    ]);
    stop = trackEdits(doc);
    expect(pageIsDirty(doc)).toBe(false);
    expect(pageIsDirty(doc, "leave")).toBe(false);
  });

  it("is dirty once a field is typed in and changed; typing it back is clean", () => {
    const t = field("TEXTAREA", { value: "hello" });
    const doc = fakeDoc([t]);
    stop = trackEdits(doc);
    type(doc, t, "hello there");
    expect(pageIsDirty(doc, "leave")).toBe(true);
    t.value = "hello";
    expect(pageIsDirty(doc, "leave")).toBe(false);
  });

  it("ignores untrusted (scripted) input events", () => {
    const t = field("INPUT");
    const doc = fakeDoc([t]);
    stop = trackEdits(doc);
    t.value = "set by code";
    doc.fire("input", { target: t, isTrusted: false });
    doc.fire("input", { target: { nope: 1 } });
    expect(pageIsDirty(doc, "leave")).toBe(false);
  });

  it("an input with no focus first compares with its default", () => {
    const t = field("INPUT", { defaultValue: "a" });
    const doc = fakeDoc([t]);
    stop = trackEdits(doc);
    t.value = "ab";
    doc.fire("input", { target: t, isTrusted: true });
    expect(pageIsDirty(doc, "leave")).toBe(true);
  });

  it("contenteditable: by its text", () => {
    const c = field("DIV", { isContentEditable: true, textContent: "" });
    const doc = fakeDoc([c]);
    stop = trackEdits(doc);
    doc.fire("focusin", { target: c });
    c.textContent = "note";
    doc.fire("input", { target: c, isTrusted: true });
    expect(pageIsDirty(doc, "leave")).toBe(true);
  });

  it("a focused field holds the reload, not the leave guard", () => {
    const t = field("INPUT");
    const doc = fakeDoc([t]);
    doc.activeElement = t;
    expect(pageIsDirty(doc, "reload")).toBe(true);
    expect(pageIsDirty(doc, "leave")).toBe(false);
  });

  it("follows focus into open shadow roots", () => {
    const inner = field("TEXTAREA");
    const host = field("DIV", { shadowRoot: { activeElement: inner } });
    const doc = fakeDoc([]);
    doc.activeElement = host;
    expect(pageIsDirty(doc)).toBe(true);
  });

  it("an empty focused search box is clean; a typed one holds only the reload", () => {
    const s = field("INPUT", { type: "search" });
    const doc = fakeDoc([s]);
    stop = trackEdits(doc);
    doc.activeElement = s;
    expect(pageIsDirty(doc)).toBe(false);
    type(doc, s, "cat");
    expect(pageIsDirty(doc, "reload")).toBe(true);
    expect(pageIsDirty(doc, "leave")).toBe(false);
    doc.activeElement = null;
    expect(pageIsDirty(doc, "reload")).toBe(true);
    expect(pageIsDirty(doc, "leave")).toBe(false);
  });

  it("a field that is not a text field never counts", () => {
    const b = field("INPUT", { type: "checkbox" });
    const doc = fakeDoc([b]);
    stop = trackEdits(doc);
    type(doc, b, "on");
    expect(pageIsDirty(doc, "leave")).toBe(false);
  });

  it("a submit makes the form's fields clean; markClean does too", () => {
    const a = field("INPUT");
    const b = field("INPUT");
    const doc = fakeDoc([a, b]);
    stop = trackEdits(doc);
    type(doc, a, "x");
    type(doc, b, "y");
    doc.fire("submit", { target: { tagName: "FORM", elements: [a] } });
    expect(pageIsDirty(doc, "leave")).toBe(true);
    doc.fire("submit", { target: null });
    markClean([b]);
    expect(pageIsDirty(doc, "leave")).toBe(false);
    type(doc, a, "z");
    markClean();
    expect(pageIsDirty(doc, "leave")).toBe(false);
  });

  it("stopping trackEdits removes its listeners", () => {
    const doc = fakeDoc([]);
    trackEdits(doc)();
    expect(doc.count("input") + doc.count("focusin") + doc.count("submit")).toBe(0);
  });

  it("registered checks count, by mode", () => {
    const doc = fakeDoc([]);
    const off = registerDirtyCheck((m) => m === "reload");
    expect(pageIsDirty(doc, "reload")).toBe(true);
    expect(pageIsDirty(doc, "leave")).toBe(false);
    off();
    off();
    expect(pageIsDirty(doc)).toBe(false);
    const bad = registerDirtyCheck(() => {
      throw new Error("x");
    });
    expect(anyDirtyCheck("leave")).toBe(true);
    bad();
  });

  it("the chat draft and the mic hold the reload only", () => {
    const doc = fakeDoc([]);
    const store = { getState: () => ({ draft: "half a line" }), subscribe: () => () => {} };
    g.__lkUiStores = new Map([["lk:ui:chat", store]]);
    expect(pageIsDirty(doc, "reload")).toBe(true);
    expect(pageIsDirty(doc, "leave")).toBe(false);
    delete g.__lkUiStores;
    g.__lkMic = { view: () => ({ state: "listening" }) };
    expect(pageIsDirty(doc, "reload")).toBe(true);
    expect(pageIsDirty(doc, "leave")).toBe(false);
  });
});

describe("chatDraftDirty / micBusy", () => {
  it("reads the live chat store, else sessionStorage", () => {
    expect(chatDraftDirty({})).toBe(false);
    const st = (draft: unknown) => ({
      __lkUiStores: new Map([["lk:ui:chat", { getState: () => ({ draft }) }]]),
    });
    expect(chatDraftDirty(st("  "))).toBe(false);
    expect(chatDraftDirty(st("hi"))).toBe(true);
    expect(chatDraftDirty(st(3))).toBe(false);
    const ss = (raw: string | null) => ({ sessionStorage: { getItem: () => raw } });
    expect(chatDraftDirty(ss(JSON.stringify({ state: { draft: "kept" }, version: 1 })))).toBe(true);
    expect(chatDraftDirty(ss(JSON.stringify({ state: { draft: "" } })))).toBe(false);
    expect(chatDraftDirty(ss(null))).toBe(false);
    expect(chatDraftDirty(ss("{not json"))).toBe(false);
  });
  it("the mic: on, or transcripts still out", () => {
    expect(micBusy({})).toBe(false);
    expect(micBusy({ __lkMic: { view: () => ({ state: "off" }) } })).toBe(false);
    expect(micBusy({ __lkMic: { view: () => ({ state: "off", pending: 1 }) } })).toBe(true);
    expect(micBusy({ __lkMic: { view: () => ({ state: "capturing" }) } })).toBe(true);
    expect(
      micBusy({
        __lkMic: {
          view: () => {
            throw new Error("old session");
          },
        },
      }),
    ).toBe(false);
  });
  it("a voiceprint enrolment is busy while recording or saving", () => {
    expect(enrolBusy({ step: "recording", index: 0, kept: 0 })).toBe(true);
    expect(enrolBusy({ step: "saving", kept: 10 })).toBe(true);
    expect(enrolBusy({ step: "consent", keepAudio: false })).toBe(false);
    expect(enrolBusy({ step: "closed" })).toBe(false);
  });
});

describe("reloadDecision", () => {
  it("debug devices reload a clean page, wait on a dirty one, once per build", () => {
    expect(reloadDecision({ debug: true, first: true, dirty: false })).toBe("reload");
    expect(reloadDecision({ debug: true, first: true, dirty: true })).toBe("wait");
    expect(reloadDecision({ debug: true, first: false, dirty: false })).toBe("button");
  });
  it("everyone else gets the button", () => {
    expect(reloadDecision({ debug: false, first: true, dirty: false })).toBe("button");
    expect(reloadDecision({ debug: false, first: false, dirty: true })).toBe("button");
  });
});

describe("whenClean", () => {
  const flush = () => new Promise<void>((r) => queueMicrotask(r));

  it("fires once, when a blur leaves the page clean", async () => {
    const t = field("INPUT");
    const doc = fakeDoc([t]);
    doc.activeElement = t;
    let n = 0;
    stop = whenClean(doc, () => n++);
    doc.fire("input", { target: t });
    await flush();
    expect(n).toBe(0);
    doc.activeElement = null;
    doc.fire("focusout", { target: t });
    await flush();
    expect(n).toBe(1);
    doc.fire("change", { target: t });
    await flush();
    expect(n).toBe(1);
    expect(doc.count("focusout") + doc.count("visibilitychange")).toBe(0);
  });

  it("re-checks on visibilitychange and the registry's notify", () => {
    const doc = fakeDoc([]);
    let busy = true;
    const off = registerDirtyCheck(() => busy);
    let n = 0;
    stop = whenClean(doc, () => n++);
    doc.fire("visibilitychange", { target: doc });
    notifyDirty();
    expect(n).toBe(0);
    busy = false;
    notifyDirty();
    expect(n).toBe(1);
    off();
  });

  it("follows the chat store and the mic (not their first call)", () => {
    const doc = fakeDoc([]);
    let draft = "x";
    let chatF = () => {};
    g.__lkUiStores = new Map([
      [
        "lk:ui:chat",
        { getState: () => ({ draft }), subscribe: (f: () => void) => ((chatF = f), () => {}) },
      ],
    ]);
    let state = "listening";
    let micF = () => {};
    g.__lkMic = {
      view: () => ({ state }),
      subscribe: (f: () => void) => {
        micF = f;
        f();
        return () => {};
      },
    };
    let n = 0;
    stop = whenClean(doc, () => n++);
    draft = "";
    chatF();
    expect(n).toBe(0);
    state = "off";
    micF();
    expect(n).toBe(1);
  });
});

describe("confirmLeave / onDirtyNotify", () => {
  it("asks only when the guard says dirty, with its message", () => {
    let dirty = false;
    const asked: string[] = [];
    const ask = (m: string) => (asked.push(m), false);
    const off = setLeaveGuard({ isDirty: () => dirty, message: "Leave?" });
    expect(confirmLeave(ask)).toBe(true);
    dirty = true;
    expect(confirmLeave(ask)).toBe(false);
    expect(confirmLeave(() => true)).toBe(true);
    expect(asked).toEqual(["Leave?"]);
    off();
    off();
  });
  it("without a guard, the registry's leave checks count", () => {
    expect(confirmLeave(() => false)).toBe(true);
    const off = registerDirtyCheck((m) => m === "leave");
    const asked: string[] = [];
    expect(confirmLeave((m) => (asked.push(m), false))).toBe(false);
    expect(asked[0]).toContain("unsaved");
    off();
    const prev = globalThis.confirm;
    globalThis.confirm = () => true;
    try {
      const off2 = registerDirtyCheck(() => true);
      expect(confirmLeave()).toBe(true);
      off2();
    } finally {
      globalThis.confirm = prev;
    }
  });
  it("a listener that throws does not stop the others", () => {
    let n = 0;
    const a = onDirtyNotify(() => {
      throw new Error("x");
    });
    const b = onDirtyNotify(() => n++);
    notifyDirty();
    expect(n).toBe(1);
    a();
    b();
  });
});
