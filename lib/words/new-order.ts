/**
 * New-word order: which list the next new word comes from, as a walk over
 * the list tree (docs/new-word-scheduler.md). Pure, no I/O. Used by the
 * /dev/new-order simulator; the study view does not use it yet.
 *
 * /words is an endless stream, so there are no daily caps or quotas. Each
 * parent shares the stream among its children by its mode:
 *
 * - "seq"     in order (the default inside a group): a child opens once the
 *             one before it passes; the earliest open child with words left
 *             gives every new word
 * - "rr"      take turns (the root's default): all children open, equal shares
 * - "weighted" by weight: all children open, shares by each child's weight
 *             (e.g. 3:1; 0 pauses a child)
 * - "stagger" opens like "seq", but open children share the stream, each
 *             `ratio` times the share of the next
 *
 * Pass = the list's progress (lib/words/progress.ts, the picker's ring) at
 * `passAt`, 60% by default. Mastered = 100%. Seen = shown at least once.
 *
 * Shares are ratios of the stream. A parent picks from a fixed pattern of
 * its active children (stride scheduling over integer weights), indexed by
 * how many words of those children are seen. Only stored state is read
 * (seen counts, progress, the tree), so the sequence is the same after a
 * reload, and a list that passes (its reviews raise its progress) opens the
 * next one at the very next new word.
 */

export type NewOrderMode = "seq" | "rr" | "stagger" | "weighted";

export type NodeOrder = {
  /** Unset: inherited from the nearest ancestor that sets one (the root's own setting excluded); else the default. */
  mode?: NewOrderMode;
  /** seq and stagger: the progress at which a child passes and the next one opens. 0..1. */
  passAt?: number;
  /** stagger: an open child gets `ratio` times the share of the one after it. 1..4. */
  ratio?: number;
};

export type OrderNode = {
  id: string;
  name?: string;
  lang?: string;
  /** Words in the list (leaves). */
  size?: number;
  /** Words seen at least once (leaves). */
  seen?: number;
  /** The words' progress scores summed (leaves): progress = score / size. */
  score?: number;
  /** This node's weight in its parent's share ("weighted", and a factor in "stagger"). 0 pauses it. Default 1. */
  weight?: number;
  order?: NodeOrder;
  /** Children in priority order: the lists' drag order. */
  children?: OrderNode[];
};

/** Pass mark: a list passes at 60% progress. */
export const DEFAULT_PASS_AT = 0.6;
export const DEFAULT_RATIO = 2;
/** The root's mode when it sets none: languages take turns. */
export const ROOT_MODE: NewOrderMode = "rr";
/** A group's mode when neither it nor an ancestor sets one. */
export const GROUP_MODE: NewOrderMode = "seq";

export type Resolved = { mode: NewOrderMode; passAt: number; ratio: number };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const isLeaf = (n: OrderNode) => !n.children?.length;

/** Effective settings per parent: own, else inherited (not from the root), else the defaults. */
export function resolveOrders(root: OrderNode): Map<string, Resolved> {
  const out = new Map<string, Resolved>();
  const walk = (n: OrderNode, inherited: NodeOrder, isRoot: boolean) => {
    if (isLeaf(n)) return;
    const own = n.order ?? {};
    const mode = own.mode ?? (isRoot ? ROOT_MODE : (inherited.mode ?? GROUP_MODE));
    const r: Resolved = {
      mode,
      passAt: clamp(own.passAt ?? inherited.passAt ?? DEFAULT_PASS_AT, 0, 1),
      ratio: clamp(own.ratio ?? inherited.ratio ?? DEFAULT_RATIO, 1, 4),
    };
    out.set(n.id, r);
    // The root's own choice is about languages; it is not handed down.
    const next: NodeOrder = isRoot ? {} : { ...inherited, ...own };
    for (const c of n.children!) walk(c, next, false);
  };
  walk(root, {}, true);
  return out;
}

/**
 * Lists sitting directly at the root, in a tree without language groups:
 * the ones sharing a language become one virtual group (`lang:<code>`, at the
 * first one's place), so the root's take-turns runs between languages, not
 * between N5 and N1. Groups and lone lists stay as they are.
 */
export function bucketByLanguage(root: OrderNode): OrderNode {
  const kids = root.children ?? [];
  const count = new Map<string, number>();
  for (const c of kids) if (isLeaf(c) && c.lang) count.set(c.lang, (count.get(c.lang) ?? 0) + 1);
  if (![...count.values()].some((n) => n > 1)) return root;
  const buckets = new Map<string, OrderNode>();
  const out: OrderNode[] = [];
  for (const c of kids) {
    if (!isLeaf(c) || !c.lang || count.get(c.lang)! < 2) {
      out.push(c);
      continue;
    }
    let b = buckets.get(c.lang);
    if (!b) {
      b = { id: `lang:${c.lang}`, name: c.lang, lang: c.lang, children: [] };
      buckets.set(c.lang, b);
      out.push(b);
    }
    b.children!.push(c);
  }
  return { ...root, children: out };
}

/** Seen counts by leaf id: the state the walk reads and the plan advances. */
export type SeenMap = Map<string, number>;

export function seenOf(root: OrderNode): SeenMap {
  const m: SeenMap = new Map();
  const walk = (n: OrderNode) => {
    if (isLeaf(n)) m.set(n.id, clamp(Math.round(n.seen ?? 0), 0, n.size ?? 0));
    else n.children!.forEach(walk);
  };
  walk(root);
  return m;
}

const patterns = new Map<string, number[]>();
/** Stride order over integer weights, length Σw: the smallest (picks+1)/w next, ties to the earlier. */
export function stridePattern(weights: number[]): number[] {
  const key = weights.join(",");
  const hit = patterns.get(key);
  if (hit) return hit;
  const total = weights.reduce((a, b) => a + b, 0);
  const picks = weights.map(() => 0);
  const out: number[] = [];
  for (let i = 0; i < total; i++) {
    let best = -1;
    let bestKey = Infinity;
    weights.forEach((w, j) => {
      if (w <= 0) return;
      const k = (picks[j] + 1) / w;
      if (k < bestKey - 1e-12) {
        bestKey = k;
        best = j;
      }
    });
    picks[best]++;
    out.push(best);
  }
  if (patterns.size > 500) patterns.clear();
  patterns.set(key, out);
  return out;
}

/** Real weights to small integers with the same ratios (to 1/4 of the smallest), at most 4096 in all. */
export function integerWeights(ws: number[]): number[] {
  const pos = ws.filter((w) => w > 0);
  if (!pos.length) return ws.map(() => 0);
  const min = Math.min(...pos);
  let q = ws.map((w) => (w > 0 ? Math.max(1, Math.round((w / min) * 4)) : 0));
  while (q.reduce((a, b) => a + b, 0) > 4096)
    q = q.map((w) => (w > 0 ? Math.max(1, Math.round(w / 2)) : 0));
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
  const g = q.filter((w) => w > 0).reduce(gcd);
  return q.map((w) => w / g);
}

type Ctx = { orders: Map<string, Resolved>; seen: SeenMap };

export type Totals = { size: number; seen: number; score: number };

/** A subtree's words, seen words and progress score sum (the Anki subdeck rule). */
export function totals(n: OrderNode, ctx: { seen: SeenMap }): Totals {
  if (isLeaf(n)) return { size: n.size ?? 0, seen: ctx.seen.get(n.id) ?? 0, score: n.score ?? 0 };
  const t: Totals = { size: 0, seen: 0, score: 0 };
  for (const c of n.children!) {
    const x = totals(c, ctx);
    t.size += x.size;
    t.seen += x.seen;
    t.score += x.score;
  }
  return t;
}

/** Progress 0..1: the mean word score. An empty list counts as passed. */
export const progressOf = (t: Totals) => (t.size > 0 ? Math.min(1, t.score / t.size) : 1);

/** The children of a parent that may give the next word, with their weights, in priority order. */
export function activeChildren(
  n: OrderNode,
  r: Resolved,
  ctx: { seen: SeenMap },
): { child: OrderNode; weight: number; seen: number }[] {
  const kids = n.children ?? [];
  const t = kids.map((c) => totals(c, ctx));
  const open = kids.map(() => true);
  if (r.mode === "seq" || r.mode === "stagger")
    for (let i = 1; i < kids.length; i++)
      open[i] = open[i - 1] && progressOf(t[i - 1]) >= r.passAt - 1e-9;
  const active = kids
    .map((child, i) => ({ child, i }))
    .filter(
      ({ child, i }) =>
        open[i] &&
        t[i].seen < t[i].size &&
        (r.mode === "seq" || r.mode === "rr" || (child.weight ?? 1) > 0),
    );
  const m = active.length;
  return active.map(({ child, i }, k) => ({
    child,
    seen: t[i].seen,
    weight:
      r.mode === "seq" || r.mode === "rr"
        ? 1
        : (child.weight ?? 1) * (r.mode === "stagger" ? r.ratio ** (m - 1 - k) : 1),
  }));
}

function pick(n: OrderNode, ctx: Ctx): OrderNode | null {
  if (isLeaf(n)) return (ctx.seen.get(n.id) ?? 0) < (n.size ?? 0) ? n : null;
  const r = ctx.orders.get(n.id)!;
  const active = activeChildren(n, r, ctx);
  if (!active.length) return null;
  if (r.mode === "seq") {
    for (const a of active) {
      const leaf = pick(a.child, ctx);
      if (leaf) return leaf;
    }
    return null;
  }
  const pattern = stridePattern(integerWeights(active.map((a) => a.weight)));
  const phase = active.reduce((s, a) => s + a.seen, 0);
  for (let j = 0; j < pattern.length; j++) {
    const leaf = pick(active[pattern[(phase + j) % pattern.length]].child, ctx);
    if (leaf) return leaf;
  }
  return null;
}

/** The leaf the next new word comes from, or null when no list has words left. */
export function nextLeaf(
  root: OrderNode,
  seen: SeenMap = seenOf(root),
  orders: Map<string, Resolved> = resolveOrders(root),
): OrderNode | null {
  return pick(root, { orders, seen });
}

/**
 * The next n new words' lists, in order. Each pick counts as seen for the
 * next one (as words pulled into the study queue do). `seen` is advanced in
 * place when given. `orders` lets a subtree be planned with the settings it
 * has in the whole tree (its inherited mode), not as a root of its own.
 */
export function planNew(
  root: OrderNode,
  n: number,
  seen: SeenMap = seenOf(root),
  orders: Map<string, Resolved> = resolveOrders(root),
): string[] {
  const ctx: Ctx = { orders, seen };
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const leaf = pick(root, ctx);
    if (!leaf) break;
    seen.set(leaf.id, (seen.get(leaf.id) ?? 0) + 1);
    out.push(leaf.id);
  }
  return out;
}

/** Words per list in a plan, in the order each list first appears. */
export function tally(plan: string[]): [string, number][] {
  const m = new Map<string, number>();
  for (const id of plan) m.set(id, (m.get(id) ?? 0) + 1);
  return [...m];
}

/** Leaves in tree order. */
export function leavesOf(root: OrderNode): OrderNode[] {
  return isLeaf(root) ? [root] : root.children!.flatMap(leavesOf);
}
