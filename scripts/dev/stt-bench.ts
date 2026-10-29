#!/usr/bin/env bun
/**
 * Compare the Workers AI speech-to-text models on the owner's own voice clips
 * (docs/workers-ai.md, "Speech to text"; the clips come from the mic's clip
 * sink, docs/dev-debug-widget.md).
 *
 *   bun scripts/dev/stt-bench.ts --sink https://<machine>.<tailnet>.ts.net/lianki-widget
 *       [--models @cf/openai/whisper-large-v3-turbo,@cf/deepgram/nova-3] [--target <text>]
 *       [--clips-dir <dir>]
 *
 * It runs on the owner's debug page through scripts/dev/eval.ts (his session,
 * an eval pairing: run `eval.ts serve` first or approve the prompt), which
 * transcribes every clip with every model via /api/debug/stt?model= and posts
 * the raw results to the dev server. Then it scores them here and writes
 * bench-<time>.json and bench-<time>.md into the clips folder. A clip's
 * corrected text, in `<clip>.ref.txt` beside it, adds a CER per model.
 * --clips-dir (or LIANKI_CLIPS_DIR) is the folder, the same one the dev
 * server writes to; LIANKI_CLIP_SINK stands in for --sink.
 */
import { existsSync, readFileSync, watch, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { STT_MODELS } from "../../lib/stt";
import { clipsDir, listClips } from "./clip-sink";
import { type BenchResult, aggregate, benchCode, markdown } from "./stt-bench-lib";

const args = Bun.argv.slice(2);
const flag = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i === -1 ? undefined : args[i + 1];
};
const sink = flag("sink") ?? process.env.LIANKI_CLIP_SINK;
if (!sink) {
  console.error(
    "usage: bun scripts/dev/stt-bench.ts --sink <dev server URL> [--models a,b] [--target <text>]",
  );
  process.exit(2);
}
const models = (flag("models") ?? STT_MODELS.join(",")).split(",").filter(Boolean);
const target = flag("target");
const dir = flag("clips-dir") ? resolve(flag("clips-dir") as string) : clipsDir();
const clips = listClips(dir);
if (!clips.length) {
  console.error(`No clips in ${dir} yet: turn on the mic with lk:debug-clip-sink set, and talk.`);
  process.exit(1);
}
const run = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const raw = join(dir, `bench-raw-${run}.json`);
console.error(`${clips.length} clip(s) × ${models.length} model(s); run ${run}`);

/** Wait for the page's results to land (the eval answer itself may time out first). */
const landed = new Promise<void>((resolve, reject) => {
  if (existsSync(raw)) return resolve();
  const w = watch(dir, (_e, f) => {
    if (f === `bench-raw-${run}.json`) {
      w.close();
      clearTimeout(give);
      resolve();
    }
  });
  const give = setTimeout(() => {
    w.close();
    reject(new Error("no results from the page within 15 minutes"));
  }, 15 * 60_000);
});

const evalTs = join(import.meta.dir, "eval.ts");
const p = Bun.spawn(["bun", evalTs, ...(target ? ["--target", target] : []), "-"], {
  stdin: new TextEncoder().encode(benchCode(sink, models, run)),
  stdout: "inherit",
  stderr: "inherit",
});
await p.exited;
await landed;

const { results } = JSON.parse(readFileSync(raw, "utf8")) as { results: BenchResult[] };
const bench = aggregate(results, clips);
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
writeFileSync(join(dir, `bench-${stamp}.json`), JSON.stringify({ run, ...bench }, null, 2));
writeFileSync(join(dir, `bench-${stamp}.md`), markdown(bench, `STT bench ${stamp}`));
console.log(markdown(bench, `STT bench ${stamp}`));
console.error(`Wrote bench-${stamp}.json and .md in the clips folder.`);
