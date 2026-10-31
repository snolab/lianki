/**
 * The page side of scripts/qa/clip-pool-gc.ts: the real clip pool
 * (lib/words/clip-pool.ts) on a real AudioContext, with every element and
 * node it makes tracked by a WeakRef, so the runner can ask what is still
 * alive after a GC. Bundled by the runner; never part of the app.
 *
 * Silent: the clips are generated silent WAVs, and the pool's destination is
 * a gain node at 0 in front of the speakers.
 */
import { createClipPool, type CtxLike } from "../../lib/words/clip-pool";

/** A valid silent 16-bit mono WAV of `seconds`. */
function silentWav(seconds: number, rate = 8000): Blob {
  const n = Math.round(seconds * rate);
  const b = new DataView(new ArrayBuffer(44 + n * 2));
  const str = (o: number, s: string) =>
    [...s].forEach((c, i) => b.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  b.setUint32(4, 36 + n * 2, true);
  str(8, "WAVEfmt ");
  b.setUint32(16, 16, true);
  b.setUint16(20, 1, true);
  b.setUint16(22, 1, true);
  b.setUint32(24, rate, true);
  b.setUint32(28, rate * 2, true);
  b.setUint16(32, 2, true);
  b.setUint16(34, 16, true);
  str(36, "data");
  b.setUint32(40, n * 2, true);
  return new Blob([b.buffer], { type: "audio/wav" });
}

type Mode = "plain" | "wired-dispose" | "wired-drop" | "wired-close";

const refs = { elements: [] as WeakRef<object>[], nodes: [] as WeakRef<object>[] };
let ac: AudioContext | null = null;
let url = "";
const played = { ok: 0, failed: 0 };

/** Wait until the clip ends, errors, or `ms` passes. */
const settle = (el: HTMLAudioElement, ms: number) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    el.addEventListener(
      "ended",
      () => {
        played.ok++;
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
    el.addEventListener(
      "error",
      () => {
        played.failed++;
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });

const api = {
  /** Called from a trusted click, so the AudioContext may start. */
  async start() {
    ac = new AudioContext();
    await ac.resume();
    url = URL.createObjectURL(silentWav(0.15));
    return ac.state;
  },
  /**
   * `rounds` pools, each playing `clips` clips (two at a time, so it grows to
   * its max), then disposed ("plain", "wired-dispose") or just dropped
   * ("wired-drop", what a swap without dispose would do).
   */
  async run(mode: Mode, rounds: number, clips: number) {
    const real = ac!;
    const mute = real.createGain();
    mute.gain.value = 0;
    mute.connect(real.destination);
    const ctx: CtxLike = {
      get currentTime() {
        return real.currentTime;
      },
      destination: mute,
      createGain: () => {
        const g = real.createGain();
        refs.nodes.push(new WeakRef(g));
        return g;
      },
      createMediaElementSource: (el) => {
        const s = real.createMediaElementSource(el as HTMLMediaElement);
        refs.nodes.push(new WeakRef(s));
        return s;
      },
    };
    for (let r = 0; r < rounds; r++) {
      let pool: ReturnType<typeof createClipPool<HTMLAudioElement>> | null = createClipPool({
        element: () => {
          const e = new Audio();
          // Not wired to the 0-gain node, so muted as well (and silent anyway).
          if (mode === "plain") e.muted = true;
          refs.elements.push(new WeakRef(e));
          return e;
        },
        ctx: () => (mode === "plain" ? null : ctx),
        max: 4,
      });
      for (let i = 0; i < clips; i += 2) {
        // Each play() before the next take(), so the pool sees it busy and
        // grows: two clips at a time, four elements by the second pair.
        const a = pool.take(url);
        const da = settle(a.el, 1500);
        void a.el.play().catch(() => {});
        const b = pool.take(url);
        const db = settle(b.el, 1500);
        void b.el.play().catch(() => {});
        await Promise.all([da, db]);
      }
      if (mode !== "wired-drop") pool.dispose();
      pool = null;
    }
    // "wired-close": disposed, then the AudioContext itself closed, to tell
    // whether it is the running context that holds the elements.
    if (mode === "wired-close") await real.close();
    return {
      elements: refs.elements.length,
      nodes: refs.nodes.length,
      played: { ...played },
      audioTime: Math.round(real.currentTime * 1000),
    };
  },
  /** How many tracked elements and nodes are still alive (call after a GC). */
  alive() {
    return {
      elements: refs.elements.filter((w) => w.deref()).length,
      nodes: refs.nodes.filter((w) => w.deref()).length,
    };
  },
  /** Allocation pressure, for a browser where a GC cannot be forced (WebKit). */
  pressure(mb: number) {
    let keep: unknown[] = [];
    for (let i = 0; i < mb; i++) keep.push(Array.from({ length: 128 * 1024 }, () => i));
    keep = [];
    return keep.length;
  },
};

(globalThis as unknown as { __gc: typeof api }).__gc = api;
