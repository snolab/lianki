/**
 * The pure pieces of `bun scripts/dev/shot.ts` (screenshots of the owner's
 * debug pages, docs/dev-debug-widget.md "Screenshots"): its arguments, the
 * reassembly of the chunks a shot comes back in, where each PNG goes, and
 * the burst timer. No I/O here; shot.ts does the socket and the files.
 * `burst` also runs on the page: shot.ts sends its source, so it must stay
 * self-contained (no imports, no outer names).
 */
import { join } from "node:path";

/** modern-screenshot, pinned (published 2026-04-16), from jsDelivr's ESM build. */
export const SHOT_LIB = "https://cdn.jsdelivr.net/npm/modern-screenshot@4.7.0/+esm";
/** The device pixel ratio is capped here: a 3× phone renders at 2×, which is faster. */
export const MAX_DPR = 2;
/** Most shots one burst may take. */
export const MAX_BURST = 50;

export type ShotArgs = {
  /** Only pages whose label (path + user agent) contains this: iPhone, Android, /words… */
  target?: string;
  /** A .png path, or a directory (ends with / or exists); default `.shots/`. */
  out?: string;
  /** Shots to take, `every` ms apart (the page's own timer). */
  burst: number;
  every: number;
  /** Render this element instead of the visible viewport. */
  selector?: string;
  label?: string;
  noPair: boolean;
  help: boolean;
};

/** Parse `[--target X] [--out path] [--burst N --every ms] [--selector css] [--label X] [--no-pair]`. */
export function parseShotArgs(argv: string[]): ShotArgs | { error: string } {
  const out: ShotArgs = { burst: 1, every: 1000, noPair: false, help: false };
  let every = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--no-pair") out.noPair = true;
    else if (["--target", "--out", "--burst", "--every", "--selector", "--label"].includes(a)) {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) return { error: `${a} needs a value` };
      if (a === "--burst" || a === "--every") {
        const n = Number(v);
        if (!Number.isInteger(n) || n < (a === "--burst" ? 1 : 0))
          return { error: `${a} needs a whole number${a === "--burst" ? " ≥ 1" : " of ms"}` };
        if (a === "--burst" && n > MAX_BURST) return { error: `--burst is at most ${MAX_BURST}` };
        if (a === "--burst") out.burst = n;
        else {
          out.every = n;
          every = true;
        }
      } else if (a === "--target") out.target = v;
      else if (a === "--out") out.out = v;
      else if (a === "--selector") out.selector = v;
      else out.label = v;
    } else return { error: `unknown argument ${a}` };
  }
  if (every && out.burst === 1) return { error: "--every goes with --burst N" };
  return out;
}

/** One chunk of a streamed piece, as the hub forwards it: {page, part, seq, total, data}. */
export type Chunk = Record<string, unknown>;

/**
 * Puts each page's streamed pieces back together from their chunks, which
 * may arrive in any order (they do not, over one socket, but nothing here
 * relies on it). `add` returns the whole piece once its last chunk is in.
 */
export class Reassembler {
  private readonly parts: Map<string, { total: number; got: number; data: string[] }>;
  constructor() {
    this.parts = new Map();
  }

  add(m: Chunk): { page: string; part: number; data: string } | undefined {
    const { seq, total, part, data } = m;
    const page = String(m.page ?? "");
    if (
      typeof data !== "string" ||
      !Number.isInteger(part) ||
      !Number.isInteger(total) ||
      !Number.isInteger(seq) ||
      (total as number) < 1 ||
      (seq as number) < 0 ||
      (seq as number) >= (total as number)
    )
      throw new Error(`bad chunk ${JSON.stringify({ part, seq, total })}`);
    const key = `${page}\u0000${part}`;
    let p = this.parts.get(key);
    if (!p) this.parts.set(key, (p = { total: total as number, got: 0, data: [] }));
    if (p.total !== total) throw new Error(`chunk ${seq} of part ${part}: total changed`);
    if (p.data[seq as number] === undefined) p.got++;
    p.data[seq as number] = data;
    if (p.got < p.total) return undefined;
    this.parts.delete(key);
    return { page, part: part as number, data: p.data.join("") };
  }

  /** Pieces still missing chunks, as `page#part (got/total)`. */
  pending(): string[] {
    return [...this.parts].map(([k, p]) => `${k.replace("\u0000", "#")} (${p.got}/${p.total})`);
  }
}

/** A filename-safe local time: 20261030-142501. */
export const stamp = (d: Date) =>
  `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}-` +
  `${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}${String(d.getSeconds()).padStart(2, "0")}`;

/**
 * Where shot `i` (0-based, of `burst`) from the `page`-th page (0-based, in
 * the order they answered) goes. `out` a .png file: that path, with `-<i+1>`
 * for a burst and `-p<page+1>` for every page but the first; a directory
 * (`isDir`, or no .png suffix), or none (`dir`, the default): `<stamp>…png` in it.
 */
export function shotPath(
  o: { out?: string; isDir?: boolean; dir: string; stamp: string },
  i: number,
  burst: number,
  page: number,
): string {
  const suffix = `${burst > 1 ? `-${i + 1}` : ""}${page > 0 ? `-p${page + 1}` : ""}`;
  if (o.out && !o.isDir && /\.png$/i.test(o.out)) return o.out.replace(/\.png$/i, `${suffix}.png`);
  return join(o.out ?? o.dir, `${o.stamp}${suffix}.png`);
}

/** One shot of a burst: when it started (ms after the first), and its error if it failed. */
export type BurstShot = { i: number; at: number; error?: string };

/**
 * Take `n` shots `every` ms apart — shot i is due at start + i·every; one
 * that is late (the last took longer) starts at once, and none overlap. A
 * failed shot is recorded and the burst goes on. Runs on the page (shot.ts
 * sends this function's source) with performance.now and setTimeout.
 */
export async function burst(
  n: number,
  every: number,
  take: (i: number) => Promise<void>,
  clock: { now: () => number; sleep: (ms: number) => Promise<void> },
): Promise<BurstShot[]> {
  const shots: BurstShot[] = [];
  const start = clock.now();
  for (let i = 0; i < n; i++) {
    const wait = start + i * every - clock.now();
    if (wait > 0) await clock.sleep(wait);
    const at = Math.round(clock.now() - start);
    try {
      await take(i);
      shots.push({ i, at });
    } catch (e) {
      shots.push({ i, at, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) });
    }
  }
  return shots;
}

/** "1.3 MB", "820 KB". */
export const size = (bytes: number) =>
  bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.round(bytes / 1e3)} KB`;
