/**
 * The live PCM hook's arithmetic (docs/meetings.md, "Live PCM hook"): input
 * frames at the AudioContext's rate become 16 kHz mono, each output frame
 * carrying the absolute index of its first sample from the meeting's start.
 * Linear interpolation, the fractional position carried from one frame to
 * the next, so frames join without a gap or a repeat. Pure; unit-tested.
 */
export const PCM_RATE = 16_000;

export type PcmFrame = { track: "me" | "others"; offset: number; samples: Float32Array };

export class Resampler {
  /** Position of the next output sample, in input samples from the meeting's start. */
  private pos: number;
  /** Input samples seen so far (from the meeting's start). */
  private seen: number;
  private last = 0;
  private readonly step: number;
  private emitted: number;
  constructor(
    private readonly inRate: number,
    /** The input's first sample index from the meeting's start (a track that starts late). */
    startInput = 0,
  ) {
    this.step = inRate / PCM_RATE;
    this.seen = startInput;
    this.emitted = Math.ceil(startInput / this.step);
    this.pos = this.emitted * this.step;
  }

  /** Output samples emitted so far = the next frame's offset. */
  get offset() {
    return this.emitted;
  }

  /** Feed one input frame (mono); returns the 16 kHz samples and the first one's offset. */
  push(input: Float32Array): { offset: number; samples: Float32Array } {
    const offset = this.emitted;
    const base = this.seen;
    const end = base + input.length;
    const out: number[] = [];
    while (this.pos <= end - 1) {
      const i = this.pos - base;
      const i0 = Math.floor(i);
      const a = i0 < 0 ? this.last : input[i0];
      const b = input[Math.min(i0 + 1, input.length - 1)];
      const f = i - i0;
      out.push(a + (b - a) * f);
      this.pos += this.step;
      this.emitted++;
    }
    this.seen = end;
    if (input.length) this.last = input[input.length - 1];
    return { offset, samples: Float32Array.from(out) };
  }
}

/** Mixes a multi-channel frame to mono. */
export function toMono(channels: readonly Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0];
  const n = channels[0]?.length ?? 0;
  const out = new Float32Array(n);
  for (const c of channels) for (let i = 0; i < n; i++) out[i] += c[i] / channels.length;
  return out;
}

/** A small fan-out for PCM listeners; a throwing listener never stops the others. */
export class PcmHub {
  private readonly fs = new Set<(f: PcmFrame) => void>();
  on(f: (f: PcmFrame) => void): () => void {
    this.fs.add(f);
    return () => void this.fs.delete(f);
  }
  get size() {
    return this.fs.size;
  }
  emit(frame: PcmFrame) {
    for (const f of Array.from(this.fs)) {
      try {
        f(frame);
      } catch {}
    }
  }
}
