import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { HeardVoiceRows } from "../packages/debug-chat/src/MessageDetails";
import { CHAT_LOCALES, EXTRA, EXTRA_CONTEXT } from "../packages/debug-chat/src/chat-ui-locales";
import {
  HEARD_LINES,
  LOCAL_VOICE_PIN_KEY,
  NEKO_ROTATION,
  clearHeard,
  heardFor,
  heardVersion,
  noteHeard,
  pickLocalVoice,
  pinLocalVoice,
  pinnedLocalVoice,
  subscribeHeard,
} from "../packages/debug-chat/src/voice-heard";
import { createCloudOut } from "../packages/debug-chat/src/voice-out";
import { type UtterLike, createVoice } from "../packages/debug-chat/src/voice";
import type { HeardVoice } from "../packages/debug-chat/src/voice-heard";

const tick = () => new Promise((r) => setTimeout(r, 0));

let store: Record<string, string> = {};
const g = globalThis as Record<string, unknown>;
let saved: unknown;
beforeEach(() => {
  store = {};
  saved = g.localStorage;
  g.localStorage = {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => void (store[k] = v),
    removeItem: (k: string) => void delete store[k],
  };
  clearHeard();
});
afterEach(() => {
  if (saved === undefined) delete g.localStorage;
  else g.localStorage = saved;
});

describe("voice-heard: neko-cycle resolution", () => {
  it("rotates per turn when nothing is pinned; a pin replaces the rotation", () => {
    const turns = [0, 1, 2, 3, 4, 5, 6].map((t) => pickLocalVoice("neko-cycle", t, null).name);
    expect(turns).toEqual([...NEKO_ROTATION, NEKO_ROTATION[0]]);
    expect(pickLocalVoice("neko-cycle", 3, null).cycle).toBe(true);
    expect(pickLocalVoice("neko-cycle", 3, "neko-moe")).toEqual({ name: "neko-moe", cycle: true });
    // A name that is not a local engine is no pin.
    expect(pickLocalVoice("neko-cycle", 1, "nope").name).toBe(NEKO_ROTATION[1]);
    // A named local voice is itself, never a rotation pick.
    expect(pickLocalVoice("bella", 2, "neko-moe")).toEqual({ name: "bella" });
  });

  it("the pin is a device key; only a local engine is stored; storage blocked = rotate", () => {
    expect(pinnedLocalVoice()).toBeNull();
    pinLocalVoice("neko-soft");
    expect(store[LOCAL_VOICE_PIN_KEY]).toBe("neko-soft");
    expect(pinnedLocalVoice()).toBe("neko-soft");
    pinLocalVoice("not-a-voice");
    expect(store[LOCAL_VOICE_PIN_KEY]).toBeUndefined();
    pinLocalVoice("alpha");
    pinLocalVoice(null);
    expect(pinnedLocalVoice()).toBeNull();
    g.localStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {},
    };
    expect(pinnedLocalVoice()).toBeNull();
    expect(() => pinLocalVoice("neko")).not.toThrow();
  });
});

describe("voice-heard: recording per line", () => {
  it("keeps each line's voices in order, distinct, a re-read replacing the sentence's", () => {
    const seen: number[] = [];
    const off = subscribeHeard(() => seen.push(heardVersion()));
    noteHeard("m1", "One.", { name: "neko", cycle: true });
    noteHeard("m1", "Two.", { name: "neko-moe", cycle: true });
    noteHeard("m1", "Three.", { name: "neko", cycle: true });
    noteHeard("m2", "Hi.", { name: "device:Samantha" });
    expect(heardFor("m1")).toEqual([
      { name: "neko", cycle: true },
      { name: "neko-moe", cycle: true },
    ]);
    expect(heardFor("m2")).toEqual([{ name: "device:Samantha" }]);
    // The cloud failed and speech read "Two." instead: that sentence's voice is replaced.
    noteHeard("m1", "Two.", { name: "device" });
    expect(heardFor("m1").map((v) => v.name)).toEqual(["neko", "device"]);
    // No id, or no name: nothing kept.
    noteHeard(undefined, "x", { name: "neko" });
    noteHeard("m3", "x", { name: "" });
    expect(heardFor("m3")).toEqual([]);
    expect(heardFor(undefined)).toEqual([]);
    expect(seen.length).toBe(5);
    off();
  });

  it("forgets the oldest lines past HEARD_LINES", () => {
    for (let i = 0; i <= HEARD_LINES; i++) noteHeard(`l${i}`, "x", { name: "neko" });
    expect(heardFor("l0")).toEqual([]);
    expect(heardFor(`l${HEARD_LINES}`)).toEqual([{ name: "neko" }]);
  });
});

describe("voice-out: the concrete voice of each clip reaches onvoice", () => {
  const rig = () => {
    class El {
      src = "";
      currentTime = 0;
      volume = 1;
      preload = "";
      paused = true;
      onended: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onloadedmetadata: (() => void) | null = null;
      play() {
        this.paused = false;
        return Promise.resolve();
      }
      pause() {}
      load() {}
    }
    const fetched: string[] = [];
    let n = 0;
    const out = createCloudOut({
      fetch: async (u) => {
        fetched.push(u);
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          blob: async () => new Blob(["x"]),
        };
      },
      element: () => new El(),
      ctx: () => null,
      toUrl: () => `blob:${++n}`,
    });
    const heard: HeardVoice[] = [];
    const ev = { onend() {}, onerror() {}, onvoice: (v: HeardVoice) => void heard.push(v) };
    return { out, fetched, heard, ev };
  };
  const voiceOf = (u: string) => new URL(u).searchParams.get("voice");

  it("bright lines take turns through the rotation, one voice per clip", async () => {
    const r = rig();
    for (const t of ["A.", "B.", "C."]) {
      r.out.play({ text: t, lang: "en", at: 0, volume: 1, voice: "bright" }, r.ev);
      await tick();
      await tick();
    }
    const asked = r.fetched.map(voiceOf);
    expect(r.heard.map((v) => v.name)).toEqual(asked as string[]);
    expect(r.heard.every((v) => v.cycle)).toBe(true);
    // Consecutive turns of the rotation (where it starts depends on earlier clips in this process).
    const i = NEKO_ROTATION.indexOf(asked[0] as (typeof NEKO_ROTATION)[number]);
    expect(asked).toEqual([0, 1, 2].map((k) => NEKO_ROTATION[(i + k) % NEKO_ROTATION.length]));
  });

  it("a pinned voice reads every bright line, and a clip fetched before the pin is not reused", async () => {
    const r = rig();
    r.out.play({ text: "Same.", lang: "en", at: 0, volume: 1, voice: "bright" }, r.ev);
    await tick();
    await tick();
    pinLocalVoice("neko-soft");
    for (const t of ["Same.", "Other."]) {
      r.out.play({ text: t, lang: "en", at: 0, volume: 1, voice: "bright" }, r.ev);
      await tick();
      await tick();
    }
    expect(r.fetched.slice(1).map(voiceOf)).toEqual(["neko-soft", "neko-soft"]);
    expect(r.heard.slice(1)).toEqual([
      { name: "neko-soft", cycle: true },
      { name: "neko-soft", cycle: true },
    ]);
  });

  it("the main lane's cloud voice is named by its speaker", async () => {
    const r = rig();
    r.out.play({ text: "Hello.", lang: "en", at: 0, volume: 1 }, r.ev);
    await tick();
    await tick();
    expect(r.heard).toEqual([{ name: "aura:luna" }]);
  });
});

describe("message details: the voice rows", () => {
  const words = EXTRA.en;
  const render = (heard: HeardVoice[], pinned: string | null) =>
    renderToStaticMarkup(
      <HeardVoiceRows heard={heard} pinned={pinned} words={words} onPin={() => {}} />,
    );

  it("names the voice; a rotated one offers 'Use this voice'", () => {
    const html = render([{ name: "neko-moe", cycle: true }], null);
    expect(html).toContain("Voice: neko-moe");
    expect(html).toContain('data-testid="debug-chat-voice-pin"');
    expect(html).toContain("Use this voice");
    expect(html).not.toContain("debug-chat-voice-unpin");
  });

  it("a voice that is not from the rotation offers no pin", () => {
    const html = render([{ name: "device:Samantha" }], "neko");
    expect(html).toContain("Voice: device:Samantha");
    expect(html).not.toContain("debug-chat-voice-pin");
    expect(html).not.toContain("debug-chat-voice-unpin");
  });

  it("pinned: the pin is shown plainly with 'Unpin (rotate)', other rotated voices can replace it", () => {
    const html = render(
      [
        { name: "neko-moe", cycle: true },
        { name: "alpha", cycle: true },
      ],
      "neko-moe",
    );
    expect(html).toContain("Pinned on this device: neko-moe");
    expect(html).toContain("Unpin (rotate)");
    // Only alpha (not the pinned one) offers "Use this voice".
    expect(html.match(/debug-chat-voice-pin"/g)?.length).toBe(1);
  });

  it("nothing heard: no rows", () => {
    expect(render([], null)).toBe("");
  });

  it("the session notes the device voice of each spoken sentence under its line id", () => {
    const spoken: UtterLike[] = [];
    const v = createVoice({
      synth: () => ({ speak: (u) => void spoken.push(u), cancel() {} }),
      utter: (text) =>
        ({
          text,
          onend: null,
          onerror: null,
          onboundary: null,
          voice: { name: "Samantha" },
        }) as UtterLike,
      enabled: () => true,
      here: () => true,
      setTimer: () => 0,
      clearTimer: () => {},
    });
    expect(v.reply("One. Two.", { id: "line-9" })).toBe(true);
    expect(heardFor("line-9")).toEqual([{ name: "device:Samantha" }]);
    spoken[0]!.onend?.();
    expect(spoken).toHaveLength(2);
    expect(heardFor("line-9")).toEqual([{ name: "device:Samantha" }]);
    v.stop();
  });

  it("the strings exist in all 16 locales, each with a context line, {name} kept", () => {
    for (const k of ["voiceUsed", "voiceUseThis", "voicePinned", "voiceUnpin"] as const) {
      expect(EXTRA_CONTEXT[k].length).toBeGreaterThan(40);
      for (const l of CHAT_LOCALES) {
        expect(EXTRA[l][k].trim().length).toBeGreaterThan(0);
        if (k === "voiceUsed" || k === "voicePinned") expect(EXTRA[l][k]).toContain("{name}");
      }
    }
  });
});
