#!/usr/bin/env bun
/**
 * Upload rendered clips (render.py's out dir) to the production R2 bucket,
 * in batches through `wrangler r2 bulk put`. The Cloudflare API allows about
 * 1200 requests per 5 minutes, so this is ~4 clips a second: a full render
 * takes hours. A batch that hits the limit waits it out and is sent again
 * (re-sending a clip is harmless). Japanese goes first. Incremental: keys already sent
 * are listed in <out>/uploaded.txt and skipped, so it can run again while a
 * render is still going.
 *
 *   bun scripts/voice/upload.ts ~/.cache/lianki-voice/out
 */
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { join, relative } from "path";
import { $ } from "bun";

const out = process.argv[2];
if (!out) throw new Error("usage: upload.ts <out dir>");
const BATCH = 1000;
const FIRST = ["ja", "zh", "en"];
const rank = (f: string) => {
  const i = FIRST.indexOf(relative(out, f).split("/")[1]);
  return i < 0 ? FIRST.length : i;
};
const log = join(out, "uploaded.txt");
const sent = new Set(existsSync(log) ? readFileSync(log, "utf8").split("\n") : []);

const files = (readdirSync(join(out, "voice"), { recursive: true }) as string[])
  .filter((f) => f.endsWith(".mp3"))
  .map((f) => join(out, "voice", f));
const todo = files.filter((f) => !sent.has(relative(out, f))).sort((a, b) => rank(a) - rank(b));
console.log(`${todo.length} of ${files.length} clips to upload`);

for (let i = 0; i < todo.length; i += BATCH) {
  const batch = todo.slice(i, i + BATCH).map((file) => ({ key: relative(out, file), file }));
  const list = join(out, "batch.json");
  writeFileSync(list, JSON.stringify(batch));
  for (;;) {
    const r =
      await $`bunx wrangler r2 bulk put lianki-blobs --remote -f ${list} --ct audio/mpeg --concurrency 4`
        .quiet()
        .nothrow();
    if (r.exitCode === 0) break;
    if (!/429|Too Many Requests/.test(r.stderr.toString())) throw new Error(r.stderr.toString());
    console.log("rate limited; waiting 5 minutes");
    await Bun.sleep(5 * 60_000);
  }
  appendFileSync(log, batch.map((b) => b.key).join("\n") + "\n");
  console.log(`${Math.min(i + BATCH, todo.length)}/${todo.length}`);
}
