#!/usr/bin/env bun
/**
 * Screenshot the owner's open debug pages (the PWA on a phone, say), through
 * the same eval channel as scripts/dev/eval.ts, and print each PNG's path.
 * docs/dev-debug-widget.md, "Screenshots", has the speed and the limits.
 *
 *   bun scripts/dev/shot.ts [--target iPhone|Android|<page-match>] [--out <path>]
 *                           [--burst N --every <ms>] [--selector <css>]
 *                           [--label "…"] [--no-pair]
 *
 *   --target    only pages whose label (path + user agent) contains it
 *   --out       a .png file, or a directory; default .shots/ at the repo root
 *               (gitignored). A burst or a second page adds -<n> / -p<n>.
 *   --burst N   N shots, --every ms apart, timed by the page itself; each is
 *               streamed back and written as it arrives
 *   --selector  render that element instead of the visible viewport
 *   --no-pair   fail instead of asking the owner
 *
 * It resumes the saved eval grant (.debug-eval-token.json, as eval.ts does),
 * so under a live grant there is no prompt; with none it pairs once, which
 * prompts the owner. Paths go to stdout, one per line; timings to stderr.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, relative } from "node:path";
import { RESULT_MS, controller, run } from "./eval-socket";
import { pageShot } from "./shot-page";
import {
  MAX_DPR,
  Reassembler,
  SHOT_LIB,
  type ShotArgs,
  burst,
  parseShotArgs,
  shotPath,
  size,
  stamp,
} from "./shot-lib";

const parsed = parseShotArgs(process.argv.slice(2));
if ("error" in parsed) {
  console.error(`${parsed.error}\n(bun scripts/dev/shot.ts --help)`);
  process.exit(2);
}
const args: ShotArgs = parsed;
if (args.help) {
  const src = readFileSync(new URL(import.meta.url).pathname, "utf8");
  console.log(src.slice(src.indexOf("/**"), src.indexOf("*/") + 2));
  process.exit(0);
}

const ROOT = join(import.meta.dir, "..", "..");
const isDir =
  !!args.out &&
  (args.out.endsWith("/") || (existsSync(args.out) && statSync(args.out).isDirectory()));
const where = { out: args.out, isDir, dir: join(ROOT, ".shots"), stamp: stamp(new Date()) };

/** The eval code: pageShot called with $lk, the options and the burst timer. */
const code = `return (${pageShot.toString()})(typeof $lk === "undefined" ? undefined : $lk, ${JSON.stringify(
  {
    lib: SHOT_LIB,
    maxDpr: MAX_DPR,
    burst: args.burst,
    every: args.every,
    selector: args.selector,
    timeout: 5000,
  },
)}, ${burst.toString()});`;

const { evalSocket } = controller({
  label: args.label ?? `lianki shot on ${hostname()}`,
  labelFlag: args.label,
  noPair: args.noPair,
});

async function main() {
  const c0 = performance.now();
  const ws = await evalSocket();
  const t0 = performance.now();
  const parts = new Reassembler();
  const pages: string[] = [];
  let written = 0;
  const results = await run(ws, code, args.target, {
    // The page's own wait between shots, plus the usual allowance.
    waitMs: RESULT_MS + args.every,
    onChunk: (m) => {
      const piece = parts.add(m);
      if (!piece) return;
      const shot = JSON.parse(piece.data) as {
        i: number;
        at: number;
        ms: number;
        w: number;
        h: number;
        png: string;
      };
      if (!pages.includes(piece.page)) pages.push(piece.page);
      const path = shotPath(where, shot.i, args.burst, pages.indexOf(piece.page));
      mkdirSync(dirname(path), { recursive: true });
      const png = Buffer.from(shot.png, "base64");
      writeFileSync(path, png);
      written++;
      console.log(path);
      console.error(
        `shot ${shot.i + 1}/${args.burst}: ${shot.w}×${shot.h} ${size(png.length)} · render ${shot.ms} ms on the page (at +${shot.at} ms) · here after ${Math.round(performance.now() - t0)} ms · ${relative(process.cwd(), path)} · ${piece.page.slice(0, 60)}`,
      );
    },
  });
  ws.close();
  let failed = written === 0;
  for (const r of results) {
    if (r.ok !== true) {
      failed = true;
      console.error(`${String(r.page ?? "page").slice(0, 60)}: ${String(r.error)}`);
      continue;
    }
    let v: { errors?: string[]; importMs?: number; scale?: number } = {};
    try {
      v = JSON.parse(String(r.value));
    } catch {}
    for (const e of v.errors ?? []) console.error(`shot ${e}`);
    if (v.errors?.length) failed = true;
    console.error(
      `done in ${Math.round(performance.now() - t0)} ms after connecting (${Math.round(t0 - c0)} ms; import ${v.importMs} ms, scale ${v.scale}×) · ${String(r.page ?? "").slice(0, 60)}`,
    );
  }
  if (!results.length) console.error("no page answered (is a debug page open and in front?)");
  const missing = parts.pending();
  if (missing.length) console.error(`incomplete: ${missing.join(", ")}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
