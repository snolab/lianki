import { describe, expect, it } from "bun:test";
import { STT_MAX_BYTES } from "@/lib/stt";
import { HOLD_MS } from "@lianki/debug-chat/log-engage";
import {
  PTT_CANCEL_PX,
  PTT_HOLD_MS,
  PTT_MAX_WAV_BYTES,
  PTT_PREROLL_MS,
  PTT_TAIL_MS,
  chunkSamples,
  createPttGesture,
  createRing,
  joinClip,
  joinTexts,
  onPttHolding,
  pcmTap,
  pttHolding,
  setPttHolding,
} from "@lianki/debug-chat/ptt";

function harness() {
  let t = 1000;
  const timers: { f: () => void; ms: number; live: boolean }[] = [];
  const log: string[] = [];
  const g = createPttGesture(
    {
      press: (at) => void log.push(`press@${at}`),
      hold: (at) => void log.push(`hold@${at}`),
      release: (at) => void log.push(`release@${at}`),
      drop: (why) => void log.push(`drop:${why}`),
    },
    {
      now: () => t,
      setTimer: (f, ms) => {
        const x = { f, ms, live: true };
        timers.push(x);
        return x;
      },
      clearTimer: (x) => void ((x as { live: boolean }).live = false),
    },
  );
  const fire = () => {
    for (const x of timers.filter((y) => y.live)) {
      x.live = false;
      x.f();
    }
  };
  return { g, log, fire, tick: (ms: number) => void (t += ms), timers };
}

describe("push to talk: the gesture (owner, 2026-11-10)", () => {
  it("defaults are named, the hold the platform's long-press, pre-roll and tail 1–3 s", () => {
    expect(PTT_HOLD_MS).toBe(HOLD_MS);
    expect(PTT_PREROLL_MS).toBeGreaterThanOrEqual(1000);
    expect(PTT_PREROLL_MS).toBeLessThanOrEqual(3000);
    expect(PTT_TAIL_MS).toBeGreaterThanOrEqual(1000);
    expect(PTT_TAIL_MS).toBeLessThanOrEqual(3000);
    expect(PTT_MAX_WAV_BYTES).toBe(STT_MAX_BYTES);
  });

  it("records from the pointerdown; a short tap drops the clip (the click toggles as ever)", () => {
    const h = harness();
    h.g.down(10, 10);
    expect(h.log).toEqual(["press@1000"]);
    h.g.up();
    expect(h.log).toEqual(["press@1000", "drop:tap"]);
    expect(h.g.wasHold()).toBe(false);
    expect(h.timers[0]!.live).toBe(false);
  });

  it("a long press is one line: hold at the threshold, release sends; the start is the press", () => {
    const h = harness();
    h.g.down(10, 10);
    expect(h.timers[0]!.ms).toBe(PTT_HOLD_MS);
    h.tick(PTT_HOLD_MS);
    h.fire();
    expect(h.g.state()).toBe("held");
    expect(h.g.wasHold()).toBe(true);
    h.tick(4000);
    h.g.up();
    expect(h.log).toEqual([
      "press@1000",
      `hold@${1000 + PTT_HOLD_MS}`,
      `release@${5000 + PTT_HOLD_MS}`,
    ]);
  });

  it("held, a slide away arms a cancel; back again disarms it", () => {
    const h = harness();
    h.g.down(100, 100);
    h.fire();
    h.g.move(100, 100 - PTT_CANCEL_PX - 1);
    expect(h.g.state()).toBe("away");
    h.g.move(100, 110);
    expect(h.g.state()).toBe("held");
    h.g.move(100 + PTT_CANCEL_PX + 5, 100);
    h.g.up();
    expect(h.log.at(-1)).toBe("drop:cancel");
  });

  it("a sideways drag before the hold moves the box: no clip, the hold never fires", () => {
    const h = harness();
    h.g.down(0, 0);
    h.g.drag();
    h.fire();
    expect(h.log).toEqual(["press@1000", "drop:drag"]);
    expect(h.g.state()).toBe("idle");
  });

  it("pointercancel drops whatever was under way; a second down while pressed is ignored", () => {
    const h = harness();
    h.g.down(0, 0);
    h.g.down(5, 5);
    h.fire();
    h.g.cancel();
    expect(h.log).toEqual(["press@1000", "hold@1000", "drop:cancel"]);
    h.g.cancel();
    expect(h.log.length).toBe(3);
  });
});

describe("the pre-roll ring (memory only)", () => {
  it("keeps the last `capacity` samples, oldest first", () => {
    const r = createRing(5);
    r.push(new Float32Array([1, 2, 3]));
    expect([...r.take()]).toEqual([1, 2, 3]);
    r.push(new Float32Array([4, 5, 6, 7]));
    expect([...r.take()]).toEqual([3, 4, 5, 6, 7]);
    expect(r.size()).toBe(5);
    r.push(new Float32Array([8, 9, 10, 11, 12, 13, 14]));
    expect([...r.take()]).toEqual([10, 11, 12, 13, 14]);
    r.clear();
    expect(r.take().length).toBe(0);
    expect(createRing(0).take().length).toBe(0);
    const z = createRing(0);
    z.push(new Float32Array([1]));
    expect(z.capacity()).toBe(0);
  });
});

describe("the clip", () => {
  it("the pre-roll goes in front of the hold", () => {
    expect([...joinClip(new Float32Array([1, 2]), new Float32Array([3]))]).toEqual([1, 2, 3]);
  });
  it("one piece when it fits the route; else pieces each under its limit", () => {
    const small = new Float32Array(100);
    expect(chunkSamples(small)).toEqual([small]);
    const pieces = chunkSamples(new Float32Array(25), 44 + 20);
    expect(pieces.map((p) => p.length)).toEqual([10, 10, 5]);
    for (const p of chunkSamples(new Float32Array(3_000_000)))
      expect(44 + p.length * 2).toBeLessThanOrEqual(PTT_MAX_WAV_BYTES);
  });
  it("the pieces' texts are one line", () => {
    expect(joinTexts(["hello ", "", " world"])).toBe("hello world");
  });
});

describe("while recording, the always-on capture holds", () => {
  it("tells its listeners once per change", () => {
    let n = 0;
    const off = onPttHolding(() => n++);
    setPttHolding(true);
    setPttHolding(true);
    expect(pttHolding()).toBe(true);
    setPttHolding(false);
    expect(n).toBe(2);
    off();
    setPttHolding(true);
    expect(n).toBe(2);
    setPttHolding(false);
  });
});

describe("pcmTap: raw samples, through a silent gain (nothing is ever played)", () => {
  it("passes chunks on, mutes its output, and disconnects on stop", () => {
    const calls: string[] = [];
    const node = (name: string) => ({
      connect: (x: { name?: string }) => void calls.push(`${name}->${x.name ?? "dest"}`),
      disconnect: () => void calls.push(`${name} off`),
      name,
    });
    const proc = { ...node("proc"), onaudioprocess: null as null | ((e: unknown) => void) };
    const gain = { ...node("gain"), gain: { value: 1 } };
    const ctx = {
      destination: {},
      createMediaStreamSource: () => node("src"),
      createScriptProcessor: () => proc,
      createGain: () => gain,
    } as unknown as AudioContext;
    const got: number[][] = [];
    const stop = pcmTap(ctx, {} as MediaStream, (c) => got.push([...c]));
    expect(gain.gain.value).toBe(0);
    proc.onaudioprocess!({ inputBuffer: { getChannelData: () => new Float32Array([0.5, -0.5]) } });
    expect(got).toEqual([[0.5, -0.5]]);
    stop();
    expect(proc.onaudioprocess).toBeNull();
    expect(calls).toContain("src off");
    expect(calls).toContain("src->proc");
  });
});
