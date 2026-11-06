import { afterEach, describe, expect, it } from "bun:test";
import { MIC_TAPS_KEY, createMicTaps, micTaps } from "@lianki/debug-chat/mic-taps";
import {
  MIC_SESSION_KEY,
  MIC_SESSION_V,
  type MicDeps,
  createMicSession,
  micSession,
} from "@lianki/debug-chat/mic-session";
import type { VadEvents } from "@lianki/debug-chat/mic";
import { REJECTS_TO_PASSIVE } from "@lianki/debug-chat/wake";

const tick = () => new Promise((r) => setTimeout(r, 0));
const RATE = 16000;
const g = globalThis as Record<string, unknown>;

afterEach(() => {
  delete g[MIC_TAPS_KEY];
  delete g[MIC_SESSION_KEY];
});

describe("mic taps", () => {
  it("asks the newest tap first, and stops at the one that keeps it", () => {
    const t = createMicTaps();
    const seen: string[] = [];
    t.tap((x) => (seen.push(`old ${x}`), true));
    const off = t.tap((x) => (seen.push(`new ${x}`), x === "keep"));
    expect(t.offer("keep")).toBe(true);
    expect(seen).toEqual(["new keep"]);
    expect(t.offer("pass")).toBe(true); // the old one keeps it
    expect(seen).toEqual(["new keep", "new pass", "old pass"]);
    off();
    off(); // twice is harmless
    expect(t.offer("x")).toBe(true);
    expect(seen.at(-1)).toBe("old x");
  });

  it("a throwing tap keeps nothing: the chat still gets the line", () => {
    const t = createMicTaps();
    t.tap(() => {
      throw new Error("broken");
    });
    expect(t.offer("hello")).toBe(false);
    expect(createMicTaps().offer("no taps")).toBe(false);
  });

  it("counts pins; a release is once only; the first pin is announced", () => {
    const t = createMicTaps();
    let woke = 0;
    const un = t.onPin(() => woke++);
    expect(t.pinned()).toBe(false);
    const a = t.pin();
    const b = t.pin();
    expect(woke).toBe(1);
    a();
    a();
    expect(t.pinned()).toBe(true);
    b();
    expect(t.pinned()).toBe(false);
    un();
    t.pin();
    expect(woke).toBe(1);
  });

  it("is one per page", () => {
    expect(micTaps()).toBe(micTaps());
  });
});

describe("the mic session and the taps", () => {
  function session(text = "下一张") {
    let events: VadEvents | null = null;
    const logs: Record<string, unknown>[] = [];
    let spots = 0;
    const deps: MicDeps = {
      guard: { minFrameRms: 0 },
      getStream: async () => ({ id: "s", getTracks: () => [{ readyState: "live", stop() {} }] }),
      load: async (ev) => {
        events = ev;
        return { start() {}, pause() {}, flush() {}, destroy() {} };
      },
      upload: async () => text,
      log: (ev) => void logs.push(ev),
      kws: () => ({
        load: async () => {},
        spot: async () => {
          spots++;
          return { hit: false };
        },
      }),
    };
    const s = createMicSession(deps);
    const say = async () => {
      events!.onSpeechStart();
      events!.onSpeechEnd(new Float32Array(RATE));
      await tick();
      await tick();
    };
    return { s, logs, say, spots: () => spots };
  }

  it("offers each final to the taps first; a kept one never reaches the chat", async () => {
    const t = session();
    const chat: string[] = [];
    t.s.attach({ onText: (x) => chat.push(x), onPending: () => {} });
    const heard: string[] = [];
    const off = micTaps().tap((x) => (heard.push(x), true));
    await t.s.toggle();
    await t.say();
    expect(heard).toEqual(["下一张"]);
    expect(chat).toEqual([]);
    off();
    await t.say();
    expect(chat.join("")).toContain("下一张");
  });

  it("a line the tap passes on goes to the chat (or waits for one)", async () => {
    const t = session("Linky, hello");
    micTaps().tap(() => false);
    await t.s.toggle();
    await t.say();
    const chat: string[] = [];
    t.s.attach({ onText: (x) => chat.push(x), onPending: () => {} });
    expect(chat.join("")).toContain("Linky");
  });

  it("pinned: back to active at once, the gate lets everything through, and nothing turns it passive", async () => {
    const t = session("");
    await t.s.toggle();
    t.s.wake("passive");
    expect(t.s.view().wake).toBe("passive");
    const release = micTaps().pin();
    expect(t.s.view().wake).toBe("active");
    expect(t.logs).toContainEqual({
      ev: "wake",
      from: "passive",
      to: "active",
      reason: "voice-mode",
    });
    // Empty finals would count as rejections; pinned, they do not.
    for (let i = 0; i < REJECTS_TO_PASSIVE + 1; i++) await t.say();
    expect(t.s.view().wake).toBe("active");
    // The agent cannot put it to sleep either.
    t.s.wake("passive");
    t.s.wake("ignored");
    expect(t.s.view().wake).toBe("active");
    expect(t.spots()).toBe(0); // never gated
    release();
    t.s.wake("passive");
    expect(t.s.view().wake).toBe("passive");
  });

  it("a pin taken while already active changes nothing", async () => {
    const t = session();
    await t.s.toggle();
    const n = t.logs.length;
    micTaps().pin();
    expect(t.s.view().wake).toBe("active");
    expect(t.logs.length).toBe(n);
  });

  it("a retired session stops listening for pins", async () => {
    const t = session();
    await t.s.toggle();
    t.s.wake("passive");
    await t.s.retire();
    micTaps().pin();
    expect(t.s.view().wake).toBe("passive");
  });

  it("a reload's auto-resume never turns off a mic something else just turned on", async () => {
    const store = new Map<string, string>([["lk:agent:mic", "1"]]);
    const s = createMicSession({
      getStream: async () => ({ id: "s", getTracks: () => [{ readyState: "live", stop() {} }] }),
      load: async () => ({ start() {}, pause() {}, flush() {}, destroy() {} }),
      upload: async () => "",
      storage: {
        get: (k) => store.get(k) ?? null,
        set: (k, v) => void store.set(k, v),
        remove: (k) => void store.delete(k),
      },
      permission: async () => "granted",
      resumeAudio: async () => true,
    });
    const resume = s.autoResume(); // queued at page load, still waiting on its checks
    await s.toggle(); // voice mode turns the mic on first
    await resume;
    expect(s.view().state).toBe("listening");
  });

  it("tells the config in force", () => {
    const t = session();
    expect(t.s.configured()).toEqual({ label: "" });
    t.s.configure({ label: "words", localStt: "wss://mac.example/lianki-stt" });
    expect(t.s.configured().localStt).toBe("wss://mac.example/lianki-stt");
  });

  it("a newer session on the page is kept, never downgraded", () => {
    const t = session();
    (t.s as { v: number }).v = MIC_SESSION_V + 1;
    g[MIC_SESSION_KEY] = t.s;
    expect(micSession({} as MicDeps)).toBe(t.s);
  });
});
