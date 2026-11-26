/**
 * The estimate skill's maths (lib/estimate; docs/state-tree.md, "Estimates"):
 * quantiles, the lane bias, the priors when the history is thin, and the
 * calibration the local log teaches.
 */
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PRIORS,
  type Closed,
  type LogEstimate,
  type LogRecord,
  type Sample,
  SHRINK_N,
  calibration,
  calibrationStats,
  classifyKind,
  closesFromHistory,
  estimate,
  estimateVsActual,
  etaRange,
  foldLog,
  formatDuration,
  keywords,
  laneBias,
  median,
  quantile,
  samplesFromHistory,
  shrinkWeight,
  shrunkRatio,
  weightedQuantile,
} from "@/lib/estimate";
import { parseEta } from "@/lib/progress";
import { findAutoEta, parseProgressArgs, replaceAutoEta } from "@/scripts/dev/progress-args";

const M = 60_000;
const sample = (over: Partial<Sample> = {}): Sample => ({
  title: "Gantt label: fix the overlap",
  id: "/dev/gantt/label",
  agent: "claude",
  kind: "ui-fix",
  actualMs: 20 * M,
  endedAt: 1,
  ...over,
});

describe("quantiles", () => {
  test("plain quantiles interpolate between points", () => {
    expect(median([1, 2, 3])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(quantile([10], 0.95)).toBe(10);
    expect(quantile([1, 2, 3, 4, 5], 0)).toBe(1);
    expect(quantile([1, 2, 3, 4, 5], 1)).toBe(5);
    expect(Number.isNaN(quantile([], 0.5))).toBe(true);
  });
  test("weights pull the quantile toward the heavy point", () => {
    expect(weightedQuantile([1, 10], [1, 1], 0.5)).toBe(5.5);
    expect(weightedQuantile([1, 10], [3, 1], 0.5)).toBeLessThan(5.5);
    expect(weightedQuantile([1, 10], [0, 1], 0.5)).toBe(10);
  });
});

describe("bias factor", () => {
  test("shrinkWeight grows with n toward 1", () => {
    expect(shrinkWeight(0)).toBe(0);
    expect(shrinkWeight(SHRINK_N)).toBe(0.5);
    expect(shrinkWeight(95)).toBeCloseTo(0.95);
  });
  test("a median ratio is pulled toward 1 by a small sample, clamped", () => {
    expect(shrunkRatio([])).toBe(1);
    expect(shrunkRatio([2])).toBeCloseTo(2 ** (1 / 6));
    expect(shrunkRatio(Array(95).fill(2))).toBeCloseTo(2 ** 0.95);
    expect(shrunkRatio(Array(1000).fill(100))).toBe(8);
  });
  test("laneBias reads this lane's actual / estimate only", () => {
    const s = [
      ...Array(5).fill(sample({ agent: "codex", actualMs: 40 * M, estimateMs: 20 * M })),
      sample({ agent: "main", actualMs: 10 * M, estimateMs: 40 * M }),
      sample({ agent: "codex", actualMs: 10 * M }),
    ];
    const b = laneBias(s, "codex");
    expect(b.n).toBe(5);
    expect(b.factor).toBeCloseTo(Math.SQRT2);
    expect(laneBias(s, "nobody")).toEqual({ factor: 1, n: 0 });
  });
});

describe("history → samples", () => {
  test("actual from the start (else creation); junk durations dropped; kind guessed", () => {
    const got = samplesFromHistory([
      {
        id: "/a",
        title: "Deploy: ship it",
        agent: "x",
        created: 0,
        startedAt: 10 * M,
        endedAt: 30 * M,
      },
      { id: "/b", title: "Review PR", agent: "x", created: 0, endedAt: 15 * M, estimateMs: 5 * M },
      { id: "/c", title: "back-dated", agent: "x", created: 100 * M, endedAt: 0 },
      { id: "/d", title: "seconds", agent: "x", created: 0, endedAt: 1000 },
      { id: "/e", title: "forgotten", agent: "x", created: 0, endedAt: 30 * 24 * 60 * M },
    ]);
    expect(got.map((s) => [s.id, s.actualMs, s.kind])).toEqual([
      ["/a", 20 * M, "deploy"],
      ["/b", 15 * M, "review"],
    ]);
    expect(got[1]!.estimateMs).toBe(5 * M);
  });
  test("classifyKind", () => {
    expect(classifyKind("Review PR #1086")).toBe("review");
    expect(classifyKind("Gantt bar: the label overlaps")).toBe("ui-fix");
    expect(classifyKind("Why the hub drops lines")).toBe("investigation");
    expect(classifyKind("something", "/words/swipe")).toBe("other");
    expect(classifyKind("x", "/docs/blog/estimates")).toBe("docs");
  });
});

describe("estimate", () => {
  test("no history: the kind's prior, as a log-normal band, prior weight 1", () => {
    const e = estimate({ task: "x", kind: "backend-feature" }, []);
    const p = DEFAULT_PRIORS["backend-feature"];
    expect(e.p50).toBe(p.p50);
    expect(e.priorWeight).toBe(1);
    expect(e.n).toBe(0);
    expect(e.p5 / M).toBeCloseTo(Math.round((p.p50 * Math.exp(-1.6448536 * p.sigma)) / M));
    expect(e.p95 / M).toBeCloseTo(Math.round((p.p50 * Math.exp(1.6448536 * p.sigma)) / M));
  });
  test("plenty of similar tasks: their distribution dominates", () => {
    const s = Array.from({ length: 200 }, (_, i) => sample({ actualMs: (5 + (i % 10)) * M }));
    const e = estimate({ task: "Gantt label overlap", kind: "ui-fix" }, s);
    expect(e.n).toBe(40);
    expect(e.priorWeight).toBeLessThan(0.1);
    expect(e.p50).toBeGreaterThanOrEqual(8 * M);
    expect(e.p50).toBeLessThanOrEqual(12 * M);
    expect(e.p5).toBeLessThan(e.p50);
    expect(e.p95).toBeGreaterThan(e.p50);
  });
  test("thin history: halfway to the prior at n = SHRINK_N", () => {
    const s = Array(SHRINK_N).fill(sample({ actualMs: 300 * M }));
    // weights 3 each (kind + all words shared): effN 15 → prior weight 0.25
    const e = estimate({ task: "Gantt label overlap", kind: "ui-fix" }, s);
    expect(e.effN).toBe(15);
    expect(e.priorWeight).toBe(0.25);
    const expected = Math.exp(
      0.25 * Math.log(DEFAULT_PRIORS["ui-fix"].p50) + 0.75 * Math.log(300 * M),
    );
    expect(Math.abs(e.p50 - expected)).toBeLessThan(M);
  });
  test("keywords: words of 3+ letters, CJK as character pairs", () => {
    expect([...keywords("Fix the Gantt bar")]).toEqual(["gantt", "bar"]);
    expect([...keywords("甘特图 a 修")]).toEqual(["甘特", "特图", "修"]);
  });
  test("the same lane's tasks weigh more", () => {
    const s = [sample({ agent: "codex" })];
    const mine = estimate({ task: "Gantt label", kind: "ui-fix", lane: "codex" }, s);
    const other = estimate({ task: "Gantt label", kind: "ui-fix", lane: "main" }, s);
    expect(mine.effN - other.effN).toBeCloseTo(0.5);
  });
  test("unrelated tasks are not used", () => {
    const s = [sample({ kind: "deploy", title: "Release prod", id: "/release" })];
    expect(estimate({ task: "Gantt label", kind: "ui-fix" }, s).n).toBe(0);
  });
  test("the lane's bias scales the prior and the guess, not the samples", () => {
    const biased = Array(95).fill(
      sample({
        agent: "codex",
        kind: "deploy",
        title: "zz",
        id: "/zz",
        actualMs: 60 * M,
        estimateMs: 30 * M,
      }),
    );
    const e = estimate({ task: "nothing alike", kind: "review", lane: "codex" }, biased);
    expect(e.n).toBe(0);
    expect(e.p50 / DEFAULT_PRIORS.review.p50).toBeCloseTo(2 ** 0.95, 1);
  });
  test("the output reads back as an --eta range", () => {
    const e = estimate({ task: "x", kind: "review" }, []);
    const r = parseEta(etaRange(e));
    expect(r).toEqual({ in: e.p95, min: e.p5 });
  });
});

describe("calibration from the log", () => {
  const est = (id: string, kind: Closed["kind"], p50: number, lane = "claude"): LogEstimate => ({
    type: "estimate",
    id,
    at: 0,
    lane,
    kind,
    task: id,
    p5: p50 / 3,
    p50,
    p95: p50 * 3,
    n: 0,
  });
  const close = (id: string, actualMs: number): LogRecord => ({
    type: "close",
    id,
    at: 1,
    actualMs,
    source: "manual",
  });

  test("foldLog pairs estimates with their last close", () => {
    const { closed, open } = foldLog([
      est("a", "docs", 10 * M),
      est("b", "docs", 10 * M),
      close("a", 5 * M),
      close("a", 7 * M),
    ]);
    expect(closed.map((c) => [c.id, c.actualMs])).toEqual([["a", 7 * M]]);
    expect(open.map((o) => o.id)).toEqual(["b"]);
  });

  test("tasks that keep running 2× long: the factor and the kind's prior move up", () => {
    const log: LogRecord[] = [];
    for (let i = 0; i < 20; i++) log.push(est(`e${i}`, "docs", 10 * M), close(`e${i}`, 20 * M));
    const { closed } = foldLog(log);
    const c = calibration(closed, "docs", "claude");
    expect(c.factor).toBeCloseTo(2 ** shrinkWeight(20));
    expect(c.prior.p50).toBeGreaterThan(DEFAULT_PRIORS.docs.p50);
    // and the next estimate follows
    const before = estimate({ task: "x", kind: "docs", lane: "claude" }, []);
    const after = estimate({ task: "x", kind: "docs", lane: "claude" }, [], log);
    expect(after.p50).toBeGreaterThan(before.p50 * 1.5);
  });

  test("actuals far outside the band widen it; all dead-centre narrows it", () => {
    const wide: LogRecord[] = [];
    const tight: LogRecord[] = [];
    for (let i = 0; i < 30; i++) {
      wide.push(est(`w${i}`, "test", 10 * M), close(`w${i}`, (i % 2 ? 90 : 1.1) * M));
      tight.push(est(`t${i}`, "test", 10 * M), close(`t${i}`, 10 * M));
    }
    expect(calibration(foldLog(wide).closed, "test", "claude").width).toBeGreaterThan(1.5);
    expect(calibration(foldLog(tight).closed, "test", "claude").width).toBe(0.5);
  });

  test("another lane's closes do not move this lane's factor", () => {
    const log: LogRecord[] = [];
    for (let i = 0; i < 20; i++)
      log.push(est(`e${i}`, "docs", 10 * M, "codex"), close(`e${i}`, 40 * M));
    expect(calibration(foldLog(log).closed, "docs", "claude").factor).toBe(1);
  });

  test("stats: coverage and the median ratio per kind", () => {
    const log = [
      est("a", "docs", 10 * M),
      close("a", 12 * M), // inside
      est("b", "docs", 10 * M),
      close("b", 60 * M), // outside
      est("c", "review", 10 * M),
    ];
    const rows = calibrationStats(log);
    const docs = rows.find((r) => r.kind === "docs")!;
    expect(docs).toMatchObject({ kind: "docs", closed: 2, open: 0, coverage: 0.5 });
    expect(docs.medianRatio).toBeCloseTo(3.6);
    expect(rows.find((r) => r.kind === "review")).toEqual({ kind: "review", closed: 0, open: 1 });
    expect(rows.at(-1)!.kind).toBe("all");
  });

  test("closesFromHistory: an open estimate's node done after it was made", () => {
    const open = foldLog([
      { ...est("a", "docs", 10 * M), at: 100 * M, node: "/x" },
      { ...est("b", "docs", 10 * M), at: 100 * M, node: "/old" },
      { ...est("c", "docs", 10 * M), at: 100 * M },
    ]).open;
    const got = closesFromHistory(
      open,
      [
        { id: "/x", title: "x", agent: "a", created: 0, startedAt: 90 * M, endedAt: 130 * M },
        { id: "/old", title: "o", agent: "a", created: 0, endedAt: 50 * M },
      ],
      999,
    );
    expect(got).toEqual([{ type: "close", id: "a", at: 999, actualMs: 30 * M, source: "history" }]);
  });
});

describe("helpers", () => {
  test("formatDuration is --eta grammar", () => {
    expect(formatDuration(30_000)).toBe("1m");
    expect(formatDuration(45 * M)).toBe("45m");
    expect(formatDuration(90 * M)).toBe("1h30m");
    expect(formatDuration(120 * M)).toBe("2h");
    expect(formatDuration(26 * 60 * M)).toBe("1d2h");
    expect(formatDuration(24 * 60 * M)).toBe("1d");
    expect(formatDuration((24 * 60 + 59) * M)).toBe("1d59m");
    expect(formatDuration((49 * 60 + 1) * M)).toBe("2d1h1m");
    for (const min of [1, 59, 60, 61, 1439, 1440, 1441, 1499, 2941, 10_079])
      expect(parseEta(formatDuration(min * M))).toEqual({ in: min * M });
    for (const ms of [M, 45 * M, 90 * M, 26 * 60 * M])
      expect(parseEta(formatDuration(ms))).toEqual({ in: ms });
  });
  test("estimateVsActual for a finished Gantt bar", () => {
    expect(estimateVsActual({ created: 0, startedAt: 10, endedAt: 70, estimateMs: 30 })).toEqual({
      estimateMs: 30,
      actualMs: 60,
      ratio: 2,
    });
    expect(estimateVsActual({ created: 0, endedAt: 5 })).toEqual({ actualMs: 5 });
  });
  test("findAutoEta / replaceAutoEta", () => {
    const argv = [
      "--agent",
      "a",
      "--path",
      "/x",
      "--task",
      "X: y",
      "--status",
      "doing",
      "--eta",
      "auto:ui-fix",
    ];
    const at = findAutoEta(argv)!;
    expect(at).toEqual({ index: 9, kind: "ui-fix" });
    const out = replaceAutoEta(argv, at, "10m-1h");
    expect(out.at(-1)).toBe("10m-1h");
    const cmd = parseProgressArgs(out);
    expect(cmd instanceof Error ? cmd.message : cmd.cmd).toBe("report");
    expect(findAutoEta(["--eta=auto"])).toEqual({ index: 0 });
    expect(replaceAutoEta(["--eta=auto"], { index: 0 }, "5m")).toEqual(["--eta=5m"]);
    expect(findAutoEta(["--eta", "20m"])).toBeNull();
    expect(findAutoEta(["--task", "auto"])).toBeNull();
  });
});
