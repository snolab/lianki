import { afterEach, describe, expect, it } from "bun:test";
import {
  type AutoOffReason,
  autoOffNote,
  micLook,
  onTrackLost,
  selfHealing,
  trackNote,
} from "@lianki/debug-chat/mic-off";
import {
  type LifeEvent,
  MIC_ON_KEY,
  MIC_SESSION_KEY,
  type MicDeps,
  type StreamLike,
  createMicSession,
} from "@lianki/debug-chat/mic-session";
import { SttError, type Vad, type VadEvents } from "@lianki/debug-chat/mic";
import { EXTRA_CONTEXT, chatExtra } from "@lianki/debug-chat/chat-ui-locales";

// Fakes only: no microphone, no AudioContext, no sound.
const tick = () => new Promise((r) => setTimeout(r, 0));

type Track = {
  readyState: string;
  muted: boolean;
  stop(): void;
  addEventListener(type: string, f: () => void): void;
  fire(type: string): void;
};

function fakes(over: Partial<MicDeps> = {}) {
  const store = new Map<string, string>();
  const logs: Record<string, unknown>[] = [];
  const tracks: Track[] = [];
  const page = { visible: true };
  let life: ((ev: LifeEvent) => void) | null = null;
  let events: VadEvents | null = null;
  let gum = 0;
  let n = 0;
  const makeStream = (): StreamLike => {
    const on = new Map<string, (() => void)[]>();
    const track: Track = {
      readyState: "live",
      muted: false,
      stop() {
        track.readyState = "ended";
      },
      addEventListener(type, f) {
        on.set(type, [...(on.get(type) ?? []), f]);
      },
      fire(type) {
        if (type === "ended") track.readyState = "ended";
        if (type === "mute") track.muted = true;
        if (type === "unmute") track.muted = false;
        for (const f of on.get(type) ?? []) f();
      },
    };
    tracks.push(track);
    return { id: `s${++n}`, getTracks: () => [track] };
  };
  const deps: MicDeps = {
    guard: { minFrameRms: 0 },
    getStream: async () => {
      gum++;
      return makeStream();
    },
    load: async (ev: VadEvents): Promise<Vad> => {
      events = ev;
      return { start() {}, pause() {}, flush() {}, destroy() {} };
    },
    upload: async () => "hello there.",
    storage: {
      get: (k) => store.get(k) ?? null,
      set: (k, v) => void store.set(k, v),
      remove: (k) => void store.delete(k),
    },
    log: (ev) => void logs.push(ev),
    visible: () => page.visible,
    lifecycle: (f) => {
      life = f;
      return () => {
        life = null;
      };
    },
    now: () => 1000,
    ...over,
  };
  return {
    deps,
    store,
    logs,
    tracks,
    page,
    gum: () => gum,
    life: (ev: LifeEvent) => life?.(ev),
    hasLife: () => !!life,
    events: () => events,
    last: () => tracks[tracks.length - 1],
  };
}

const settle = async () => {
  for (let i = 0; i < 5; i++) await tick();
};

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[MIC_SESSION_KEY];
});

describe("mic-off: the pure decisions", () => {
  it("every state has its own look: on, off by him, off by itself", () => {
    expect(micLook({ state: "listening", resume: false })).toBe("on");
    expect(micLook({ state: "loading", resume: false })).toBe("on");
    expect(micLook({ state: "off", resume: false })).toBe("off");
    expect(micLook({ state: "off", resume: true })).toBe("off-self");
    expect(micLook({ state: "off", resume: false, auto: { reason: "other-tab", at: 1 } })).toBe(
      "off-self",
    );
  });

  it("a lost track: reopened when visible, waits when hidden, nothing when off", () => {
    expect(onTrackLost({ on: true, visible: true })).toBe("reopen");
    expect(onTrackLost({ on: true, visible: false })).toBe("wait");
    expect(onTrackLost({ on: false, visible: true })).toBe("none");
    expect(selfHealing("track-ended")).toBe(true);
    expect(selfHealing("other-tab")).toBe(false);
  });

  it("each reason has a note; the ones without their own say it failed", () => {
    const t = { micCutOff: "cut", micOtherTab: "tab", micSignIn: "sign", micFailed: "fail" };
    const all: [AutoOffReason, string][] = [
      ["track-ended", "cut"],
      ["other-tab", "tab"],
      ["sign-in", "sign"],
      ["vibe", "blocked"],
      ["reopen-failed", "fail"],
      ["migrate-failed", "fail"],
    ];
    for (const [r, want] of all) expect(autoOffNote(r, t, "blocked")).toBe(want);
  });

  it("the track's note for the dev log", () => {
    expect(trackNote(undefined)).toBe("none");
    expect(trackNote({ readyState: "live" })).toBe("live");
    expect(trackNote({ readyState: "live", muted: true })).toBe("live+muted");
  });

  it("the new notes carry a context line and every locale", () => {
    expect(EXTRA_CONTEXT.micCutOff).toContain("by itself");
    expect(EXTRA_CONTEXT.micOtherTab).toContain("another open Lianki page");
    for (const lang of ["en", "zh", "ja", "ko", "de", "ar"]) {
      expect(chatExtra(lang).micCutOff.length).toBeGreaterThan(0);
      expect(chatExtra(lang).micOtherTab.length).toBeGreaterThan(0);
    }
    expect(chatExtra("zh").micOtherTab).not.toBe(chatExtra("en").micOtherTab);
  });
});

describe("mic-off: the session", () => {
  it("a track the system ends while visible is reopened at once, never shown as off", async () => {
    const f = fakes();
    const s = createMicSession(f.deps);
    const states: string[] = [];
    await s.toggle();
    s.subscribe((v) => states.push(v.state));
    f.last().fire("ended");
    await settle();
    expect(f.gum()).toBe(2);
    expect(s.view().state).toBe("listening");
    expect(s.view().auto).toBeUndefined();
    expect(states).not.toContain("off");
    expect(f.store.get(MIC_ON_KEY)).toBe("1");
    expect(
      f.logs.some((e) => e.ev === "mic-track" && e.what === "ended" && e.then === "reopen"),
    ).toBe(true);
    expect(f.logs.some((e) => e.ev === "mic-recover" && e.ok === true)).toBe(true);
  });

  it("ended while hidden (Android backgrounds the app): reopened when it is visible again", async () => {
    const f = fakes();
    const s = createMicSession(f.deps);
    await s.toggle();
    f.page.visible = false;
    f.life("hidden");
    f.last().fire("ended");
    await settle();
    expect(f.gum()).toBe(1); // no getUserMedia from a hidden page
    f.life("freeze");
    f.page.visible = true;
    f.life("visible");
    await settle();
    expect(f.gum()).toBe(2);
    expect(s.view().state).toBe("listening");
    const life = f.logs.filter((e) => e.ev === "mic-life").map((e) => e.what);
    expect(life).toEqual(["hidden", "freeze", "visible"]);
    expect(f.logs.find((e) => e.ev === "mic-life" && e.what === "freeze")?.lost).toBe(
      "track-ended",
    );
  });

  it("a stream found dead on return (the event was missed while frozen) is reopened too", async () => {
    const f = fakes();
    const s = createMicSession(f.deps);
    await s.toggle();
    f.last().readyState = "ended"; // no event
    f.life("resume");
    await settle();
    expect(f.gum()).toBe(2);
    expect(s.view().state).toBe("listening");
    // A live stream on return: nothing happens.
    f.life("pageshow");
    await settle();
    expect(f.gum()).toBe(2);
  });

  it("a lost track that cannot come back shows off by itself, with its reason, and logs why", async () => {
    let refuse = false;
    const f = fakes();
    const base = f.deps.getStream;
    const s = createMicSession({
      ...f.deps,
      getStream: async () => {
        if (refuse) throw Object.assign(new Error("gone"), { name: "NotFoundError" });
        return base();
      },
    });
    await s.toggle();
    refuse = true;
    f.last().fire("ended");
    await settle();
    expect(s.view().state).toBe("off");
    expect(s.view().auto).toEqual({ reason: "track-ended", at: 1000 });
    expect(micLook(s.view())).toBe("off-self");
    expect(f.store.get(MIC_ON_KEY)).toBeUndefined();
    expect(
      f.logs.some((e) => e.ev === "mic-off" && e.by === "auto" && e.reason === "track-ended"),
    ).toBe(true);
    // One tap resumes, and the state is plain on again.
    refuse = false;
    await s.toggle();
    expect(s.view().state).toBe("listening");
    expect(s.view().auto).toBeUndefined();
  });

  it("mute and unmute are only logged; an old stream's events are ignored", async () => {
    const f = fakes();
    const s = createMicSession(f.deps);
    await s.toggle();
    const first = f.last();
    first.fire("mute");
    first.fire("unmute");
    expect(s.view().state).toBe("listening");
    expect(f.logs.filter((e) => e.ev === "mic-track").map((e) => e.what)).toEqual([
      "mute",
      "unmute",
    ]);
    await s.reopen();
    first.fire("ended");
    first.fire("mute");
    await settle();
    expect(f.gum()).toBe(2);
    expect(f.logs.filter((e) => e.ev === "mic-track").length).toBe(2);
  });

  it("his off is plain and logged with its source; nothing reopens it afterwards", async () => {
    const f = fakes();
    const s = createMicSession(f.deps);
    await s.toggle();
    await s.toggle();
    expect(micLook(s.view())).toBe("off");
    expect(f.logs.some((e) => e.ev === "mic-off" && e.by === "user" && e.reason === "tap")).toBe(
      true,
    );
    await s.toggle();
    await s.off("escape");
    expect(f.logs.some((e) => e.ev === "mic-off" && e.reason === "escape")).toBe(true);
    f.last().fire("ended");
    f.life("visible");
    await settle();
    expect(f.gum()).toBe(2);
    expect(s.view().state).toBe("off");
    // Lifecycle lines only while the mic is on.
    expect(f.logs.some((e) => e.ev === "mic-life")).toBe(false);
  });

  it("an explicit off while hidden cancels the reopen waiting for visible", async () => {
    const f = fakes();
    const s = createMicSession(f.deps);
    await s.toggle();
    f.page.visible = false;
    f.last().fire("ended");
    await s.off();
    f.page.visible = true;
    f.life("visible");
    await settle();
    expect(f.gum()).toBe(1);
  });

  it("another tab took the mic: off by itself, its reason shown, not resumed after a reload", async () => {
    const f = fakes();
    const s = createMicSession(f.deps);
    await s.autoOff("other-tab"); // off already: nothing
    expect(s.view().auto).toBeUndefined();
    await s.toggle();
    await s.autoOff("other-tab");
    expect(s.view().state).toBe("off");
    expect(s.view().auto?.reason).toBe("other-tab");
    expect(f.last().readyState).toBe("ended");
    expect(f.store.get(MIC_ON_KEY)).toBeUndefined();
    expect(
      f.logs.some((e) => e.ev === "mic-off" && e.by === "auto" && e.reason === "other-tab"),
    ).toBe(true);
    // His own off clears the reason.
    await s.toggle();
    await s.off();
    expect(s.view().auto).toBeUndefined();
  });

  it("a 401 from speech recognition: off by itself (sign-in), not his off", async () => {
    const f = fakes({
      upload: async () => {
        throw new SttError(401, "sign in");
      },
    });
    const s = createMicSession(f.deps);
    await s.toggle();
    f.events()?.onSpeechStart();
    f.events()?.onSpeechEnd(new Float32Array(16000));
    await settle();
    expect(s.view().state).toBe("off");
    expect(s.view().auto?.reason).toBe("sign-in");
    expect(f.store.get(MIC_ON_KEY)).toBeUndefined();
  });

  it("a refused tap is an error note, not off by itself", async () => {
    const f = fakes({
      getStream: async () => {
        throw Object.assign(new Error("denied"), { name: "NotAllowedError" });
      },
    });
    const s = createMicSession(f.deps);
    await s.toggle();
    expect(s.view().state).toBe("off");
    expect(s.view().auto).toBeUndefined();
    expect(s.view().error).toBeTruthy();
  });

  it("a reopen (echo switch) that fails shows off by itself", async () => {
    let refuse = false;
    const f = fakes();
    const base = f.deps.getStream;
    const s = createMicSession({
      ...f.deps,
      getStream: async () => {
        if (refuse) throw new Error("busy");
        return base();
      },
    });
    await s.toggle();
    refuse = true;
    expect(await s.reopen()).toBe(false);
    expect(s.view().auto?.reason).toBe("reopen-failed");
  });

  it("a reload while hidden waits for visible before asking for the mic", async () => {
    const f = fakes({ permission: async () => "granted", resumeAudio: async () => true });
    f.store.set(MIC_ON_KEY, "1");
    f.page.visible = false;
    const s = createMicSession(f.deps);
    await s.autoResume();
    expect(f.gum()).toBe(0);
    expect(f.logs.some((e) => e.ev === "mic-resume" && e.path === "wait-visible")).toBe(true);
    f.life("hidden"); // still hidden: logged (a resume is waiting), nothing opened
    f.life("visible"); // the event, but visible() still says hidden
    await settle();
    expect(f.gum()).toBe(0);
    f.page.visible = true;
    f.life("visible");
    await settle();
    expect(f.gum()).toBe(1);
    expect(s.view().state).toBe("listening");
  });

  it("a migrated session whose mic cannot come back says so; retiring drops the lifecycle", async () => {
    const f = fakes({
      getStream: async () => {
        throw new Error("busy");
      },
    });
    const s = createMicSession(f.deps, { stream: null, on: true });
    await settle();
    expect(s.view().auto?.reason).toBe("migrate-failed");
    expect(f.logs.some((e) => e.ev === "mic-off" && e.reason === "migrate-failed")).toBe(true);
    await s.retire();
    expect(f.hasLife()).toBe(false);
  });

  it("a migrated session keeps watching the stream it was handed", async () => {
    const f = fakes();
    const kept = await f.deps.getStream();
    const s = createMicSession(f.deps, { stream: kept, on: true });
    await settle();
    expect(s.view().state).toBe("listening");
    expect(s.view().auto).toBeUndefined();
    f.last().fire("ended");
    await settle();
    expect(f.gum()).toBe(2);
    expect(s.view().state).toBe("listening");
  });

  it("/vibe taking the room is off by itself (vibe)", async () => {
    const { micTaps } = await import("@lianki/debug-chat/mic-taps");
    const f = fakes();
    const s = createMicSession(f.deps);
    await s.toggle();
    const taps = micTaps() as { block?: () => () => void };
    const unblock = taps.block?.();
    await settle();
    if (unblock) {
      expect(s.view().state).toBe("off");
      expect(s.view().auto?.reason).toBe("vibe");
      unblock();
    }
  });
});
