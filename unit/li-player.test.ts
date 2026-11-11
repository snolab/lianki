// Li's player (packages/debug-chat/src/li-player.ts; docs/li-sound-hub.md,
// "Playing audio from an agent"): one player for every kind of line audio,
// the page's audio owner, the mic rule, the tap fallback. All on fakes: a
// fake element whose play() is a promise the test settles, no sound at all.
import { afterEach, describe, expect, it } from "bun:test";
import { AUDIO_CLAIM, AUDIO_PRIO, AUDIO_RELEASE, audioOwner } from "@lianki/debug-chat/audio-claim";
import {
  LI_PLAY_KEY,
  LI_PLAY_V,
  type LiPlayEnv,
  type LiPlayer,
  type MediaElLike,
  type PlaySink,
  autoPlayLine,
  browserPlayEnv,
  createLiPlayer,
  elementSource,
  liPlayer,
  silentWav,
} from "@lianki/debug-chat/li-player";
import type { LineAudio } from "@lianki/debug-chat/play-audio";

const g = globalThis as unknown as Record<string, unknown>;
afterEach(() => void delete g[LI_PLAY_KEY]);

const tick = async (n = 3) => {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => queueMicrotask(r));
};

/** A fake <audio>: play() returns a promise the test settles; events by hand. */
class El extends EventTarget implements MediaElLike {
  src = "";
  paused = true;
  currentTime = 0;
  duration = NaN;
  plays: { resolve: () => void; reject: (e: unknown) => void }[] = [];
  hls = "";
  auto: "resolve" | "reject" | "manual" = "resolve";
  rejectWith: unknown = Object.assign(new Error("x"), { name: "NotAllowedError" });
  removed = 0;
  play() {
    return new Promise<void>((resolve, reject) => {
      const done = () => {
        this.paused = false;
        resolve();
      };
      if (this.auto === "resolve") done();
      else if (this.auto === "reject") reject(this.rejectWith);
      else this.plays.push({ resolve: done, reject });
    });
  }
  pause() {
    this.paused = true;
  }
  load() {}
  removeAttribute(n: string) {
    if (n === "src") {
      this.src = "";
      this.removed++;
    }
  }
  canPlayType(t: string) {
    return t === "application/vnd.apple.mpegurl" ? this.hls : "maybe";
  }
  fire(t: string) {
    this.dispatchEvent(new Event(t));
  }
}

type Page = {
  el: El;
  env: LiPlayEnv;
  win: EventTarget;
  logs: Record<string, unknown>[];
  mic: { open: boolean; subs: Set<() => void> };
  files: string[];
};

function page(over: Partial<LiPlayEnv> = {}): Page {
  const el = new El();
  const win = new EventTarget();
  const logs: Record<string, unknown>[] = [];
  const mic = { open: false, subs: new Set<() => void>() };
  const files: string[] = [];
  const env: LiPlayEnv = {
    el: () => el,
    resolveFile: async (id) => {
      files.push(id);
      return `https://lianki.com/api/my/files/${id}/play?exp=1&sig=x`;
    },
    micOpen: () => mic.open,
    onMic: (f) => {
      mic.subs.add(f);
      return () => void mic.subs.delete(f);
    },
    activated: () => false,
    target: win,
    log: (e) => logs.push(e),
    ...over,
  };
  return { el, env, win, logs, mic, files };
}
const setMic = (p: Page, open: boolean) => {
  p.mic.open = open;
  for (const f of [...p.mic.subs]) f();
};

const FILE: LineAudio = { src: "https://cdn.example.com/a.mp3", kind: "file", mime: "audio/mpeg" };
const LIVE: LineAudio = { src: "https://ice.example.com/stream", kind: "stream" };
const HLS: LineAudio = {
  src: "https://live.example.com/x.m3u8",
  kind: "stream",
  mime: "application/vnd.apple.mpegurl",
};

describe("playing a line", () => {
  it("a file plays on the page's element, with progress, and ends", async () => {
    const p = page();
    const pl = createLiPlayer(p.env);
    const seen: string[] = [];
    pl.subscribe((v) => seen.push(v.status));
    p.el.duration = 10;
    const v = await pl.play("m1", FILE);
    expect(v).toMatchObject({ id: "m1", status: "playing", kind: "file", live: false, dur: 10 });
    expect(p.el.src).toBe(FILE.src);
    p.el.currentTime = 3.2;
    p.el.fire("timeupdate");
    expect(pl.view().pos).toBe(3.2);
    p.el.currentTime = 3.6; // the same second: no change sent
    const before = seen.length;
    p.el.fire("timeupdate");
    expect(seen.length).toBe(before);
    p.el.fire("ended");
    expect(pl.view().status).toBe("ended");
    expect(p.el.removed).toBe(1);
    expect(seen).toEqual(["idle", "loading", "playing", "playing", "ended"]);
    expect(p.logs.map((l) => l.outcome)).toEqual(["playing", "ended"]);
    expect(p.logs[0]).toMatchObject({ ev: "play", host: "cdn.example.com", kind: "file" });
    expect(JSON.stringify(p.logs)).not.toContain("a.mp3");
  });

  it("a stream is live: no length, a live badge", async () => {
    const p = page();
    p.el.duration = Infinity;
    const pl = createLiPlayer(p.env);
    expect(await pl.play("m2", LIVE)).toMatchObject({ status: "playing", live: true });
    // A file whose length the browser cannot tell is live too.
    p.el.duration = NaN;
    expect((await pl.play("m3", FILE)).live).toBe(true);
  });

  it("refused by the browser (no tap yet): blocked, and a tap on its chip plays it", async () => {
    const p = page();
    p.el.auto = "reject";
    const pl = createLiPlayer(p.env);
    expect(await pl.play("m1", FILE)).toMatchObject({ status: "blocked", why: "locked" });
    expect(pl.unlocked()).toBe(false);
    p.el.auto = "resolve";
    expect(await pl.toggle("m1", FILE)).toMatchObject({ status: "playing" });
    expect(pl.unlocked()).toBe(true);
  });

  it("a load failure says so", async () => {
    const p = page();
    p.el.auto = "reject";
    p.el.rejectWith = new Error("NotSupportedError: no source");
    const pl = createLiPlayer(p.env);
    expect(await pl.play("m1", FILE)).toMatchObject({ status: "error", why: "load" });
    p.el.auto = "resolve";
    await pl.play("m2", FILE);
    p.el.fire("error");
    expect(pl.view()).toMatchObject({ status: "error", why: "load" });
  });

  it("HLS only where the browser plays it itself", async () => {
    const p = page();
    const pl = createLiPlayer(p.env);
    expect(await pl.play("m1", HLS)).toMatchObject({ status: "error", why: "hls" });
    p.el.hls = "maybe";
    expect(await pl.play("m2", HLS)).toMatchObject({ status: "playing", live: true });
  });

  it("a kind with no source is refused by name; a registered one slots in", async () => {
    const p = page();
    const pl = createLiPlayer(p.env);
    const gen: LineAudio = { src: "https://gen.example.com/x", kind: "gen" };
    expect(await pl.play("m1", gen)).toMatchObject({ status: "error", why: "unsupported" });
    const calls: string[] = [];
    const sink: PlaySink = {
      start: async () => void calls.push("start"),
      pause: () => void calls.push("pause"),
      resume: async () => void calls.push("resume"),
      stop: () => void calls.push("stop"),
      pos: () => 0,
      dur: () => Infinity,
      onChange: () => () => {},
    };
    pl.register("gen", () => sink);
    expect(await pl.play("m2", gen)).toMatchObject({ status: "playing", kind: "gen", live: true });
    pl.register("webaudio", () => ({ why: "unsupported" }));
    expect(await pl.play("m3", { src: "https://x.example.com/r", kind: "webaudio" })).toMatchObject(
      { status: "error", why: "unsupported" },
    );
    expect(calls).toEqual(["start", "stop"]);
  });

  it("file:<id> plays through a short-lived URL; a failure says so", async () => {
    const p = page();
    const pl = createLiPlayer(p.env);
    await pl.play("m1", { src: "file:0123456789abcdef0123", kind: "file" });
    expect(p.files).toEqual(["0123456789abcdef0123"]);
    expect(p.el.src).toContain("/api/my/files/0123456789abcdef0123/play?");
    const q = page({
      resolveFile: async () => {
        throw new Error("404");
      },
    });
    const pl2 = createLiPlayer(q.env);
    expect(await pl2.play("m1", { src: "file:0123456789abcdef0123", kind: "file" })).toMatchObject({
      status: "error",
      why: "file",
    });
  });

  it("a newer line stops the older one; stop and pause", async () => {
    const p = page();
    const pl = createLiPlayer(p.env);
    p.el.auto = "manual";
    const first = pl.play("m1", FILE);
    await tick();
    const second = pl.play("m2", LIVE);
    await tick();
    p.el.plays[0]!.resolve();
    p.el.plays[1]!.resolve();
    await first;
    expect((await second).id).toBe("m2");
    expect(pl.view().status).toBe("playing");
    p.el.auto = "resolve";
    expect(await pl.toggle("m2", LIVE)).toMatchObject({ status: "paused" });
    expect(p.el.paused).toBe(true);
    expect(await pl.toggle("m2", LIVE)).toMatchObject({ status: "playing" });
    pl.stop();
    expect(pl.view().status).toBe("idle");
    expect(p.logs.at(-1)).toMatchObject({ outcome: "stopped" });
    pl.pause(); // nothing playing: nothing happens
    expect(pl.view().status).toBe("idle");
  });

  it("a resume the browser refuses becomes a tap", async () => {
    const p = page();
    const pl = createLiPlayer(p.env);
    await pl.play("m1", FILE);
    pl.pause();
    p.el.auto = "reject";
    expect(await pl.toggle("m1", FILE)).toMatchObject({ status: "blocked" });
  });
});

describe("never over his open mic", () => {
  it("a play with the mic on is held with the reason", async () => {
    const p = page();
    p.mic.open = true;
    const pl = createLiPlayer(p.env);
    expect(await pl.play("m1", FILE)).toMatchObject({ status: "paused", why: "mic" });
    expect(p.el.src).toBe("");
    // A tap with the mic still on: still refused, with the reason.
    expect(await pl.toggle("m1", FILE)).toMatchObject({ status: "paused", why: "mic" });
    setMic(p, false);
    expect(await pl.toggle("m1", FILE)).toMatchObject({ status: "playing" });
  });

  it("the mic opening pauses the line; a tap with it off goes on", async () => {
    const p = page();
    const pl = createLiPlayer(p.env);
    await pl.play("m1", FILE);
    setMic(p, true);
    expect(pl.view()).toMatchObject({ status: "paused", why: "mic" });
    expect(p.el.paused).toBe(true);
    setMic(p, false);
    expect(await pl.toggle("m1", FILE)).toMatchObject({ status: "playing" });
    expect(pl.view().why).toBeUndefined();
  });

  it("a mic session the player did not hear: the next time update pauses it", async () => {
    const p = page({ onMic: undefined });
    const pl = createLiPlayer(p.env);
    await pl.play("m1", FILE);
    p.mic.open = true;
    p.el.fire("timeupdate");
    expect(pl.view()).toMatchObject({ status: "paused", why: "mic" });
  });

  it("the mic opening while the element is starting: it never plays on", async () => {
    const p = page();
    p.el.auto = "manual";
    const pl = createLiPlayer(p.env);
    const done = pl.play("m1", FILE);
    await tick();
    setMic(p, true);
    p.el.plays[0]!.resolve();
    await done;
    expect(pl.view()).toMatchObject({ status: "paused", why: "mic" });
    expect(p.el.paused).toBe(true);
  });
});

describe("the page's audio owner (audio-claim.ts)", () => {
  it("Li speaking pauses it; it goes on when Li is done", async () => {
    const p = page();
    const pl = createLiPlayer(p.env);
    await pl.play("m1", FILE);
    const li = audioOwner({ id: "li:1", prio: AUDIO_PRIO.li, target: p.win });
    expect(li.claim()).toBe(true);
    expect(pl.view().status).toBe("waiting");
    expect(p.el.paused).toBe(true);
    li.release();
    await tick();
    expect(pl.view().status).toBe("playing");
  });

  it("while Li speaks a new line waits, then starts", async () => {
    const p = page();
    const pl = createLiPlayer(p.env);
    const li = audioOwner({ id: "li:1", prio: AUDIO_PRIO.li, target: p.win });
    li.claim();
    expect(await pl.play("m1", FILE)).toMatchObject({ status: "waiting" });
    expect(p.el.src).toBe("");
    li.release();
    await tick();
    expect(pl.view().status).toBe("playing");
    expect(p.el.src).toBe(FILE.src);
  });

  it("a resume after waiting that the browser refuses becomes a tap", async () => {
    const p = page();
    const pl = createLiPlayer(p.env);
    await pl.play("m1", FILE);
    const li = audioOwner({ id: "li:1", prio: AUDIO_PRIO.li, target: p.win });
    li.claim();
    p.el.auto = "reject";
    li.release();
    await tick();
    expect(pl.view().status).toBe("blocked");
  });

  it("it pauses the reader's paragraph (a lower rank), and frees the page when paused", async () => {
    const p = page();
    const pl = createLiPlayer(p.env);
    const yields: string[] = [];
    const para = audioOwner({
      id: "para:1",
      prio: AUDIO_PRIO.para,
      target: p.win,
      onYield: () => yields.push("para"),
    });
    para.claim();
    await pl.play("m1", FILE);
    expect(yields).toEqual(["para"]);
    const released: string[] = [];
    p.win.addEventListener(AUDIO_RELEASE, (e) => released.push((e as CustomEvent).detail.id));
    pl.pause();
    expect(released.length).toBe(1);
    const claims: number[] = [];
    p.win.addEventListener(AUDIO_CLAIM, (e) => claims.push((e as CustomEvent).detail.prio));
    // A tap resumes while Li holds the page: it waits.
    const li = audioOwner({ id: "li:2", prio: AUDIO_PRIO.li, target: p.win });
    li.claim();
    expect(await pl.toggle("m1", FILE)).toMatchObject({ status: "waiting" });
    expect(claims).toContain(AUDIO_PRIO.play);
  });
});

describe("hold, unlock, the page's one player", () => {
  it("hold shows a line's reason without touching what plays", async () => {
    const p = page();
    const pl = createLiPlayer(p.env);
    pl.hold("m1", FILE, "locked");
    expect(pl.view()).toMatchObject({ id: "m1", status: "blocked", why: "locked" });
    pl.hold("m2", LIVE, "mic");
    expect(pl.view()).toMatchObject({ id: "m2", status: "paused", why: "mic", live: true });
    await pl.play("m3", FILE);
    pl.hold("m4", FILE, "locked");
    expect(pl.view().id).toBe("m3");
  });

  it("unlock primes the element in the tap once, and never stops a line", async () => {
    const p = page();
    const pl = createLiPlayer(p.env);
    p.el.auto = "manual";
    pl.unlock();
    expect(p.el.src).toBe(silentWav());
    expect(silentWav()).toStartWith("data:audio/wav;base64,UklGR");
    p.el.plays[0]!.resolve();
    await tick();
    expect(p.el.paused).toBe(true);
    expect(pl.unlocked()).toBe(true);
    pl.unlock(); // once only
    expect(p.el.plays.length).toBe(1);
  });

  it("the browser's own activation counts as unlocked", () => {
    const p = page({ activated: () => true });
    expect(createLiPlayer(p.env).unlocked()).toBe(true);
  });

  it("subscribe sends the view at once and stops on unsubscribe; retire ends it", async () => {
    const p = page();
    const pl = createLiPlayer(p.env);
    const seen: string[] = [];
    const off = pl.subscribe((v) => seen.push(v.status));
    off();
    await pl.play("m1", FILE);
    expect(seen).toEqual(["idle"]);
    pl.retire();
    pl.retire();
    expect(p.mic.subs.size).toBe(0);
    expect((await pl.play("m2", FILE)).id).toBe("m1");
  });

  it("one per page: a newer one kept, an older one retired", () => {
    const a = liPlayer(page().env)!;
    expect(a.v).toBe(LI_PLAY_V);
    expect(liPlayer(page().env)).toBe(a);
    let retired = false;
    g[LI_PLAY_KEY] = { v: 0, retire: () => (retired = true) } as unknown as LiPlayer;
    const b = liPlayer(page().env)!;
    expect(retired).toBe(true);
    expect(b.v).toBe(LI_PLAY_V);
  });

  it("outside a browser there is no player", () => {
    expect(browserPlayEnv()).toBeNull();
    expect(liPlayer()).toBeNull();
  });

  it("in a browser: one element, the play URL from the page's own session, the mic read", async () => {
    const saved = { Audio: g.Audio, fetch: g.fetch, location: g.location };
    const made: unknown[] = [];
    g.Audio = class {
      constructor() {
        made.push(this);
      }
    };
    g.location = { href: "https://lianki.com/words" };
    const asked: [string, RequestInit | undefined][] = [];
    let answer: Response = Response.json({ url: "/api/my/files/abc/play?exp=1&sig=s" });
    g.fetch = async (u: string, init?: RequestInit) => (asked.push([u, init]), answer);
    try {
      const logs: unknown[] = [];
      const env = browserPlayEnv((e) => logs.push(e))!;
      expect(env.el()).toBe(env.el());
      expect(made.length).toBe(1);
      expect(await env.resolveFile("0123456789abcdef0123")).toBe(
        "https://lianki.com/api/my/files/abc/play?exp=1&sig=s",
      );
      expect(asked[0]).toEqual([
        "/api/my/files/0123456789abcdef0123/play",
        { method: "POST", credentials: "same-origin" },
      ]);
      answer = new Response("nope", { status: 404 });
      expect(env.resolveFile("0123456789abcdef0123")).rejects.toThrow("play url 404");
      // The mic: the chat mic's session, or /vibe's room.
      expect(env.micOpen()).toBe(false);
      const subs: (() => void)[] = [];
      g.__lkMic = {
        view: () => ({ state: "listening" }),
        subscribe: (f: () => void) => (subs.push(f), () => {}),
      };
      expect(env.micOpen()).toBe(true);
      env.onMic!(() => {});
      expect(subs.length).toBe(1);
      g.__lkMic = { view: () => ({ state: "off" }) };
      g.__lkMicTaps = { blocked: () => true };
      expect(env.micOpen()).toBe(true);
      delete g.__lkMic;
      delete g.__lkMicTaps;
      expect(env.onMic!(() => {})).toBeFunction();
      expect(env.activated!()).toBe(false);
      expect(env.target).toBeNull();
      env.log!({ x: 1 });
      expect(logs).toEqual([{ x: 1 }]);
    } finally {
      g.Audio = saved.Audio;
      g.fetch = saved.fetch;
      g.location = saved.location;
    }
  });

  it("the element source stops cleanly before it started", () => {
    const el = new El();
    const s = elementSource(FILE, FILE.src, { el: () => el });
    if ("why" in s) throw new Error("no sink");
    s.stop();
    expect(el.removed).toBe(1);
    expect(s.pos()).toBe(0);
  });
});

describe("autoPlayLine: a live agent line with audio", () => {
  const line = { id: "m1", audio: FILE };

  it("plays by itself on a visible, unlocked phone page with the mic off", async () => {
    const p = page({ activated: () => true });
    const pl = createLiPlayer(p.env);
    const logs: Record<string, unknown>[] = [];
    const d = autoPlayLine(line, true, (e) => logs.push(e), {
      player: pl,
      desktop: false,
      visible: true,
    });
    expect(d).toEqual({ play: true });
    await tick();
    expect(pl.view()).toMatchObject({ id: "m1", status: "playing" });
    expect(logs[0]).toMatchObject({ ev: "play-auto", id: "m1", play: true });
    // The player's own log goes to the same place now.
    expect(logs.some((l) => l.ev === "play" && l.outcome === "playing")).toBe(true);
  });

  it("otherwise its chip waits for a tap, with the reason", () => {
    const at = (o: {
      desktop?: boolean;
      visible?: boolean;
      unlocked?: boolean;
      mic?: boolean;
      tab?: boolean;
      quiet?: boolean;
    }) => {
      const p = page({ activated: () => o.unlocked ?? true });
      p.mic.open = o.mic ?? false;
      const pl = createLiPlayer(p.env);
      const d = autoPlayLine({ ...line, quiet: o.quiet }, o.tab ?? true, undefined, {
        player: pl,
        desktop: o.desktop ?? false,
        visible: o.visible ?? true,
      });
      return { d, v: pl.view() };
    };
    expect(at({ desktop: true }).d).toEqual({ play: false, why: "desktop" });
    expect(at({ desktop: true }).v).toMatchObject({ status: "blocked", why: "locked" });
    expect(at({ visible: false }).d).toEqual({ play: false, why: "hidden" });
    expect(at({ unlocked: false }).d).toEqual({ play: false, why: "locked" });
    expect(at({ tab: false }).d).toEqual({ play: false, why: "tab" });
    expect(at({ quiet: true }).d).toEqual({ play: false, why: "quiet" });
    const mic = at({ mic: true });
    expect(mic.d).toEqual({ play: false, why: "mic" });
    expect(mic.v).toMatchObject({ status: "paused", why: "mic" });
  });

  it("no valid audio, or no player: nothing", () => {
    const pl = createLiPlayer(page().env);
    expect(
      autoPlayLine(
        { id: "x", audio: { src: "http://a.example.com/a.mp3", kind: "file" } },
        true,
        undefined,
        { player: pl },
      ),
    ).toBeNull();
    expect(autoPlayLine(line, true, undefined, { player: null })).toBeNull();
  });

  it("reads the page itself when not told", () => {
    const pl = createLiPlayer(page({ activated: () => true }).env);
    // No matchMedia and no document here: not a desktop, and not visible.
    expect(
      autoPlayLine(
        line,
        true,
        () => {
          throw new Error("a log that throws changes nothing");
        },
        { player: pl },
      ),
    ).toEqual({ play: false, why: "hidden" });
  });
});
