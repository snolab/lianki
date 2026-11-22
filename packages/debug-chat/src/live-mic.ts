/** Read-only, explicit subscribers on the already-running Li mic. Never opens a device. */
export type LiveMicTap = (frame: Float32Array | null) => void;
export function createLiveMic() {
  const taps = new Set<LiveMicTap>();
  return {
    subscribe(tap: LiveMicTap) {
      taps.add(tap);
      return () => {
        taps.delete(tap);
      };
    },
    publish(frame: Float32Array | null) {
      for (const tap of taps) {
        try {
          tap(frame?.slice() ?? null);
        } catch {
          /* A route cannot break capture. */
        }
      }
    },
  };
}
export function liveMic(): ReturnType<typeof createLiveMic> {
  const g = globalThis as typeof globalThis & { __lkLiveMic?: ReturnType<typeof createLiveMic> };
  return (g.__lkLiveMic ??= createLiveMic());
}
/** 16k mono capture chunks -> bounded fresh 20ms frames, never replay old room audio. */
export function liveMicFrames(now = () => performance.now()) {
  let partial = new Float32Array(320),
    used = 0;
  let partialAt = 0;
  let queue: { at: number; samples: Float32Array }[] = [];
  const clear = () => {
    used = 0;
    partialAt = 0;
    queue = [];
    partial = new Float32Array(320);
  };
  return {
    clear,
    push(chunk: Float32Array | null) {
      if (!chunk) return clear();
      if (used && now() - partialAt > 160) {
        used = 0;
        partial = new Float32Array(320);
      }
      for (let i = 0; i < chunk.length; i++) {
        if (!used) partialAt = now();
        partial[used++] = Number.isFinite(chunk[i]) ? Math.max(-1, Math.min(1, chunk[i])) : 0;
        if (used === 320) {
          queue.push({ at: partialAt, samples: partial });
          if (queue.length > 8) queue.shift();
          partial = new Float32Array(320);
          used = 0;
        }
      }
    },
    take(): Float32Array {
      while (queue.length && now() - queue[0].at > 160) queue.shift();
      return queue.shift()?.samples ?? new Float32Array(320);
    },
  };
}
