#!/usr/bin/env bun
/**
 * Stream saved voice clips through the local STT server the way the mic does
 * (docs/local-stt.md): 512-sample frames (32 ms) at real-time pace, the first
 * 192 ms held back as the VAD's pre-pad, then `end`. Prints each partial as it
 * arrives, then the final, the time to the first partial and end → final.
 * Never the live mic.
 *
 *   bun scripts/local-stt/stream-clip.ts [--url ws://127.0.0.1:5193] [--fast] [clip.wav ...]
 *       # no clips: every .wav in ~/lianki-voice-clips; --fast: no real-time pacing
 */
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { connectLocalStt, readWav } from "./stream-clip-lib";

const args = Bun.argv.slice(2);
const flag = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i === -1 ? undefined : args.splice(i, 2)[1];
};
const url = flag("url") ?? "ws://127.0.0.1:5193";
const fast = args.includes("--fast");
const files = args.filter((a) => !a.startsWith("--"));
const dir = join(homedir(), "lianki-voice-clips");
const clips = files.length
  ? files
  : readdirSync(dir)
      .filter((f) => f.endsWith(".wav"))
      .sort()
      .map((f) => join(dir, f));

const FRAME = 512;
const PRE = 6 * FRAME;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Per 512-sample frame: louder than a quarter of the clip's loud frames (its 90th percentile RMS). */
function voicedFrames(s: Float32Array): boolean[] {
  const rms: number[] = [];
  for (let o = 0; o < s.length; o += FRAME) {
    let e = 0;
    const end = Math.min(o + FRAME, s.length);
    for (let i = o; i < end; i++) e += s[i] * s[i];
    rms.push(Math.sqrt(e / Math.max(1, end - o)));
  }
  const loud = [...rms].sort((a, b) => a - b)[Math.floor(rms.length * 0.9)] ?? 0;
  return rms.map((r) => r > loud / 4);
}

/** The voiced share of the frames between two sample offsets. */
function voicedShare(v: boolean[], from: number, to: number): number {
  const a = Math.floor(from / FRAME);
  const b = Math.max(a + 1, Math.ceil(to / FRAME));
  let n = 0;
  for (let i = a; i < b; i++) if (v[i]) n++;
  return n / (b - a);
}

const stt = await connectLocalStt(url);
for (const file of clips) {
  const { rate, samples } = readWav(new Uint8Array(readFileSync(file)));
  if (rate !== 16000) {
    console.error(`${file}: ${rate} Hz, skipped (16 kHz only)`);
    continue;
  }
  const t0 = performance.now();
  let first: number | undefined;
  let partials = 0;
  // The longest wait between things on screen while it listens (the owner's floor: 0.2 s):
  // over all gaps, and over those the speaker was talking through (a pause owes no new text).
  const voiced = voicedFrames(samples);
  let sent = PRE;
  let last = t0;
  let lastSent = PRE;
  let maxGap = 0;
  let maxSpeechGap = 0;
  const u = stt.begin((text) => {
    const now = performance.now();
    partials++;
    first ??= now - t0;
    maxGap = Math.max(maxGap, now - last);
    if (voicedShare(voiced, lastSent, sent) >= 0.5) maxSpeechGap = Math.max(maxSpeechGap, now - last);
    last = now;
    lastSent = sent;
    if (!fast) console.log(`  … ${text}`);
  });
  if (!u) throw new Error("not connected");
  for (let o = PRE; o < samples.length; o += FRAME) {
    u.frame(samples.subarray(o, o + FRAME));
    sent = o + FRAME;
    if (!fast) await sleep(32);
  }
  const f = await u.end(samples);
  console.log(
    `${file.split("/").pop()}  ${(samples.length / rate).toFixed(1)} s  partials ${partials}` +
      `  first ${first === undefined ? "-" : Math.round(first)} ms  max gap ${Math.round(maxGap)} ms (in speech ${Math.round(maxSpeechGap)})  end→final ${f.endToFinalMs} ms (decode ${f.ms})\n  = ${f.text}`,
  );
}
stt.close();
