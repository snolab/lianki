/**
 * The mic's recordings on their way to the account (packages/debug-chat/src/
 * recorder.ts; docs/recordings.md): queued, sent one at a time in the
 * background, retried with a backoff, dropped after N failures, bounded, and
 * nothing at all when the account has recordings off. And the mic's side
 * (mic.ts `record`): every finished utterance while on — active or passive,
 * for the chat or not — but never an echo, a blip or an enrolment sentence.
 */
import { describe, expect, it } from "bun:test";
import {
  RECORDER_LIMITS,
  RECORDINGS_URL,
  base64,
  createRecorder,
  localDay,
  pageRecorder,
  randomClipId,
} from "@lianki/debug-chat/recorder";
import {
  type MicRecord,
  type StreamStt,
  type VadEvents,
  RATE,
  RECORD_BARE_MIN_MS,
  createMic,
  encodeWav,
} from "@lianki/debug-chat/mic";
import type { LocalFinal } from "@lianki/debug-chat/local-stt";

const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => {
  for (let i = 0; i < 10; i++) await tick();
};

const clip = (o: Partial<MicRecord> = {}) => ({
  wav: encodeWav(new Float32Array(1600)),
  durationMs: 100,
  at: Date.parse("2026-11-14T03:00:00Z"),
  text: "hi",
  source: "local" as const,
  mode: "active" as const,
  device: "iphone",
  ...o,
});

/** A route driven by the test: status answers, then POST answers in order. */
function route(status: number | "throw" = 200, posts: (number | "throw")[] = []) {
  const calls: { url: string; method: string; body?: Record<string, unknown> }[] = [];
  let statusNow = status;
  const f = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (method === "GET") {
      if (statusNow === "throw") throw new Error("offline");
      return new Response(JSON.stringify({ on: true }), { status: statusNow });
    }
    const p = posts.shift() ?? 200;
    if (p === "throw") throw new Error("offline");
    return new Response("{}", { status: p });
  }) as unknown as typeof fetch;
  return { f, calls, setStatus: (s: number | "throw") => void (statusNow = s) };
}

function harness(r: ReturnType<typeof route>, now = { t: 1_000 }) {
  const timers: { f: () => void; ms: number }[] = [];
  const logs: Record<string, unknown>[] = [];
  let n = 0;
  const rec = createRecorder({
    fetch: r.f,
    now: () => now.t,
    setTimer: (f, ms) => void timers.push({ f, ms }),
    id: () => `clip${String(++n).padStart(12, "0")}`,
    day: () => "2026-11-14",
    log: (ev) => void logs.push(ev),
  });
  const fire = async () => {
    const t = timers.shift();
    t?.f();
    await settle();
    return t?.ms;
  };
  return { rec, timers, logs, fire, now };
}

describe("the recorder", () => {
  for (const status of [200, 500])
    it(`preserves the in-flight clip during overflow (${status})`, async () => {
      let finish!: (r: Response) => void;
      const ids: string[] = [];
      let n = 0;
      const timers: (() => void)[] = [];
      const rec = createRecorder({
        id: () => String(++n),
        setTimer: (f) => timers.push(f),
        fetch: (async (_url, init) => {
          if (init?.method !== "POST") return Response.json({ on: true });
          ids.push(JSON.parse(String(init.body)).id);
          if (ids.length === 1)
            return new Promise<Response>((resolve) => {
              finish = resolve;
            });
          return Response.json({});
        }) as typeof fetch,
      });
      rec.add(clip());
      await settle();
      for (let i = 0; i < 40; i++) rec.add(clip());
      finish(new Response("{}", { status }));
      await settle();
      if (status === 500) {
        timers.shift()!();
        await settle();
      }
      expect(ids).toEqual(
        status === 200
          ? ["1", ...Array.from({ length: 39 }, (_, i) => String(i + 3))]
          : ["1", "1", ...Array.from({ length: 39 }, (_, i) => String(i + 3))],
      );
      expect(rec.stats()).toMatchObject({ queued: 0, bytes: 0, sent: 40, dropped: 1 });
    });

  it("asks once whether it is on, then posts each clip in order", async () => {
    const r = route();
    const h = harness(r);
    h.rec.add(clip());
    h.rec.add(clip({ text: "second", speaker: "other" }));
    await settle();
    expect(r.calls.map((c) => c.method)).toEqual(["GET", "POST", "POST"]);
    expect(r.calls[0]!.url).toBe(`${RECORDINGS_URL}?status=1`);
    expect(r.calls[1]!.body).toMatchObject({
      id: "clip000000000001",
      day: "2026-11-14",
      text: "hi",
      source: "local",
      mode: "active",
      device: "iphone",
    });
    expect(r.calls[1]!.body!.speaker).toBeUndefined();
    expect(r.calls[2]!.body).toMatchObject({ text: "second", speaker: "other" });
    expect(typeof r.calls[1]!.body!.wav).toBe("string");
    expect(h.rec.stats()).toMatchObject({ queued: 0, sent: 2, on: true });
    expect(h.rec.enabled()).toBe(true);
  });

  it("off for this account (404): nothing is sent, and new clips are not even queued", async () => {
    const r = route(404);
    const h = harness(r);
    h.rec.add(clip());
    await settle();
    expect(r.calls.map((c) => c.method)).toEqual(["GET"]);
    expect(h.rec.stats()).toMatchObject({ queued: 0, dropped: 1, on: false });
    h.rec.add(clip());
    await settle();
    expect(r.calls).toHaveLength(1);
    expect(h.rec.enabled()).toBe(false);
    // An hour on, it asks again.
    h.now.t += RECORDER_LIMITS.offTtlMs;
    r.setStatus(200);
    expect(h.rec.enabled()).toBe(false); // stale: asks, answers next time
    await settle();
    expect(h.rec.enabled()).toBe(true);
  });

  it("retries with a backoff, then drops after maxTries", async () => {
    const r = route(200, [500, "throw", 503, 502, 500]);
    const h = harness(r);
    h.rec.add(clip());
    await settle();
    const waits: (number | undefined)[] = [];
    for (let i = 0; i < 4; i++) waits.push(await h.fire());
    expect(waits).toEqual(RECORDER_LIMITS.backoffMs.slice(0, 4) as number[]);
    expect(h.rec.stats()).toMatchObject({ queued: 0, dropped: 1, sent: 0 });
    expect(h.logs.some((l) => l.ev === "record-dropped")).toBe(true);
  });

  it("a refused clip (400, 413) is dropped at once; 429 waits", async () => {
    const r = route(200, [400, 429, 200]);
    const h = harness(r);
    h.rec.add(clip());
    h.rec.add(clip());
    await settle();
    expect(h.rec.stats()).toMatchObject({ queued: 1, dropped: 1 });
    await h.fire();
    expect(h.rec.stats()).toMatchObject({ queued: 0, sent: 1 });
  });

  it("turned off or signed out meanwhile (404/401 on POST): the queue empties", async () => {
    const r = route(200, [401]);
    const h = harness(r);
    h.rec.add(clip());
    h.rec.add(clip());
    await settle();
    expect(h.rec.stats()).toMatchObject({ queued: 0, dropped: 2, on: false });
  });

  it("cannot tell (status fails): keeps the clip and tries again later", async () => {
    const r = route("throw");
    const h = harness(r);
    h.rec.add(clip());
    await settle();
    expect(h.rec.stats().queued).toBe(1);
    r.setStatus(500);
    await h.fire();
    expect(h.rec.stats().queued).toBe(1);
    r.setStatus(200);
    await h.fire();
    expect(h.rec.stats()).toMatchObject({ queued: 0, sent: 1 });
    // A kick while idle sends nothing new.
    h.rec.kick();
    await settle();
  });

  it("is bounded: past maxItems or maxBytes the oldest goes", async () => {
    const r = route("throw");
    const h = harness(r);
    for (let i = 0; i < RECORDER_LIMITS.maxItems + 3; i++) h.rec.add(clip());
    expect(h.rec.stats().queued).toBe(RECORDER_LIMITS.maxItems);
    const h2 = harness(route("throw"));
    const big = new Uint8Array(RECORDER_LIMITS.maxBytes / 2 + 10);
    h2.rec.add(clip({ wav: big }));
    h2.rec.add(clip({ wav: big }));
    expect(h2.rec.stats()).toMatchObject({ queued: 1, dropped: 1 });
  });

  it("runs on its defaults (clock, ids, day, timer, log)", async () => {
    const r = route(200, [500]);
    const rec = createRecorder({ fetch: r.f });
    rec.add(clip());
    await settle();
    expect(r.calls[1]!.body!.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(rec.stats().queued).toBe(1); // waiting on a real timer for its retry
    const off = createRecorder({ fetch: route(404).f });
    off.add(clip());
    await settle();
    expect(off.stats().on).toBe(false);
  });

  it("helpers: local day, ids, base64, one recorder per page", () => {
    expect(localDay(new Date(2026, 10, 4, 23, 30).getTime())).toBe("2026-11-04");
    expect(randomClipId()).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(base64(new Uint8Array([104, 105]))).toBe("aGk=");
    const a = pageRecorder(() => createRecorder({ fetch: route().f }));
    expect(pageRecorder(() => createRecorder({ fetch: route().f }))).toBe(a);
    delete (globalThis as Record<string, unknown>).__lkRecorder;
  });
});

// ---------------------------------------------------------------- the mic's side
type Final = Partial<LocalFinal> & { text: string };

function mic(o: {
  answer?: string | Error;
  passive?: boolean;
  spot?: () => Promise<{ hit: boolean; rest?: Float32Array; unchecked?: boolean }>;
  stream?: StreamStt;
  local?: boolean;
  echo?: boolean;
  enrol?: boolean;
}) {
  let ev: VadEvents | null = null;
  const kept: MicRecord[] = [];
  const texts: string[] = [];
  let passive = o.passive ?? false;
  const m = createMic({
    guard: { minFrameRms: 0 },
    load: async (e) => {
      ev = e;
      return { start() {}, pause() {}, flush() {}, destroy() {} };
    },
    upload: async (_wav, info) => {
      if (o.echo) info.onEcho?.();
      if (info.local) await info.local.catch(() => {});
      if (o.answer instanceof Error) throw o.answer;
      return o.answer ?? "hello there";
    },
    stream: o.stream ? () => o.stream : undefined,
    onState: () => {},
    onText: (t) => texts.push(t),
    onPending: () => {},
    enrol: o.enrol ? { active: () => true, begin: () => null, done: () => {} } : undefined,
    wake: o.spot
      ? {
          passive: () => passive,
          spot: o.spot as never,
          onWake: () => void (passive = false),
          verdict: () => {},
        }
      : undefined,
    record: { keep: (r) => void kept.push(r), local: () => o.local ?? true },
  });
  const say = (sec: number) => {
    ev!.onSpeechStart();
    ev!.onSpeechEnd(new Float32Array(Math.round(sec * RATE)).fill(0.05));
  };
  return { m, say, kept, texts };
}

/** A local STT whose finals the test gives. */
function stt(finals: (Final | Error)[], connected = true): StreamStt {
  return {
    connected: () => connected,
    begin: () => ({
      frame: () => {},
      cancel: () => {},
      end: () => {
        const f = finals.shift() ?? { text: "" };
        return f instanceof Error
          ? Promise.reject(f)
          : Promise.resolve({ model: "m", ms: 1, endToFinalMs: 1, ...f } as LocalFinal);
      },
    }),
  };
}

describe("mic.ts record: what is kept", () => {
  it("active: the chat's line, with its source", async () => {
    const h = mic({});
    await h.m.toggle();
    h.say(1);
    await settle();
    expect(h.texts).toEqual(["hello there"]);
    expect(h.kept).toEqual([
      expect.objectContaining({
        text: "hello there",
        source: "cloud",
        mode: "active",
        durationMs: 1000,
      }),
    ]);
    expect(h.kept[0]!.wav.length).toBe(44 + RATE * 2);
  });

  it("active with the Mac: source local, speaker tag carried", async () => {
    const h = mic({ stream: stt([{ text: "hello there", speaker: { decision: "other" } }]) });
    await h.m.toggle();
    h.say(1);
    await settle();
    expect(h.kept[0]).toMatchObject({ source: "local", speaker: "other" });
  });

  it("the Mac's filter stopped it (someone else): kept without text", async () => {
    const h = mic({
      stream: stt([{ text: "", filtered: { reason: "other" } as never }]),
      answer: "",
    });
    await h.m.toggle();
    h.say(1);
    await settle();
    expect(h.kept).toEqual([expect.objectContaining({ text: "", source: "none" })]);
    // Too short to be speech: not kept.
    const g = mic({
      stream: stt([{ text: "", filtered: { reason: "other" } as never }]),
      answer: "",
    });
    await g.m.toggle();
    g.say((RECORD_BARE_MIN_MS - 100) / 1000);
    await settle();
    expect(g.kept).toEqual([]);
  });

  it("never the agent's echo, an empty line or a hallucination", async () => {
    for (const o of [
      { echo: true, answer: "" },
      { answer: "" },
      { answer: "ご視聴ありがとうございました" },
    ]) {
      const h = mic(o);
      await h.m.toggle();
      h.say(1);
      await settle();
      expect(h.kept).toEqual([]);
    }
  });

  it("STT failed: the Mac's text if it came, else the bare audio", async () => {
    const a = mic({ answer: new Error("502"), stream: stt([{ text: "from the mac" }]) });
    await a.m.toggle();
    a.say(1);
    await settle();
    expect(a.kept).toEqual([expect.objectContaining({ text: "from the mac", source: "local" })]);
    const b = mic({ answer: new Error("502") });
    await b.m.toggle();
    b.say(1);
    await settle();
    expect(b.kept).toEqual([expect.objectContaining({ text: "", source: "none" })]);
  });

  it("an enrolment sentence is never kept", async () => {
    const h = mic({ enrol: true });
    await h.m.toggle();
    h.say(1);
    await settle();
    expect(h.kept).toEqual([]);
  });

  it("passive, no Linky: kept with the Mac's text, never sent to the chat", async () => {
    const h = mic({
      passive: true,
      spot: async () => ({ hit: false }),
      stream: stt([{ text: "just talking", speaker: { decision: "me" } }]),
    });
    await h.m.toggle();
    h.say(2);
    await settle();
    expect(h.texts).toEqual([]);
    expect(h.kept).toEqual([
      expect.objectContaining({
        text: "just talking",
        source: "local",
        mode: "passive",
        speaker: "me",
      }),
    ]);
  });

  it("passive: no Mac, or not allowed to ask it, or it failed → bare audio; blips are not kept", async () => {
    const cases: [StreamStt | undefined, boolean, number][] = [
      [undefined, true, 1],
      [stt([], false), true, 1],
      [stt([{ text: "x" }]), false, 1],
      [stt([new Error("down")]), true, 1],
      [stt([{ text: "" }]), true, 0], // decoded nothing: a blip
      [stt([{ text: "ご視聴ありがとうございました" }]), true, 0], // a hallucination
      [stt([{ text: "", filtered: { reason: "other" } as never }]), true, 1], // someone else
    ];
    for (const [stream, local, n] of cases) {
      const h = mic({ passive: true, spot: async () => ({ hit: false }), stream, local });
      await h.m.toggle();
      h.say(2);
      await settle();
      expect(h.kept).toHaveLength(n);
      if (n) expect(h.kept[0]).toMatchObject({ mode: "passive" });
    }
  });

  it("passive: a spotter that throws still keeps it", async () => {
    const h = mic({
      passive: true,
      spot: async () => {
        throw new Error("kws");
      },
    });
    await h.m.toggle();
    h.say(2);
    await settle();
    expect(h.kept).toEqual([expect.objectContaining({ mode: "passive", text: "" })]);
  });

  it("passive: someone else's Linky is kept as theirs", async () => {
    const h = mic({
      passive: true,
      spot: async () => ({ hit: true, rest: new Float32Array(RATE), tokens: [] }) as never,
      stream: stt([{ text: "what time is it", speaker: { decision: "other" } }]),
    });
    await h.m.toggle();
    h.say(2);
    await settle();
    expect(h.texts).toEqual([]);
    expect(h.kept).toEqual([
      expect.objectContaining({ text: "what time is it", speaker: "other", mode: "passive" }),
    ]);
  });

  it("a sink that throws never breaks the mic", async () => {
    const logs: Record<string, unknown>[] = [];
    let ev: VadEvents | null = null;
    const texts: string[] = [];
    const m = createMic({
      guard: { minFrameRms: 0 },
      load: async (e) => {
        ev = e;
        return { start() {}, pause() {}, flush() {}, destroy() {} };
      },
      upload: async () => "fine",
      onState: () => {},
      onText: (t) => texts.push(t),
      onPending: () => {},
      log: (e) => void logs.push(e),
      record: {
        keep: () => {
          throw new Error("full");
        },
      },
    });
    await m.toggle();
    ev!.onSpeechStart();
    ev!.onSpeechEnd(new Float32Array(RATE).fill(0.05));
    await settle();
    expect(texts).toEqual(["fine"]);
    expect(logs.some((l) => l.ev === "record-keep-failed")).toBe(true);
  });
});
