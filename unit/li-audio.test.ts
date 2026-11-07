// Li's sound hub, phase 0 (packages/debug-chat/src/li-audio.ts, li-client.ts;
// docs/li-sound-hub.md): off it touches nothing, on it only observes. All on
// fakes: no microphone is opened and nothing makes a sound.
import { afterEach, describe, expect, it } from "bun:test";
import { AUDIO_CLAIM, AUDIO_PRIO, AUDIO_RELEASE, audioOwner } from "@lianki/debug-chat/audio-claim";
import { createPageAudio } from "@lianki/debug-chat/page-audio";
import { LI_KEY, LI_V, type LiEnv, createLiHub, liHub } from "@lianki/debug-chat/li-audio";
import { browserLiEnv, startLiClient } from "@lianki/debug-chat/li-client";

const g = globalThis as unknown as Record<string, unknown>;
afterEach(() => void delete g[LI_KEY]);

const tick = () => new Promise<void>((r) => queueMicrotask(r));

class Track extends EventTarget {
  kind = "audio";
  readyState = "live";
  stop() {
    this.readyState = "ended";
  }
}
class Stream {
  tracks = [new Track()];
  getTracks() {
    return this.tracks;
  }
}
class El extends EventTarget {}

/** A fake page: a window, the page-audio registry, taps, getUserMedia, media and speech. */
function fakePage() {
  const target = new EventTarget();
  const added: string[] = [];
  const add = target.addEventListener.bind(target);
  target.addEventListener = ((t: string, f: EventListener) => {
    added.push(t);
    add(t, f);
  }) as typeof target.addEventListener;
  const timers: (() => void)[] = [];
  const pa = createPageAudio({ setTimer: (f) => timers.push(f), clearTimer: () => {} });
  const taps = {
    isBlocked: false,
    isPinned: false,
    blocked: () => taps.isBlocked,
    pinned: () => taps.isPinned,
  };
  const calls: unknown[] = [];
  const streams: Stream[] = [];
  const gumPromises: Promise<Stream>[] = [];
  const mediaProto = Object.create({
    play(this: unknown, ...a: unknown[]) {
      calls.push(["play", this, a]);
      return "played";
    },
  }) as { play: (...a: unknown[]) => unknown };
  const speechProto = {
    speak(this: unknown, u: unknown) {
      calls.push(["speak", this, u]);
    },
  };
  const speech = Object.create(speechProto) as { speak: (u: unknown) => void };
  const media = Object.create({
    getUserMedia(this: unknown, c: unknown) {
      calls.push(["gum", this, c]);
      const s = new Stream();
      streams.push(s);
      const p = Promise.resolve(s);
      gumPromises.push(p);
      return p;
    },
  }) as { getUserMedia: (c: unknown) => Promise<Stream> };
  const env: LiEnv = {
    target,
    pageAudio: () => pa,
    taps: () => taps,
    micState: () => null,
    media,
    mediaProto,
    speech,
  };
  return {
    target,
    added,
    pa,
    taps,
    calls,
    streams,
    gumPromises,
    media,
    mediaProto,
    speech,
    env,
    timers,
  };
}

describe("li hub, flag off: pass-through", () => {
  it("starts nothing: no hub, no wrapper, no listener, no log", async () => {
    const p = fakePage();
    const before = { gum: p.media.getUserMedia, play: p.mediaProto.play, speak: p.speech.speak };
    const log: unknown[] = [];
    const stop = startLiClient({ on: false, log: (e) => void log.push(e), env: p.env });
    expect(g[LI_KEY]).toBeUndefined();
    expect(p.media.getUserMedia).toBe(before.gum);
    expect(p.mediaProto.play).toBe(before.play);
    expect(p.speech.speak).toBe(before.speak);
    expect(Object.hasOwn(p.media, "getUserMedia")).toBe(false);
    expect(Object.hasOwn(p.speech, "speak")).toBe(false);
    expect(p.added).toEqual([]);
    // The page's sound goes on as ever, and nobody writes a line.
    p.pa.setMic(true);
    const a = audioOwner({ id: "card:1", prio: AUDIO_PRIO.card, target: p.target });
    expect(a.claim()).toBe(true);
    a.release();
    await p.media.getUserMedia({ audio: true });
    await tick();
    stop();
    expect(log).toEqual([]);
  });
});

describe("li hub, flag on: observes only", () => {
  it("wrappers call the original with the same this and arguments, and return its result", async () => {
    const p = fakePage();
    const stop = startLiClient({ on: true, log: () => {}, env: p.env });
    const c = { audio: { echoCancellation: true } };
    const got = p.media.getUserMedia(c);
    expect(got).toBe(p.gumPromises[0]); // the very same promise
    expect(p.calls[0]).toEqual(["gum", p.media, c]);
    const el = new El();
    expect(p.mediaProto.play.call(el, 1, 2)).toBe("played");
    expect(p.calls[1]).toEqual(["play", el, [1, 2]]);
    const u = new El();
    p.speech.speak(u);
    expect(p.calls[2]).toEqual(["speak", p.speech, u]);
    stop();
    // Off again: the objects are as they were (no own property left behind).
    expect(Object.hasOwn(p.media, "getUserMedia")).toBe(false);
    expect(Object.hasOwn(p.mediaProto, "play")).toBe(false);
    expect(Object.hasOwn(p.speech, "speak")).toBe(false);
    expect(g[LI_KEY]).toBeUndefined();
  });

  it("never changes who gets the page's sound (audio-claim works as without it)", async () => {
    const p = fakePage();
    const stop = startLiClient({ on: true, log: () => {}, env: p.env });
    const log: string[] = [];
    const para = audioOwner({
      id: "para:1",
      prio: AUDIO_PRIO.para,
      target: p.target,
      onYield: () => void log.push("para yield"),
      onResume: () => void log.push("para resume"),
    });
    const li = audioOwner({ id: "li:1", prio: AUDIO_PRIO.li, target: p.target });
    const card = audioOwner({ id: "card:1", prio: AUDIO_PRIO.card, target: p.target });
    expect(para.claim()).toBe(true);
    expect(li.claim()).toBe(true);
    expect(card.claim()).toBe(false);
    li.release();
    expect(card.state()).toBe("holding");
    expect(para.state()).toBe("waiting");
    card.release();
    expect(log).toEqual(["para yield", "para resume"]);
    stop();
  });

  it("reports who holds the mic, the audio owner and what plays", async () => {
    const p = fakePage();
    const log: Record<string, unknown>[] = [];
    const stop = startLiClient({ on: true, log: (e) => void log.push(e), env: p.env });
    const owners = () => log.filter((e) => e.ev === "audio-owner");
    expect(owners().at(-1)).toMatchObject({ mic: [], captures: 0, claim: null, playing: [] });

    p.pa.setMic(true);
    expect(owners().at(-1)).toMatchObject({ mic: ["chat"] });
    await p.media.getUserMedia({ audio: true });
    await tick();
    expect(owners().at(-1)).toMatchObject({ captures: 1 });
    // A video-only request is not a capture of the mic.
    await p.media.getUserMedia({ video: true });
    await tick();
    expect(owners().at(-1)).toMatchObject({ captures: 1 });

    const card = audioOwner({ id: "card:7", prio: AUDIO_PRIO.card, target: p.target });
    card.claim();
    await tick();
    expect(owners().at(-1)).toMatchObject({ claim: "card:7" });

    const el = new El();
    p.mediaProto.play.call(el);
    expect(owners().at(-1)).toMatchObject({ playing: [] }); // asked to play, not yet sounding
    el.dispatchEvent(new Event("playing"));
    expect(owners().at(-1)).toMatchObject({ playing: ["media#1"] });
    el.dispatchEvent(new Event("ended"));
    expect(owners().at(-1)).toMatchObject({ playing: [] });

    card.release();
    expect(owners().at(-1)).toMatchObject({ claim: null });
    // A cancelled claim is not the owner.
    const li = audioOwner({ id: "li:2", prio: AUDIO_PRIO.li, target: p.target });
    li.claim();
    const para = audioOwner({ id: "para:3", prio: AUDIO_PRIO.para, target: p.target });
    expect(para.claim()).toBe(false);
    await tick();
    expect(owners().at(-1)).toMatchObject({ claim: "li:2" });

    // Each line is a change: the same view twice is one line.
    const n = owners().length;
    p.pa.setMic(true);
    expect(owners().length).toBe(n);
    expect(log.some((e) => e.ev === "audio-conflict")).toBe(false);
    stop();
  });

  it("an overlap: two sinks sounding at once, reported once as it begins", () => {
    const p = fakePage();
    const log: Record<string, unknown>[] = [];
    const stop = startLiClient({ on: true, log: (e) => void log.push(e), env: p.env });
    const el = new El();
    p.mediaProto.play.call(el);
    el.dispatchEvent(new Event("playing"));
    const u = new El();
    p.speech.speak(u);
    u.dispatchEvent(new Event("start"));
    const conflicts = () => log.filter((e) => e.ev === "audio-conflict");
    expect(conflicts()).toEqual([
      expect.objectContaining({ kind: "overlap", playing: ["media#1", "speech#2"] }),
    ]);
    // Still overlapping: no second line.
    const el2 = new El();
    p.mediaProto.play.call(el2);
    el2.dispatchEvent(new Event("playing"));
    expect(conflicts().length).toBe(1);
    // Ends, then begins again: a new line.
    u.dispatchEvent(new Event("end"));
    el2.dispatchEvent(new Event("pause"));
    expect(conflicts().length).toBe(1);
    u.dispatchEvent(new Event("start"));
    expect(conflicts().length).toBe(2);
    stop();
  });

  it("two captures: two live mic streams, or the chat mic on while /vibe owns the room", async () => {
    const p = fakePage();
    const log: Record<string, unknown>[] = [];
    const stop = startLiClient({ on: true, log: (e) => void log.push(e), env: p.env });
    const conflicts = () => log.filter((e) => e.ev === "audio-conflict");
    await p.media.getUserMedia({ audio: true });
    await tick();
    expect(conflicts()).toEqual([]);
    await p.media.getUserMedia({ audio: true });
    await tick();
    expect(conflicts()).toEqual([expect.objectContaining({ kind: "two-captures", captures: 2 })]);
    // The first is stopped: seen at the next change.
    p.streams[0].tracks[0].stop();
    p.pa.setMic(false);
    p.pa.setMic(true);
    expect(log.filter((e) => e.ev === "audio-owner").at(-1)).toMatchObject({ captures: 1 });
    p.streams[1].tracks[0].stop();
    p.taps.isBlocked = true; // /vibe took the room while the chat mic still says on
    p.pa.setMic(false);
    p.pa.setMic(true);
    expect(conflicts().at(-1)).toMatchObject({ kind: "two-captures", mic: ["chat", "vibe"] });
    stop();
  });
});

describe("li hub registry", () => {
  it("one hub per page; an older one is retired, a newer one kept", () => {
    const p = fakePage();
    const a = liHub(p.env);
    expect(liHub(p.env)).toBe(a);
    let retired = 0;
    g[LI_KEY] = { v: LI_V - 1, retire: () => void retired++ };
    const b = liHub(p.env);
    expect(retired).toBe(1);
    expect(b.v).toBe(LI_V);
    const newer = { v: LI_V + 1, retire: () => void retired++ };
    g[LI_KEY] = newer;
    expect(liHub(p.env) as unknown).toBe(newer);
    expect(retired).toBe(1);
    a.retire();
    b.retire();
  });

  it("a retired hub's wrappers come off only while still its own", () => {
    const p = fakePage();
    const hub = createLiHub(p.env);
    const mine = p.media.getUserMedia;
    const later = (c: unknown) => mine(c); // someone wrapped it after us
    p.media.getUserMedia = later as typeof mine;
    hub.retire();
    expect(p.media.getUserMedia).toBe(later);
    expect(Object.hasOwn(p.speech, "speak")).toBe(false);
  });

  it("events after retiring change nothing and throw nothing", async () => {
    const p = fakePage();
    const hub = createLiHub(p.env);
    const seen: unknown[] = [];
    hub.subscribe((v) => void seen.push(v));
    hub.retire();
    p.target.dispatchEvent(new CustomEvent(AUDIO_CLAIM, { detail: { id: "li:1", prio: 3 } }));
    p.target.dispatchEvent(new CustomEvent(AUDIO_RELEASE, { detail: { id: "li:1" } }));
    p.pa.setMic(true);
    await tick();
    expect(seen.length).toBe(1);
  });
});

describe("li client: the page's own pieces", () => {
  it("reads the mic session and taps only if they exist, and never makes them", () => {
    const keep = { mic: g.__lkMic, taps: g.__lkMicTaps };
    delete g.__lkMic;
    delete g.__lkMicTaps;
    try {
      const env = browserLiEnv();
      expect(env.taps?.()).toBeNull();
      expect(env.micState?.()).toBeNull();
      expect(g.__lkMicTaps).toBeUndefined();
      g.__lkMic = { view: () => ({ state: "listening" }) };
      const taps = { blocked: () => true, pinned: () => false };
      g.__lkMicTaps = taps;
      expect(env.micState?.()).toBe("listening");
      expect(env.taps?.()).toBe(taps);
      expect(typeof env.pageAudio?.()?.playing).toBe("function");
      // Bun has no media devices, media elements or speech: nothing to wrap.
      const hub = createLiHub({ ...env, target: null });
      expect(hub.view()).toMatchObject({ mic: ["chat", "vibe"], captures: 0 });
      hub.retire();
    } finally {
      g.__lkMic = keep.mic;
      g.__lkMicTaps = keep.taps;
      if (keep.mic === undefined) delete g.__lkMic;
      if (keep.taps === undefined) delete g.__lkMicTaps;
    }
  });
});
