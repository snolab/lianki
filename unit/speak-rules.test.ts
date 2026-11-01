import { describe, expect, it } from "bun:test";
import { RETIRED_KEYS, dropRetiredKeys, isQuiet, silenceFor } from "@lianki/debug-chat/speak-rules";
import { type Voice, gateVoice, unheard } from "@lianki/debug-chat/voice";

describe("speak rules: which agent lines are read aloud", () => {
  it("a quiet line is never read; any other line is, on a visible page; no time of day in it", () => {
    expect(isQuiet({ quiet: true })).toBe(true);
    expect(isQuiet({ quiet: 1 })).toBe(false);
    expect(silenceFor({ quiet: true }, { hidden: false })).toBe("quiet");
    expect(silenceFor({}, { hidden: false })).toBeNull();
    // An ask card is read like any other line.
    expect(silenceFor({ ask: { questions: [] } }, { hidden: false })).toBeNull();
    // An old `loud` means nothing.
    expect(silenceFor({ loud: true } as object, { hidden: true })).toBe("hidden");
  });

  it("a hidden page never speaks (a quiet line stays quiet, not missed)", () => {
    expect(silenceFor({}, { hidden: true })).toBe("hidden");
    expect(silenceFor({ quiet: true }, { hidden: true })).toBe("quiet");
  });

  it("the retired time-of-day key is removed from the device's storage", () => {
    expect(RETIRED_KEYS).toContain("lk:agent-quiet-hours");
    const m = new Map([
      ["lk:agent-quiet-hours", '{"on":true,"from":"23:00","to":"08:00"}'],
      ["lk:other", "1"],
    ]);
    const store = { removeItem: (k: string) => void m.delete(k) };
    dropRetiredKeys(store);
    dropRetiredKeys(store);
    expect([...m.keys()]).toEqual(["lk:other"]);
    dropRetiredKeys(null);
    dropRetiredKeys({
      removeItem: () => {
        throw new Error("blocked");
      },
    });
  });

  it("with no store given, it cleans this page's localStorage", () => {
    const g = globalThis as Record<string, unknown>;
    const saved = Object.getOwnPropertyDescriptor(g, "localStorage");
    const removed: string[] = [];
    try {
      Object.defineProperty(g, "localStorage", {
        configurable: true,
        value: { removeItem: (k: string) => void removed.push(k) },
      });
      dropRetiredKeys();
      expect(removed).toEqual(["lk:agent-quiet-hours"]);
      // Storage access itself refused (a sandboxed frame): no throw.
      Object.defineProperty(g, "localStorage", {
        configurable: true,
        get() {
          throw new Error("SecurityError");
        },
      });
      expect(() => dropRetiredKeys()).not.toThrow();
    } finally {
      if (saved) Object.defineProperty(g, "localStorage", saved);
      else delete g.localStorage;
    }
  });
});

/** A bare session that records what reaches its real `reply`. */
function fakeVoice() {
  const heard: string[] = [];
  const logs: unknown[] = [];
  const v = {
    reply: (text: string) => (heard.push(text), true),
    log: (e: unknown) => void logs.push(e),
  } as unknown as Voice;
  return { v, heard, logs };
}
type Readable = Voice & { __readMissed?: () => void };

describe("gateVoice: the shared session's gate", () => {
  it("wraps once; a meta-less call (an older page) still gets the gate", () => {
    const { v, heard, logs } = fakeVoice();
    let silence: "quiet" | null = null;
    const seen: unknown[] = [];
    const why = (m: object) => (seen.push(m), silence);
    gateVoice(v, why);
    const wrapped = v.reply;
    gateVoice(v, why);
    expect(v.reply).toBe(wrapped);
    expect(v.reply("hello")).toBe(true);
    expect(seen.at(-1)).toEqual({});
    silence = "quiet";
    expect(v.reply("shh", { quiet: true })).toBe(false);
    expect(heard).toEqual(["hello"]);
    expect(logs).toEqual([{ ev: "voice-silent", why: "quiet" }]);
  });

  it("back from hidden: the newest line missed is read once, not a backlog; the rest keep the note", () => {
    const { v, heard } = fakeVoice();
    let hidden = true;
    gateVoice(v, (m) => silenceFor(m, { hidden }));
    const u = unheard(v);
    let changes = 0;
    u.subscribe(() => changes++);
    expect(v.reply("first", { id: "a" })).toBe(false);
    expect(v.reply("fyi", { id: "q", quiet: true })).toBe(false);
    expect(v.reply("second", { id: "b" })).toBe(false);
    expect(heard).toEqual([]);
    expect([...u.ids]).toEqual(["a", "b"]);
    expect(changes).toBe(2);
    hidden = false;
    (v as Readable).__readMissed?.();
    expect(heard).toEqual(["second"]);
    // Read: its note goes; the older one keeps it.
    expect([...u.ids]).toEqual(["a"]);
    // Once only.
    (v as Readable).__readMissed?.();
    expect(heard).toEqual(["second"]);
  });

  it("a missed line that still cannot be read (focus rule) keeps its note", () => {
    const heard: string[] = [];
    const v = {
      reply: (text: string) => (heard.push(text), false),
      log: () => {},
    } as unknown as Voice;
    let hidden = true;
    gateVoice(v, (m) => silenceFor(m, { hidden }));
    v.reply("x", { id: "c" });
    hidden = false;
    (v as Readable).__readMissed?.();
    expect(heard).toEqual(["x"]);
    expect([...unheard(v).ids]).toEqual(["c"]);
  });
});
