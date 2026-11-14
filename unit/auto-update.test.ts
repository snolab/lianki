/**
 * lib/auto-update.ts: a new version applies itself only on a clean page, at a
 * moment the user is not mid-action, and never over audio, a dialog, a draft
 * or a write in flight.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  anchorSelector,
  audioPlaying,
  autoUpdateOn,
  autoUpdatePref,
  setAutoUpdatePref,
  chatDraft,
  dialogOpen,
  isOwnWrite,
  mayApplyAt,
  registerUpdateChecks,
  requestOf,
  resumeFor,
  trackWrites,
  updateState,
} from "@/lib/auto-update";
import { pageIsDirty } from "@/lib/page-dirty";
import { onDirtyNotify } from "@lianki/ui-state/dirty";

/** A fake document answering querySelectorAll by selector substring. */
function doc(map: Record<string, unknown[]> = {}) {
  return {
    activeElement: null,
    querySelectorAll(sel: string) {
      const out: unknown[] = [];
      for (const [k, v] of Object.entries(map)) if (sel.includes(k)) out.push(...v);
      return out;
    },
    addEventListener() {},
    removeEventListener() {},
  };
}
const el = (attrs: Record<string, string> = {}, extra: Record<string, unknown> = {}) => ({
  getAttribute: (n: string) => attrs[n] ?? null,
  ...extra,
});

describe("on or off", () => {
  test("needs both the flag and the user's switch", () => {
    expect(autoUpdateOn({ flag: true, pref: true })).toBe(true);
    expect(autoUpdateOn({ flag: false, pref: true })).toBe(false);
    expect(autoUpdateOn({ flag: true, pref: false })).toBe(false);
  });

  test("the switch is on unless set to 0, and a broken store reads on", () => {
    expect(autoUpdatePref({ getItem: () => null })).toBe(true);
    expect(autoUpdatePref({ getItem: () => "1" })).toBe(true);
    expect(autoUpdatePref({ getItem: () => "0" })).toBe(false);
    expect(
      autoUpdatePref({
        getItem: () => {
          throw new Error("blocked");
        },
      }),
    ).toBe(true);
    expect(autoUpdatePref(null)).toBe(true);
  });

  test("the switch writes 1 or 0, and a refusing store is shrugged off", () => {
    const m = new Map<string, string>();
    const store = { setItem: (k: string, v: string) => void m.set(k, v) };
    setAutoUpdatePref(false, store);
    expect(m.get("lk:auto-update")).toBe("0");
    setAutoUpdatePref(true, store);
    expect(m.get("lk:auto-update")).toBe("1");
    setAutoUpdatePref(false, {
      setItem: () => {
        throw new Error("quota");
      },
    });
    setAutoUpdatePref(true, null);
  });

  test("the pill: the old button when off, else clean or dirty", () => {
    expect(updateState({ auto: false, dirty: false })).toBe("button");
    expect(updateState({ auto: false, dirty: true })).toBe("button");
    expect(updateState({ auto: true, dirty: false })).toBe("auto-clean");
    expect(updateState({ auto: true, dirty: true })).toBe("auto-dirty");
  });
});

describe("when a clean page may reload", () => {
  test("in the background or on the next page: anywhere", () => {
    for (const p of ["/home", "/words", "/review/x"]) {
      expect(mayApplyAt("hidden", p)).toBe(true);
      expect(mayApplyAt("navigate", p)).toBe(true);
    }
  });
  test("after a quiet spell: not in a /words or /review session", () => {
    expect(mayApplyAt("idle", "/home")).toBe(true);
    expect(mayApplyAt("idle", "/wordsmith")).toBe(true);
    expect(mayApplyAt("idle", "/words")).toBe(false);
    expect(mayApplyAt("idle", "/review")).toBe(false);
    expect(mayApplyAt("idle", "/review/abc")).toBe(false);
  });
});

describe("the clean signals", () => {
  test("audio: speech, the chat's voice, or a playing media element", () => {
    expect(audioPlaying(doc(), {})).toBe(false);
    expect(audioPlaying(doc(), { speechSynthesis: { speaking: true } })).toBe(true);
    expect(audioPlaying(doc(), { speechSynthesis: { pending: true } })).toBe(true);
    expect(audioPlaying(doc(), { __lkVoice: { state: () => ({ speaking: true }) } })).toBe(true);
    expect(audioPlaying(doc(), { __lkVoice: { state: () => ({ queued: 2 }) } })).toBe(true);
    expect(audioPlaying(doc(), { __lkVoice: { state: () => ({ hold: true }) } })).toBe(true);
    expect(audioPlaying(doc(), { __lkVoice: { state: () => ({ queued: 0 }) } })).toBe(false);
    const broken = {
      __lkVoice: {
        state: () => {
          throw new Error("x");
        },
      },
      get speechSynthesis(): unknown {
        throw new Error("y");
      },
    };
    expect(audioPlaying(doc(), broken)).toBe(false);
    expect(audioPlaying(doc({ audio: [{ paused: false, ended: false }] }), {})).toBe(true);
    expect(audioPlaying(doc({ audio: [{ paused: true, ended: false }] }), {})).toBe(false);
    expect(audioPlaying(doc({ audio: [{ paused: false, ended: true }] }), {})).toBe(false);
  });

  test("a dialog that is shown, not a hidden one", () => {
    expect(dialogOpen(doc())).toBe(false);
    expect(dialogOpen(doc({ dialog: [el()] }))).toBe(true);
    expect(dialogOpen(doc({ dialog: [el({ "aria-hidden": "true" })] }))).toBe(false);
    expect(dialogOpen(doc({ dialog: [el({ hidden: "" })] }))).toBe(false);
  });

  test("a chat draft with words in it", () => {
    expect(chatDraft(doc({ textarea: [el({}, { value: "  " })] }))).toBe(false);
    expect(chatDraft(doc({ textarea: [el({}, { value: "hi" })] }))).toBe(true);
    expect(chatDraft(doc({ textarea: [el({}, {})] }))).toBe(false);
  });

  test("a write to this site, not a read and not another site", () => {
    const o = "https://lianki.com";
    expect(isOwnWrite("POST", "/api/x", o)).toBe(true);
    expect(isOwnWrite("DELETE", "https://lianki.com/api/x", o)).toBe(true);
    expect(isOwnWrite("GET", "/api/x", o)).toBe(false);
    expect(isOwnWrite("HEAD", "/api/x", o)).toBe(false);
    expect(isOwnWrite("POST", "https://example.com/x", o)).toBe(false);
    expect(isOwnWrite("POST", "http://[bad", o)).toBe(false);
  });

  test("the method and URL of fetch's arguments", () => {
    expect(requestOf("/a")).toEqual({ method: "GET", url: "/a" });
    expect(requestOf("/a", { method: "post" })).toEqual({ method: "POST", url: "/a" });
    expect(requestOf(new URL("https://lianki.com/b"))).toEqual({
      method: "GET",
      url: "https://lianki.com/b",
    });
    expect(requestOf(new Request("https://lianki.com/c", { method: "PUT" }))).toEqual({
      method: "PUT",
      url: "https://lianki.com/c",
    });
  });
});

describe("writes in flight", () => {
  test("counted from start to answer, a failure too; reads are not", async () => {
    let finish: (r: Response) => void = () => {};
    let fail: (e: Error) => void = () => {};
    const calls: string[] = [];
    const g = {
      location: { origin: "https://lianki.com" },
      fetch: ((input: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? "GET"} ${input}`);
        if (input === "/read") return Promise.resolve(new Response("r"));
        return new Promise<Response>((res, rej) => {
          if (input === "/bad") fail = rej;
          else finish = res;
        });
      }) as unknown as typeof fetch,
    };
    let notified = 0;
    const off = onDirtyNotify(() => notified++);
    const t = trackWrites(g);
    await g.fetch("/read");
    expect(t.inFlight()).toBe(0);
    const p = g.fetch("/save", { method: "POST" });
    expect(t.inFlight()).toBe(1);
    finish(new Response("ok"));
    expect(await (await p).text()).toBe("ok");
    expect(t.inFlight()).toBe(0);
    const q = g.fetch("/bad", { method: "POST" });
    expect(t.inFlight()).toBe(1);
    fail(new Error("net"));
    await expect(q).rejects.toThrow("net");
    expect(t.inFlight()).toBe(0);
    expect(notified).toBe(2);
    expect(calls).toEqual(["GET /read", "POST /save", "POST /bad"]);
    const wrapped = g.fetch;
    t.stop();
    expect(g.fetch).not.toBe(wrapped);
    off();
  });

  test("no fetch: nothing to count", () => {
    const t = trackWrites({});
    expect(t.inFlight()).toBe(0);
    t.stop();
  });
});

describe("registered with the page's dirty check", () => {
  let off = () => {};
  afterEach(() => off());

  test("each signal makes the page dirty for a reload, never for leaving", () => {
    let n = 0;
    const writes = { inFlight: () => n, stop() {} };
    const d = doc();
    off = registerUpdateChecks(d, writes, {});
    expect(pageIsDirty(d as never, "reload", {})).toBe(false);
    n = 1;
    expect(pageIsDirty(d as never, "reload", {})).toBe(true);
    expect(pageIsDirty(d as never, "leave", {})).toBe(false);
    n = 0;
    off();
    const playing = doc({ audio: [{ paused: false, ended: false }] });
    off = registerUpdateChecks(playing, writes, {});
    expect(pageIsDirty(playing as never, "reload", {})).toBe(true);
    off();
    const modal = doc({ dialog: [el()] });
    off = registerUpdateChecks(modal, writes, {});
    expect(pageIsDirty(modal as never, "reload", {})).toBe(true);
    off();
    const draft = doc({ textarea: [el({}, { value: "half a line" })] });
    off = registerUpdateChecks(draft, writes, {});
    expect(pageIsDirty(draft as never, "reload", {})).toBe(true);
  });
});

describe("where the user was", () => {
  test("an anchor by id, else data-testid, else none", () => {
    const rect = () => ({ top: 0 });
    expect(anchorSelector(null)).toBe(null);
    expect(
      anchorSelector({ id: "card-3", getAttribute: () => null, getBoundingClientRect: rect }),
    ).toBe("#card-3");
    expect(anchorSelector({ id: "", getAttribute: () => 'a"b', getBoundingClientRect: rect })).toBe(
      '[data-testid="a\\"b"]',
    );
    expect(anchorSelector({ getAttribute: () => null, getBoundingClientRect: rect })).toBe(null);
    const saved = (globalThis as { CSS?: unknown }).CSS;
    (globalThis as { CSS?: unknown }).CSS = undefined;
    expect(
      anchorSelector({ id: "a.b", getAttribute: () => null, getBoundingClientRect: rect }),
    ).toBe("#a\\.b");
    (globalThis as { CSS?: unknown }).CSS = saved;
  });

  test("restored only for the same path, and only a sane record", () => {
    const r = JSON.stringify({ path: "/home", y: 420, anchor: "#x", offset: 12 });
    expect(resumeFor(r, "/home")).toEqual({ path: "/home", y: 420, anchor: "#x", offset: 12 });
    expect(resumeFor(r, "/words")).toBe(null);
    expect(resumeFor(null, "/home")).toBe(null);
    expect(resumeFor("{nope", "/home")).toBe(null);
    expect(resumeFor(JSON.stringify({ path: "/home", y: "x" }), "/home")).toBe(null);
  });
});
