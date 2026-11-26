/**
 * The estimator: a P5/P50/P95 range for a task, from how long similar done
 * tasks really took (the state tree's done history), calibrated by a log of
 * past estimates and their actuals. Pure: no files, no network, so the CLI
 * (scripts/dev/estimate.ts), progress.ts --eta auto, the hub and the Gantt
 * can all use it. docs/state-tree.md, "Estimates".
 *
 * Every duration is in milliseconds; the maths is in log space (durations are
 * roughly log-normal: a task is "2× longer", not "20 minutes longer").
 */

export const ESTIMATE_KINDS = [
  "ui-fix",
  "review",
  "deploy",
  "investigation",
  "browser-automation",
  "backend-feature",
  "docs",
  "test",
  "ops",
  "other",
] as const;
export type EstimateKind = (typeof ESTIMATE_KINDS)[number];
export const isEstimateKind = (k: unknown): k is EstimateKind =>
  typeof k === "string" && (ESTIMATE_KINDS as readonly string[]).includes(k);

const MIN = 60_000;
/** z of the 95th percentile of a normal: P5/P95 = P50 · e^(∓Z95·σ). */
export const Z95 = 1.6448536;

/** A prior: the median and the log-space spread (σ) of a kind's duration. */
export type Prior = { p50: number; sigma: number };

/**
 * Starting priors per kind, used when the history is thin. Wide on purpose
 * (σ 0.9 ≈ P95/P5 of 19×); the history and the log narrow them.
 */
export const DEFAULT_PRIORS: Record<EstimateKind, Prior> = {
  "ui-fix": { p50: 30 * MIN, sigma: 0.9 },
  review: { p50: 15 * MIN, sigma: 0.8 },
  deploy: { p50: 20 * MIN, sigma: 0.8 },
  investigation: { p50: 25 * MIN, sigma: 0.9 },
  "browser-automation": { p50: 30 * MIN, sigma: 0.9 },
  "backend-feature": { p50: 75 * MIN, sigma: 0.9 },
  docs: { p50: 15 * MIN, sigma: 0.8 },
  test: { p50: 25 * MIN, sigma: 0.8 },
  ops: { p50: 20 * MIN, sigma: 0.9 },
  other: { p50: 35 * MIN, sigma: 1.0 },
};

/** Keyword rules, first match wins (checked against the title and the path). */
const KIND_RULES: [EstimateKind, RegExp][] = [
  ["review", /\breview|\bpr #?\d+ check|\baudit\b|审查|审核|复查/i],
  ["deploy", /\bdeploy|\brelease\b|\bship\b|\bmerge\b|\bpublish|\brollout|上线|部署|发布/i],
  [
    "browser-automation",
    /\bbrowser\b|\brech\b|\bplaywright|\bpuppeteer|\bscreenshot|\bshot\b|\bqa\b|浏览器|截图/i,
  ],
  [
    "investigation",
    /\binvestigat|\bdebug|\bwhy\b|\blook ?up|\bresearch|\bdiagnos|调查|排查|为什么|查/i,
  ],
  ["docs", /\bdocs?\b|\breadme|\bblog\b|\bagents\.md|\bwrite-?up|文档|博客/i],
  ["test", /\btests?\b|\bunit\b|\bcoverage|\bflak|测试/i],
  ["ops", /\btoken|\bsecret|\bdns\b|\bcron|\bworker\b|\btunnel|\bconfig\b|\bflag\b|\bci\b|运维/i],
  [
    "ui-fix",
    /\bui\b|\bcss\b|\blayout|\bbutton|\bicon|\bcolou?r|\bpill\b|\bbar\b|\bscroll|\bmenu|\bdark|\btheme|\bpage\b|界面|按钮|样式|显示/i,
  ],
  [
    "backend-feature",
    /\bapi\b|\bd1\b|\bhub\b|\bserver|\bendpoint|\bschema|\bmigrat|\bfeat|后端|接口/i,
  ],
];

/** A kind from a task's title and node path, by keyword. */
export function classifyKind(title: string, id = ""): EstimateKind {
  const text = `${title} ${id.replace(/[/._-]+/g, " ")}`;
  for (const [kind, re] of KIND_RULES) if (re.test(text)) return kind;
  return "other";
}

const STOP = new Set(
  "a an the and or of to in on for with from by at is it as be this that fix add new make get use run".split(
    " ",
  ),
);

/**
 * Lower-case words of 3+ letters, minus stop words, and the character pairs
 * of each CJK run (a lone character stays itself): "甘特图" → 甘特, 特图.
 */
export function keywords(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.toLowerCase().match(/[a-z0-9]{3,}|[぀-ヿ一-鿿]+/g) ?? []) {
    if (/^[a-z0-9]/.test(w)) {
      if (!STOP.has(w)) out.add(w);
    } else if (w.length === 1) out.add(w);
    else for (let i = 0; i + 1 < w.length; i++) out.add(w.slice(i, i + 2));
  }
  return out;
}

/** One done task as the estimator sees it. */
export type Sample = {
  title: string;
  id: string;
  agent: string;
  kind: EstimateKind;
  actualMs: number;
  /** The estimate it was given (ms), when there was one. */
  estimateMs?: number;
  endedAt: number;
};

/** The shape of a state-tree done-history record that the estimator reads. */
export type HistoryLike = {
  id: string;
  title: string;
  agent: string;
  created: number;
  startedAt?: number;
  endedAt: number;
  estimateMs?: number;
};

/**
 * Actuals outside this are junk: back-dated nodes, and nodes left open
 * across days (the history knows start and end, not the hours worked).
 */
export const SAMPLE_MIN_MS = MIN;
export const SAMPLE_MAX_MS = 24 * 60 * MIN;

/** Done-history records → samples: actual = end − (start, else creation), junk dropped. */
export function samplesFromHistory(records: Iterable<HistoryLike>): Sample[] {
  const out: Sample[] = [];
  for (const r of records) {
    const actualMs = r.endedAt - (r.startedAt ?? r.created);
    if (!(actualMs >= SAMPLE_MIN_MS && actualMs <= SAMPLE_MAX_MS)) continue;
    const s: Sample = {
      title: r.title,
      id: r.id,
      agent: r.agent,
      kind: classifyKind(r.title, r.id),
      actualMs,
      endedAt: r.endedAt,
    };
    if (r.estimateMs && r.estimateMs > 0) s.estimateMs = r.estimateMs;
    out.push(s);
  }
  return out;
}

/** Weighted quantile (q in 0..1) of values; linear between the weight midpoints. */
export function weightedQuantile(values: readonly number[], weights: readonly number[], q: number) {
  const pts = values
    .map((v, i) => ({ v, w: weights[i] ?? 1 }))
    .filter((p) => p.w > 0 && Number.isFinite(p.v))
    .sort((a, b) => a.v - b.v);
  if (!pts.length) return NaN;
  if (pts.length === 1) return pts[0]!.v;
  const total = pts.reduce((s, p) => s + p.w, 0);
  let acc = 0;
  const mids = pts.map((p) => {
    const m = (acc + p.w / 2) / total;
    acc += p.w;
    return m;
  });
  if (q <= mids[0]!) return pts[0]!.v;
  for (let i = 1; i < pts.length; i++)
    if (q <= mids[i]!) {
      const t = (q - mids[i - 1]!) / (mids[i]! - mids[i - 1]!);
      return pts[i - 1]!.v + t * (pts[i]!.v - pts[i - 1]!.v);
    }
  return pts[pts.length - 1]!.v;
}

/** Plain quantile (equal weights). */
export const quantile = (values: readonly number[], q: number) =>
  weightedQuantile(
    values,
    values.map(() => 1),
    q,
  );

export const median = (values: readonly number[]) => quantile(values, 0.5);

/** How much n samples outweigh the prior: n / (n + SHRINK_N). */
export const SHRINK_N = 5;
export const shrinkWeight = (n: number) => (n > 0 ? n / (n + SHRINK_N) : 0);

/**
 * A median ratio pulled toward 1 by its sample size (in log space), clamped
 * to [1/8, 8]: one wild task cannot swing the next estimate far.
 */
export function shrunkRatio(ratios: readonly number[]): number {
  const ok = ratios.filter((r) => r > 0 && Number.isFinite(r));
  if (!ok.length) return 1;
  const r = Math.exp(shrinkWeight(ok.length) * Math.log(median(ok)));
  return Math.min(8, Math.max(1 / 8, r));
}

/** A lane's guessing bias from the history: median actual / its own estimate, shrunk. */
export function laneBias(samples: readonly Sample[], lane: string): { factor: number; n: number } {
  const ratios = samples
    .filter((s) => s.agent === lane && s.estimateMs)
    .map((s) => s.actualMs / s.estimateMs!);
  return { factor: shrunkRatio(ratios), n: ratios.length };
}

/** One record of the local calibration log (~/.config/lianki/estimates.jsonl). */
export type LogEstimate = {
  type: "estimate";
  id: string;
  at: number;
  lane: string;
  kind: EstimateKind;
  tags?: string[];
  task: string;
  node?: string;
  p5: number;
  p50: number;
  p95: number;
  n: number;
};
export type LogClose = {
  type: "close";
  id: string;
  at: number;
  actualMs: number;
  source: "manual" | "history";
};
export type LogRecord = LogEstimate | LogClose;

/** An estimate with its actual, once closed. */
export type Closed = LogEstimate & { actualMs: number };

/** The log → closed estimates (the last close of each id wins) and the open ones. */
export function foldLog(records: Iterable<LogRecord>): { closed: Closed[]; open: LogEstimate[] } {
  const est = new Map<string, LogEstimate>();
  const act = new Map<string, number>();
  for (const r of records)
    if (r.type === "estimate") est.set(r.id, r);
    else if (r.type === "close" && r.actualMs > 0) act.set(r.id, r.actualMs);
  const closed: Closed[] = [];
  const open: LogEstimate[] = [];
  for (const [id, e] of est) {
    const a = act.get(id);
    if (a === undefined) open.push(e);
    else closed.push({ ...e, actualMs: a });
  }
  return { closed, open };
}

/**
 * The calibration the log teaches, for one kind and lane:
 * - prior: the kind's default median moved toward the logged actuals of that
 *   kind (geometric, shrunk by sample size);
 * - factor: median actual / estimated P50 of this lane's closed estimates of
 *   this kind (all kinds when this one has none), shrunk toward 1;
 * - width: how much to widen (or narrow) the P5–P95 band so that about 90%
 *   of past actuals would have fallen inside it, shrunk toward 1, in [0.5, 4].
 */
export function calibration(
  closed: readonly Closed[],
  kind: EstimateKind,
  lane: string,
  base: Prior = DEFAULT_PRIORS[kind],
): { prior: Prior; factor: number; width: number; n: number } {
  const ofKind = closed.filter((c) => c.kind === kind);
  const prior: Prior = ofKind.length
    ? {
        p50: Math.exp(
          (1 - shrinkWeight(ofKind.length)) * Math.log(base.p50) +
            shrinkWeight(ofKind.length) * Math.log(median(ofKind.map((c) => c.actualMs))),
        ),
        sigma: base.sigma,
      }
    : base;
  const mine = closed.filter((c) => c.lane === lane);
  const pool = mine.some((c) => c.kind === kind) ? mine.filter((c) => c.kind === kind) : mine;
  const factor = shrunkRatio(pool.map((c) => c.actualMs / c.p50));
  // z: how many half-bands away each actual landed (1 = exactly at P5 or P95).
  const zs = closed.map((c) => {
    const d = Math.log(c.actualMs / c.p50);
    const half = Math.log(d >= 0 ? c.p95 / c.p50 : c.p50 / c.p5) || 1e-9;
    return Math.abs(d) / half;
  });
  const need = zs.length ? quantile(zs, 0.9) : 1;
  const w = shrinkWeight(zs.length);
  const width = Math.min(4, Math.max(0.5, Math.exp(w * Math.log(Math.max(need, 1e-3)))));
  return { prior, factor, width, n: pool.length };
}

/** What `estimate` is asked. */
export type EstimateQuery = {
  task: string;
  kind?: EstimateKind;
  tags?: string[];
  lane?: string;
  /** The lane's own guess (ms), scaled by its bias and folded in as one sample. */
  guessMs?: number;
};

export type Similar = { title: string; id: string; actualMs: number; weight: number };

export type Estimate = {
  kind: EstimateKind;
  p5: number;
  p50: number;
  p95: number;
  /** Similar done tasks used. */
  n: number;
  /** Their summed similarity weights (the effective sample size). */
  effN: number;
  /** How much the kind's prior still counts (0..1). */
  priorWeight: number;
  bias: { factor: number; n: number };
  calibration: { factor: number; width: number; n: number };
  similar: Similar[];
};

/** The most similar tasks considered. */
export const SIMILAR_MAX = 40;
/** Added to the likeness of a task the same lane did. */
export const LANE_BONUS = 0.5;

/** How alike a done task is to the query: same kind 1, plus up to 2 for shared words. */
export function similarity(q: { kind: EstimateKind; words: Set<string> }, s: Sample): number {
  const kindW = s.kind === q.kind ? 1 : 0;
  if (!q.words.size) return kindW;
  const sw = keywords(`${s.title} ${s.id.replace(/[/._-]+/g, " ")}`);
  let shared = 0;
  for (const w of q.words) if (sw.has(w)) shared++;
  return kindW + (2 * shared) / q.words.size;
}

/**
 * The estimate: the weighted P5/P50/P95 of similar tasks' actuals, blended in
 * log space with the kind's (log-calibrated) prior — the prior counts
 * SHRINK_N / (effN + SHRINK_N) — then multiplied by the log's calibration
 * factor and the band widened by its width factor. The lane's history bias
 * scales the prior and the guess only: those are guesses, the samples are not.
 */
export function estimate(
  q: EstimateQuery,
  samples: readonly Sample[],
  log: readonly LogRecord[] = [],
): Estimate {
  const kind = q.kind ?? classifyKind(q.task);
  const lane = q.lane ?? "";
  const words = keywords(`${q.task} ${(q.tags ?? []).join(" ")}`);
  const scored = samples
    .map((s) => {
      const w = similarity({ kind, words }, s);
      // The same lane's own tasks count a little more: lanes work at different speeds.
      return { s, w: w > 0 && lane && s.agent === lane ? w + LANE_BONUS : w };
    })
    .filter((x) => x.w >= 0.5)
    .sort((a, b) => b.w - a.w || b.s.endedAt - a.s.endedAt)
    .slice(0, SIMILAR_MAX);
  const bias = laneBias(samples, lane);
  const values = scored.map((x) => Math.log(x.s.actualMs));
  const weights = scored.map((x) => x.w);
  if (q.guessMs && q.guessMs > 0) {
    values.push(Math.log(q.guessMs * bias.factor));
    weights.push(1);
  }
  const effN = weights.reduce((s, w) => s + w, 0);
  const { closed } = foldLog(log);
  const cal = calibration(closed, kind, lane);
  const pMu = Math.log(cal.prior.p50 * bias.factor);
  const pHalf = Z95 * cal.prior.sigma;
  const pw = 1 - shrinkWeight(effN);
  const at = (qq: number, prior: number) =>
    values.length ? pw * prior + (1 - pw) * weightedQuantile(values, weights, qq) : prior;
  let lo = at(0.05, pMu - pHalf);
  const mid = at(0.5, pMu);
  let hi = at(0.95, pMu + pHalf);
  // The band never collapses: at least ×1.5 each side before calibration.
  lo = Math.min(lo, mid - Math.log(1.5));
  hi = Math.max(hi, mid + Math.log(1.5));
  const c = Math.log(cal.factor);
  const round = (x: number) => Math.max(MIN, Math.round(Math.exp(x) / MIN) * MIN);
  return {
    kind,
    p5: round(mid + c - (mid - lo) * cal.width),
    p50: round(mid + c),
    p95: round(mid + c + (hi - mid) * cal.width),
    n: scored.length,
    effN: Math.round(effN * 10) / 10,
    priorWeight: Math.round(pw * 100) / 100,
    bias,
    calibration: { factor: cal.factor, width: cal.width, n: cal.n },
    similar: scored.slice(0, 5).map((x) => ({
      title: x.s.title,
      id: x.s.id,
      actualMs: x.s.actualMs,
      weight: Math.round(x.w * 100) / 100,
    })),
  };
}

/** Calibration report per kind: coverage (actuals inside P5–P95) and the median actual/P50. */
export type KindStats = {
  kind: EstimateKind | "all";
  closed: number;
  open: number;
  coverage?: number;
  medianRatio?: number;
};

export function calibrationStats(records: readonly LogRecord[], lane?: string): KindStats[] {
  const { closed, open } = foldLog(records);
  const c = lane ? closed.filter((x) => x.lane === lane) : closed;
  const o = lane ? open.filter((x) => x.lane === lane) : open;
  const row = (kind: KindStats["kind"], cs: Closed[], os: LogEstimate[]): KindStats => {
    const out: KindStats = { kind, closed: cs.length, open: os.length };
    if (cs.length) {
      out.coverage = cs.filter((x) => x.actualMs >= x.p5 && x.actualMs <= x.p95).length / cs.length;
      out.medianRatio = median(cs.map((x) => x.actualMs / x.p50));
    }
    return out;
  };
  const kinds = ESTIMATE_KINDS.filter(
    (k) => c.some((x) => x.kind === k) || o.some((x) => x.kind === k),
  );
  return [
    ...kinds.map((k) =>
      row(
        k,
        c.filter((x) => x.kind === k),
        o.filter((x) => x.kind === k),
      ),
    ),
    row("all", c, o),
  ];
}

/**
 * Open log estimates whose node has since gone done in the history → close
 * records (actual from the history), for `estimate sync`. A node done before
 * the estimate was made is not this estimate's task.
 */
export function closesFromHistory(
  open: readonly LogEstimate[],
  history: readonly HistoryLike[],
  now: number,
): LogClose[] {
  const byId = new Map<string, HistoryLike>();
  for (const h of history) byId.set(h.id, h);
  const out: LogClose[] = [];
  for (const e of open) {
    const h = e.node ? byId.get(e.node) : undefined;
    if (!h || h.endedAt < e.at) continue;
    const actualMs = h.endedAt - Math.max(e.at, h.startedAt ?? h.created);
    if (actualMs > 0) out.push({ type: "close", id: e.id, at: now, actualMs, source: "history" });
  }
  return out;
}

/** For a finished Gantt bar: its estimate vs actual (ratio > 1 = it ran over). */
export function estimateVsActual(
  r: Pick<HistoryLike, "created" | "startedAt" | "endedAt" | "estimateMs">,
): { estimateMs?: number; actualMs: number; ratio?: number } {
  const actualMs = Math.max(0, r.endedAt - (r.startedAt ?? r.created));
  return r.estimateMs && r.estimateMs > 0
    ? { estimateMs: r.estimateMs, actualMs, ratio: actualMs / r.estimateMs }
    : { actualMs };
}

/** "45s", "12m", "1h30m", "2d4h": the --eta grammar (lib/progress.ts parseEta) reads it back. */
export function formatDuration(ms: number): string {
  const m = Math.max(1, Math.round(ms / MIN));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d${h % 24}h` : `${d}d`;
}

/** The --eta range of an estimate: "P5-P95". */
export const etaRange = (e: Pick<Estimate, "p5" | "p95">) =>
  `${formatDuration(e.p5)}-${formatDuration(e.p95)}`;

/** A short random id for a log record. */
export const newEstimateId = (now: number, rand = Math.random) =>
  `e-${now.toString(36)}-${Math.floor(rand() * 36 ** 4)
    .toString(36)
    .padStart(4, "0")}`;
