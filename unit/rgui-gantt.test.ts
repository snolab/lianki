/**
 * rgui's gantt module (packages/rgui/src/gantt, docs/rgui.md): the parts the
 * Lianki gantt-view tests do not reach through their re-exports — the LOD
 * layout (cluster pseudo-rows), the windowed slice, the inverse scale, and
 * the unit lengths taken from rgui's temporal folds.
 */
import { describe, expect, it } from "bun:test";
import { FOLD_PERIOD_MS } from "../packages/rgui/src/lane/temporal";
import {
  DAY,
  HOUR,
  MIN,
  READABLE_BAR_PX,
  WEEK,
  ganttBar,
  initialAxis,
  initialLogAxis,
  layoutGantt,
  scaleTimeAt,
  scaleX,
  windowRows,
  type GanttTask,
} from "@snomiao/rgui/gantt";

const NOW = Date.parse("2026-11-09T08:00:00Z");
const W = 1200;

type Row = GanttTask & { name: string };
const row = (name: string, start: number, at: number, extra: Partial<Row> = {}): Row => ({
  name,
  start,
  at,
  ...extra,
});
const name = (t: Row) => t.name;

describe("units are rgui's temporal fold periods", () => {
  it("hour, day and week match the lane's; a minute is a sixtieth of an hour", () => {
    expect(HOUR).toBe(FOLD_PERIOD_MS.hour!);
    expect(DAY).toBe(FOLD_PERIOD_MS.day!);
    expect(WEEK).toBe(FOLD_PERIOD_MS.week!);
    expect(MIN).toBe(60_000);
  });
});

describe("scaleTimeAt inverts scaleX on both axes", () => {
  it("linear and log", () => {
    const lin = initialAxis(NOW - HOUR, NOW + 3 * HOUR, NOW, W).axis;
    const log = initialLogAxis(NOW - HOUR, NOW + 3 * HOUR, NOW, W).axis;
    for (const a of [lin, log])
      for (const dt of [-DAY, -5 * MIN, 0, 30 * MIN, 2 * DAY]) {
        const t = NOW + dt;
        expect(scaleTimeAt(a, scaleX(a, t, NOW), NOW)).toBeCloseTo(t, -1);
      }
  });
});

describe("layoutGantt: LOD folds unreadable rows into cluster pseudo-rows", () => {
  // On the log axis, done tasks weeks ago are slivers: far out an e-fold is L px.
  const { axis } = initialLogAxis(NOW - HOUR, NOW + 2 * HOUR, NOW, W);
  const old = (n: string, daysAgo: number) =>
    row(n, NOW - daysAgo * DAY - 10 * MIN, NOW - daysAgo * DAY, {
      done: true,
      doneAt: NOW - daysAgo * DAY,
    });

  it("readable rows stay rows, with the bar ganttBar draws", () => {
    const rows = [row("open", NOW - 30 * MIN, NOW + HOUR, { pct: 40 })];
    const out = layoutGantt(rows, axis, NOW, { name });
    expect(out).toEqual([
      { kind: "row", index: 0, task: rows[0]!, bar: ganttBar(rows[0]!, axis, NOW) },
    ]);
  });

  it("a run of thin far-away done rows becomes one cluster: union bar, count, first name…", () => {
    const rows = [
      row("open", NOW - 30 * MIN, NOW + HOUR),
      old("a", 30),
      old("b", 31),
      old("c", 32),
    ];
    for (const r of rows.slice(1)) {
      const b = ganttBar(r, axis, NOW);
      expect(b.w + b.over).toBeLessThan(READABLE_BAR_PX);
    }
    const out = layoutGantt(rows, axis, NOW, { name });
    expect(out.map((o) => o.kind)).toEqual(["row", "cluster"]);
    const c = out[1]!;
    if (c.kind !== "cluster") throw new Error("expected a cluster");
    expect(c).toMatchObject({ from: 1, to: 4, count: 3, done: 3, label: "a…" });
    expect(c.tasks.map(name)).toEqual(["a", "b", "c"]);
    const xs = rows.slice(1).map((r) => ganttBar(r, axis, NOW));
    expect(c.x).toBe(Math.min(...xs.map((b) => b.x)));
    expect(c.x + c.w).toBe(Math.max(...xs.map((b) => b.x + b.w + b.over)));
  });

  it("a lone thin row stays itself (minRun 2); open rows never fold (keep)", () => {
    const thinOpen = row("soon", NOW + 30 * DAY, NOW + 30 * DAY + MIN);
    const rows = [old("a", 30), thinOpen, old("b", 31)];
    const out = layoutGantt(rows, axis, NOW, { name });
    expect(out.map((o) => o.kind)).toEqual(["row", "row", "row"]);
  });

  it("thin rows far apart on screen do not merge (cluster gap); either side", () => {
    const rows = [old("a", 2), old("b", 300), old("c", 2)];
    const out = layoutGantt(rows, axis, NOW, { name, minBarPx: 1e9 });
    expect(out.map((o) => o.kind)).toEqual(["row", "row", "row"]);
    const back = [old("x", 300), old("y", 2)];
    expect(layoutGantt(back, axis, NOW, { name, minBarPx: 1e9 }).map((o) => o.kind)).toEqual([
      "row",
      "row",
    ]);
  });

  it("options: keep, minRun, rule.clusterGapPx, and no name gives an empty label", () => {
    const rows = [old("a", 2), old("b", 300)];
    const wide = layoutGantt(rows, axis, NOW, { minBarPx: 1e9, rule: { clusterGapPx: 1e9 } });
    expect(wide).toHaveLength(1);
    expect(wide[0]).toMatchObject({ kind: "cluster", label: "…", count: 2 });
    const kept = layoutGantt(rows, axis, NOW, {
      minBarPx: 1e9,
      rule: { clusterGapPx: 1e9 },
      keep: () => true,
    });
    expect(kept.map((o) => o.kind)).toEqual(["row", "row"]);
    const three = layoutGantt(rows, axis, NOW, {
      minBarPx: 1e9,
      rule: { clusterGapPx: 1e9 },
      minRun: 3,
    });
    expect(three.map((o) => o.kind)).toEqual(["row", "row"]);
  });

  it("an empty list lays out nothing", () => {
    expect(layoutGantt([], axis, NOW)).toEqual([]);
  });
});

describe("windowRows: only the rows near the view", () => {
  it("the view's rows and the overscan, clamped to the list", () => {
    expect(windowRows(1000, 30, 3000, 600)).toEqual({ start: 96, end: 124 });
    expect(windowRows(1000, 30, 0, 600, 0)).toEqual({ start: 0, end: 20 });
    expect(windowRows(10, 30, 0, 600)).toEqual({ start: 0, end: 10 });
    expect(windowRows(10, 30, -50, -1)).toEqual({ start: 0, end: 4 });
  });

  it("nothing for an empty list or a non-positive row height", () => {
    expect(windowRows(0, 30, 0, 600)).toEqual({ start: 0, end: 0 });
    expect(windowRows(5, 0, 0, 600)).toEqual({ start: 0, end: 0 });
    expect(windowRows(5, Number.NaN, 0, 600)).toEqual({ start: 0, end: 0 });
  });
});
