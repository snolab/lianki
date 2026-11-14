import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  CLONE_TTS_KEY,
  CLONE_VOICE_NAME,
  DEFAULT_CLONE_TIMEOUT_MS,
  DEFAULT_CLONE_TTS_BASE,
  READBACK_KEEP,
  clearReadback,
  cloneTimeoutMs,
  cloneTtsBase,
  cloneTtsUrl,
  trimSlashes,
  isAgentPolish,
  polishReadback,
  polishReadbackOn,
  readbackOf,
  readbackText,
  setPolishReadback,
} from "@lianki/debug-chat/polish-readback";
import { type UtterLike, createVoice, gateVoice } from "@lianki/debug-chat/voice";
import { stubGlobals } from "./support/globals";
import { createCloudOut } from "@lianki/debug-chat/voice-out";
import { MERGE_BY, UNMERGE_BY } from "@lianki/debug-chat/voice-merge";
import { clearHeard, heardFor } from "@lianki/debug-chat/voice-heard";
import type { ChatMessage, EditedEvent } from "@lianki/debug-chat/wire";

const tick = () => new Promise((r) => setTimeout(r, 0));

/** His raw voice line, as the page has it before the polish. */
const raw = (o: Partial<ChatMessage> = {}): ChatMessage =>
  ({
    id: "m1",
    from: "owner",
    text: "fix the sink button",
    at: 1,
    source: "stt",
    ...o,
  }) as ChatMessage;
/** The hub's edited event for an agent's polish of m1. */
const polished = (o: Partial<EditedEvent> = {}): Omit<EditedEvent, "type"> => ({
  id: "m1",
  thread: "owner",
  text: "Fix the sync button.",
  raw: "fix the sink button",
  edited: { at: 2, by: "chat", count: 1 },
  ...o,
});

beforeEach(() => {
  clearReadback();
  setPolishReadback({ on: true });
});
afterEach(() => {
  clearReadback();
  setPolishReadback(null);
});

describe("polish read-back: which edit is the polish event", () => {
  it("raw → polished, his own spoken line: the polished text", () => {
    expect(readbackText(raw(), polished())).toBe("Fix the sync button.");
    // A merged line not yet polished is still raw: its polished passage is read.
    const merged = raw({ edited: { at: 2, by: MERGE_BY, count: 0 }, raw: "a b" });
    expect(
      readbackText(merged, polished({ passage: { at: 3, by: "chat", ids: ["m1", "m2"] } })),
    ).toBe("Fix the sync button.");
  });

  it("never: a line the page never had, typed, an agent's, another thread or id", () => {
    expect(readbackText(undefined, polished())).toBeNull();
    expect(readbackText(raw({ source: undefined }), polished())).toBeNull();
    expect(readbackText(raw({ from: "agent" }), polished())).toBeNull();
    expect(readbackText(raw({ from: "friend" }), polished())).toBeNull();
    expect(readbackText(raw({ thread: "f1" }), polished())).toBeNull();
    expect(readbackText(raw({ id: "m2" }), polished())).toBeNull();
  });

  it("never: a merge, an undo, a summary, a split or a restore", () => {
    expect(readbackText(raw(), polished({ edited: { at: 2, by: MERGE_BY, count: 0 } }))).toBeNull();
    expect(
      readbackText(raw(), polished({ edited: { at: 2, by: UNMERGE_BY, count: 0 } })),
    ).toBeNull();
    expect(readbackText(raw(), polished({ merged: { id: "m2", text: "x" } }))).toBeNull();
    expect(
      readbackText(raw(), polished({ summary: { at: 2, by: "chat", ids: ["m1"] } })),
    ).toBeNull();
    expect(readbackText(raw(), polished({ split: [raw()] }))).toBeNull();
    expect(readbackText(raw(), polished({ restored: [raw()] }))).toBeNull();
    expect(
      readbackText(raw({ summary: { at: 1, by: "chat", ids: ["m1"] } }), polished()),
    ).toBeNull();
  });

  it("never: a repeat polish, or an empty one", () => {
    const once = raw({ edited: { at: 2, by: "chat", count: 1 }, raw: "fix the sink button" });
    expect(readbackText(once, polished({ edited: { at: 3, by: "chat", count: 2 } }))).toBeNull();
    expect(readbackText(raw(), polished({ text: "   " }))).toBeNull();
  });

  it("isAgentPolish: an agent's mark, not a merge's or an undo's", () => {
    expect(isAgentPolish(undefined)).toBe(false);
    expect(isAgentPolish({ at: 1, by: MERGE_BY, count: 0 })).toBe(false);
    expect(isAgentPolish({ at: 1, by: UNMERGE_BY, count: 0 })).toBe(false);
    expect(isAgentPolish({ at: 1, by: "codex", count: 1 })).toBe(true);
  });
});

describe("polish read-back: queued once, through the voice", () => {
  const rig = (o: { base?: string | null; speaker?: boolean; queued?: boolean } = {}) => {
    const calls: { text: string; meta: unknown; how: unknown }[] = [];
    const logs: Record<string, unknown>[] = [];
    const d = {
      reply: (text: string, meta: unknown, how: unknown) => {
        calls.push({ text, meta, how });
        return o.queued ?? true;
      },
      speaker: () => o.speaker ?? true,
      base: () => (o.base === undefined ? DEFAULT_CLONE_TTS_BASE : o.base),
      log: (e: Record<string, unknown>) => void logs.push(e),
    };
    return { calls, logs, d };
  };

  it("raw → polished fires once, in the clone, with the line's id; repeat edits do not", () => {
    const r = rig();
    expect(polishReadback(raw(), polished(), r.d)).toBe(true);
    expect(r.calls).toEqual([
      { text: "Fix the sync button.", meta: { id: "m1" }, how: { pick: { kind: "clone" } } },
    ]);
    expect(readbackOf("m1")).toBe("Fix the sync button.");
    expect(r.logs).toEqual([{ ev: "polish-readback", chars: 20, queued: true }]);
    // The second polish of the same line, even as if it were raw again: never twice.
    expect(polishReadback(raw(), polished({ text: "Fix the sync button!" }), r.d)).toBe(false);
    expect(r.calls).toHaveLength(1);
  });

  it("agent lines, typed lines and merges do not fire (and stay free for a later polish)", () => {
    const r = rig();
    expect(polishReadback(raw({ from: "agent" }), polished(), r.d)).toBe(false);
    expect(polishReadback(raw({ source: undefined }), polished(), r.d)).toBe(false);
    expect(
      polishReadback(raw(), polished({ edited: { at: 2, by: MERGE_BY, count: 0 } }), r.d),
    ).toBe(false);
    expect(r.calls).toHaveLength(0);
    expect(polishReadback(raw(), polished(), r.d)).toBe(true);
  });

  it("flag off: nothing, and the line stays free", () => {
    setPolishReadback({ on: false });
    expect(polishReadbackOn()).toBe(false);
    const r = rig();
    expect(polishReadback(raw(), polished(), r.d)).toBe(false);
    expect(r.calls).toHaveLength(0);
    expect(polishReadback(raw(), polished(), { ...r.d, on: () => true })).toBe(true);
  });

  it("clone off on this device, or another tab reads: skipped, logged, never later", () => {
    const off = rig({ base: null });
    expect(polishReadback(raw(), polished(), off.d)).toBe(false);
    expect(off.logs).toEqual([{ ev: "polish-readback", skip: "off" }]);
    expect(polishReadback(raw(), polished(), rig().d)).toBe(false);
    clearReadback();
    const other = rig({ speaker: false });
    expect(polishReadback(raw(), polished(), other.d)).toBe(false);
    expect(other.logs).toEqual([{ ev: "polish-readback", skip: "other-tab" }]);
    expect(other.calls).toHaveLength(0);
  });

  it("not queued (read-aloud off): handled, but nothing for the read-progress mirror", () => {
    const r = rig({ queued: false });
    expect(polishReadback(raw(), polished(), r.d)).toBe(false);
    expect(readbackOf("m1")).toBeUndefined();
    expect(polishReadback(raw(), polished(), rig().d)).toBe(false);
  });

  it("remembers at most READBACK_KEEP lines, oldest dropped", () => {
    const r = rig();
    for (let i = 0; i <= READBACK_KEEP; i++)
      polishReadback(raw({ id: `m${i}` }), polished({ id: `m${i}` }), r.d);
    expect(readbackOf("m0")).toBeUndefined();
    expect(readbackOf(`m${READBACK_KEEP}`)).toBe("Fix the sync button.");
  });

  it("defaults: the flag store on globalThis, the clone base from localStorage", () => {
    const restore = stubGlobals({ localStorage: { getItem: () => "off" } });
    try {
      // No `base` given: the device key decides ("off": none).
      const calls: unknown[] = [];
      expect(polishReadback(raw(), polished(), { reply: () => (calls.push(1), true) })).toBe(false);
      expect(calls).toHaveLength(0);
    } finally {
      restore();
    }
  });
});

describe("polish read-back: the clone server's URL and settings", () => {
  it("builds the URL from the base, any trailing slash, the text encoded", () => {
    expect(cloneTtsUrl("https://h/c", "你好 a&b?")).toBe(
      `https://h/c/tts?text=${encodeURIComponent("你好 a&b?")}`,
    );
    expect(cloneTtsUrl("https://h/c//", "x")).toBe("https://h/c/tts?text=x");
    expect(trimSlashes("/")).toBe("");
    expect(trimSlashes("a/b")).toBe("a/b");
    // Linear: ten thousand slashes (and slashes not at the end) take no time.
    const many = "/".repeat(10_000);
    const t0 = performance.now();
    expect(cloneTtsUrl(`${many}x${many}`, "y")).toBe(`${many}x/tts?text=y`);
    expect(trimSlashes(`h${many}`)).toBe("h");
    expect(performance.now() - t0).toBeLessThan(200);
  });

  it("the device key: absent or blank = the default, 'off' = none, else its URL", () => {
    expect(cloneTtsBase(() => null)).toBe(DEFAULT_CLONE_TTS_BASE);
    expect(cloneTtsBase(() => "  ")).toBe(DEFAULT_CLONE_TTS_BASE);
    expect(cloneTtsBase(() => "off")).toBeNull();
    expect(cloneTtsBase((k) => (k === CLONE_TTS_KEY ? "https://mac/clone/" : null))).toBe(
      "https://mac/clone",
    );
    // Storage blocked: the default.
    const restore = stubGlobals({
      localStorage: {
        getItem: () => {
          throw new Error("blocked");
        },
      },
    });
    try {
      expect(cloneTtsBase()).toBe(DEFAULT_CLONE_TTS_BASE);
    } finally {
      restore();
    }
  });

  it("the timeout: the config's, else the default for anything not a positive number", () => {
    setPolishReadback({ on: true, timeoutMs: 5000 });
    expect(cloneTimeoutMs()).toBe(5000);
    setPolishReadback({ on: true, timeoutMs: -1 });
    expect(cloneTimeoutMs()).toBe(DEFAULT_CLONE_TIMEOUT_MS);
    setPolishReadback({ on: true });
    expect(cloneTimeoutMs()).toBe(DEFAULT_CLONE_TIMEOUT_MS);
  });
});

// ── Through the real session and cloud output (fakes for fetch, element, context) ──

class FakeEl {
  src = "";
  currentTime = 0;
  volume = 1;
  preload = "";
  paused = true;
  plays: string[] = [];
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onloadedmetadata: (() => void) | null = null;
  play() {
    this.paused = false;
    this.plays.push(this.src);
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  load() {
    this.currentTime = 0;
  }
}

function session(
  o: {
    fetch?: "ok" | "fail" | "hang";
    base?: string | null;
    enabled?: boolean;
    cloud?: boolean;
    hidden?: boolean;
  } = {},
) {
  const el = new FakeEl();
  const fetched: string[] = [];
  const timers: { f: () => void; ms: number; live: boolean }[] = [];
  const setTimer = (f: () => void, ms: number) => {
    const t = { f, ms, live: true };
    timers.push(t);
    return t;
  };
  const g = {
    value: 1,
    cancelScheduledValues() {},
    setValueAtTime() {},
    linearRampToValueAtTime() {},
  };
  const ctx = {
    currentTime: 0,
    destination: {},
    createGain: () => ({ gain: g, connect: (n: unknown) => n }),
    createMediaElementSource: () => ({ connect: (n: unknown) => n }),
  };
  const cloud = createCloudOut({
    fetch: (url) => {
      fetched.push(url);
      if (o.fetch === "hang") return new Promise(() => {});
      if (o.fetch === "fail") return Promise.reject(new Error("offline"));
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: () => null },
        blob: async () => new Blob(["wav"]),
      });
    },
    element: () => el,
    ctx: () => ctx,
    toUrl: () => `blob:${fetched.length}`,
    revoke: () => {},
    setTimer,
    cloneBase: () => (o.base === undefined ? "https://mac/clone" : o.base),
    cloneTimeout: () => 7000,
  });
  const spoken: string[] = [];
  const logs: Record<string, unknown>[] = [];
  const v = createVoice({
    synth: () => ({ speak: (u) => void spoken.push(u.text), cancel: () => {} }),
    utter: (text) => ({ text, onend: null, onerror: null, onboundary: null }) as UtterLike,
    enabled: () => o.enabled ?? true,
    here: () => false,
    touch: () => true,
    cloud: () => (o.cloud === false ? null : cloud),
    mode: () => "speech",
    log: (e) => void logs.push(e),
    setTimer,
    clearTimer: (t) => {
      if (t) (t as { live: boolean }).live = false;
    },
  });
  const gated = gateVoice(v, () => (o.hidden ? "hidden" : null));
  const fire = (ms: number) => {
    for (const t of timers.filter((x) => x.live && x.ms === ms)) {
      t.live = false;
      t.f();
    }
  };
  const loaded = async () => {
    await tick();
    el.onloadedmetadata?.();
    await tick();
  };
  const readBack = () =>
    polishReadback(raw(), polished(), {
      reply: (text, meta, how) => gated.reply(text, meta, how),
      base: () => "https://mac/clone",
    });
  return { v: gated, el, fetched, spoken, logs, fire, loaded, readBack };
}

describe("polish read-back: in the clone, through Li's queue", () => {
  beforeEach(() => clearHeard());

  it("plays the clip from the clone server; the line's details name the clone", async () => {
    const s = session();
    expect(s.readBack()).toBe(true);
    await s.loaded();
    expect(s.fetched).toEqual([
      `https://mac/clone/tts?text=${encodeURIComponent("Fix the sync button.")}`,
    ]);
    expect(s.el.plays).toHaveLength(1);
    expect(heardFor("m1")).toEqual([{ name: CLONE_VOICE_NAME }]);
    expect(s.spoken).toEqual([]);
  });

  it("the server fails: skipped silently and logged, never read in another voice", async () => {
    const s = session({ fetch: "fail" });
    expect(s.readBack()).toBe(true);
    await s.loaded();
    expect(s.el.plays).toHaveLength(0);
    expect(s.spoken).toEqual([]);
    expect(s.logs).toContainEqual(
      expect.objectContaining({
        ev: "voice-out",
        out: "clone",
        route: "none",
        fallback: "offline",
      }),
    );
    expect(s.v.state().queued).toBe(0);
  });

  it("the server never answers: given up after the timeout, skipped", async () => {
    const s = session({ fetch: "hang" });
    s.readBack();
    await tick();
    expect(s.v.state().queued).toBe(1);
    s.fire(7000);
    await s.loaded();
    expect(s.spoken).toEqual([]);
    expect(s.logs).toContainEqual(
      expect.objectContaining({ out: "clone", fallback: "clone timeout 7000 ms" }),
    );
    expect(s.v.state().queued).toBe(0);
  });

  it("clone off on the device (cloud out): skipped", async () => {
    const s = session({ base: null });
    s.readBack();
    await s.loaded();
    expect(s.fetched).toEqual([]);
    expect(s.spoken).toEqual([]);
    expect(s.logs).toContainEqual(expect.objectContaining({ out: "clone", fallback: "clone off" }));
  });

  it("read-aloud off, no cloud output, or a hidden page: nothing queued, nothing kept to read later", async () => {
    expect(session({ enabled: false }).readBack()).toBe(false);
    expect(session({ cloud: false }).readBack()).toBe(false);
    const hidden = session({ hidden: true });
    expect(hidden.readBack()).toBe(false);
    (hidden.v as unknown as { __readMissed: () => void }).__readMissed();
    await tick();
    expect(hidden.fetched).toEqual([]);
  });

  it("a lane superseding its own lines does not cut the read-back", async () => {
    const s = session();
    s.readBack();
    await s.loaded();
    expect(s.v.supersede("lane:main")).toBe(false);
    expect(s.v.state().queued).toBe(1);
  });
});
