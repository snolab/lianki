/**
 * The roadmap's ordering notation (owner, 2026-11-27): a step carries a
 * stage number and, when it shares the stage, a lane letter. Numbers run in
 * sequence, letters side by side: 1, 2A, 2B, 2C, 3 = step 1, then 2A/2B/2C in
 * parallel, then 3. Pure, shared by the generator, the save route and the page.
 */

export type Staged = { stage?: number; lane?: string; order?: number };

/** "2B" → { stage: 2, lane: "B" }; "3" → { stage: 3 }; anything else → null. */
export function parseStepLabel(s: unknown): { stage: number; lane?: string } | null {
  if (typeof s === "number") return Number.isInteger(s) && s >= 1 ? { stage: s } : null;
  if (typeof s !== "string") return null;
  const m = s
    .normalize("NFKC")
    .trim()
    .match(/^(\d{1,3})\s*([A-Za-z])?$/);
  if (!m) return null;
  const stage = Number(m[1]);
  if (stage < 1) return null;
  return m[2] ? { stage, lane: m[2].toUpperCase() } : { stage };
}

/** The label a step shows: "2B", or "3" for a stage of one. */
export function stepLabel(n: Staged): string {
  return `${n.stage ?? (n.order ?? 0) + 1}${n.lane ?? ""}`;
}

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/**
 * Steps in notation order with dense stages (1, 2, 3… with no gaps), letters
 * A, B, C… only where a stage holds more than one step, and `order` = the
 * flat position. A step without a stage (saved before the notation) takes
 * the stage after its `order` rank, so an old roadmap reads 1, 2, 3, … as it
 * always did. Steps of one stage keep their letter order, then their given order.
 */
export function normalizeSteps<T extends Staged>(nodes: readonly T[]): T[] {
  const ranked = nodes
    .map((n, i) => ({ n, i }))
    .sort((a, b) => (a.n.order ?? a.i) - (b.n.order ?? b.i) || a.i - b.i)
    .map(({ n, i }, rank) => ({
      n,
      i,
      stage: Number.isInteger(n.stage) && (n.stage as number) >= 1 ? (n.stage as number) : null,
      rank,
    }));
  // A legacy step (no stage) sits after the staged steps that come before it.
  let last = 0;
  const keyed = ranked.map((r) => {
    const s = r.stage ?? last + 1;
    last = Math.max(last, s);
    return { ...r, s };
  });
  keyed.sort(
    (a, b) =>
      a.s - b.s || (a.n.lane ?? "").localeCompare(b.n.lane ?? "") || a.rank - b.rank || a.i - b.i,
  );
  const out: T[] = [];
  let stage = 0;
  let prev: number | null = null;
  for (let k = 0; k < keyed.length; ) {
    const s = keyed[k].s;
    let j = k;
    while (j < keyed.length && keyed[j].s === s) j++;
    if (s !== prev) stage++;
    prev = s;
    const group = keyed.slice(k, j);
    group.forEach((g, gi) => {
      const { lane: _lane, ...rest } = g.n as T & { lane?: string };
      const node = { ...rest, stage, order: out.length } as T;
      if (group.length > 1) (node as Staged).lane = LETTERS[gi] ?? LETTERS[LETTERS.length - 1];
      out.push(node);
    });
    k = j;
  }
  return out;
}

/** Steps grouped by stage, in order: [[1], [2A, 2B, 2C], [3]]. Expects normalized steps. */
export function stages<T extends Staged>(nodes: readonly T[]): T[][] {
  const out: T[][] = [];
  for (const n of nodes) {
    const s = n.stage ?? (n.order ?? 0) + 1;
    const g = out[out.length - 1];
    if (g && (g[0].stage ?? (g[0].order ?? 0) + 1) === s) g.push(n);
    else out.push([n]);
  }
  return out;
}
