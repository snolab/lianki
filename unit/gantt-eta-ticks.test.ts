/**
 * The Gantt's ETA history (docs/dev-debug-widget.md, "ETA ticks"): a range's
 * solid bar and fading tail, the ghost bar of the original plan, the ticks
 * and their groups, and the "12–63M" labels.
 */
import { describe, expect, it } from "bun:test";
import {
  type Axis,
  GANTT_COLORS,
  TAIL_CSS,
  ganttBar,
  ganttSpan,
  ganttTickX,
  ghostShows,
  oklchToSrgb,
  over,
  parseOklch,
  srgbLuminance,
  tickGroup,
  tickGroupText,
  xOf,
} from "@lianki/debug-chat/gantt-view";
import { etaLabel, etaParts, rangeTime } from "@lianki/debug-chat/eta";
import { overlayProgress } from "@/lib/progress-tree";
import type { ProgressEntry } from "@/lib/progress";

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = 1_800_000_000_000;
const W = 400;

describe("a range's bar: solid to the P5, a tail to the P95", () => {
  const a: Axis = { lo: NOW - 2 * HOUR, hi: NOW + 2 * HOUR, pxPerMs: W / HOUR };
  it("solid is the P5's px from the start; one number is all solid", () => {
    const b = ganttBar({ start: NOW, at: NOW + HOUR, min: NOW + 15 * MIN }, a, NOW);
    expect(b.w).toBeCloseTo(W);
    expect(b.solid).toBeCloseTo(W / 4);
    expect(ganttBar({ start: NOW, at: NOW + HOUR }, a, NOW).solid).toBeCloseTo(W);
    // A P5 before the start (it was given before the work began) is no solid part.
    expect(ganttBar({ start: NOW, at: NOW + HOUR, min: NOW - HOUR }, a, NOW).solid).toBe(0);
    // A P5 at or past the P95 is no range.
    expect(ganttBar({ start: NOW, at: NOW + HOUR, min: NOW + HOUR }, a, NOW).solid).toBeCloseTo(W);
  });
  it("overdue counts from the P95: no overrun between the P5 and the P95", () => {
    const b = ganttBar({ start: NOW - HOUR, at: NOW + 30 * MIN, min: NOW - 30 * MIN }, a, NOW);
    expect(b.over).toBe(0);
    const late = ganttBar({ start: NOW - HOUR, at: NOW - 30 * MIN, min: NOW - 45 * MIN }, a, NOW);
    expect(late.over).toBeCloseTo(W / 2);
  });
  it("the tail fades by a gradient; hatched under reduced motion", () => {
    expect(TAIL_CSS).toContain("linear-gradient(90deg");
    expect(TAIL_CSS).toMatch(/prefers-reduced-motion: reduce\)\{[^}]*repeating-linear-gradient/);
  });
});

describe("the ghost bar and the ticks", () => {
  const a: Axis = { lo: NOW - 2 * HOUR, hi: NOW + 2 * HOUR, pxPerMs: W / HOUR };
  it("the ghost is the plan's span, drawn only when the bar moved", () => {
    const g = ganttSpan(NOW - HOUR, NOW, a, NOW);
    expect(g).toEqual({ x: xOf(a, NOW - HOUR), w: W });
    expect(ganttSpan(NOW, NOW - HOUR, a, NOW)).toEqual(g); // either order
    expect(ghostShows(g, { x: g.x, w: g.w })).toBe(false);
    expect(ghostShows(g, { x: g.x, w: g.w + 1 })).toBe(false);
    expect(ghostShows(g, { x: g.x, w: g.w + 40 })).toBe(true);
    // Clamped to the content.
    expect(ganttSpan(NOW - 10 * HOUR, NOW, a, NOW).x).toBe(0);
  });
  it("a tick sits at its time; outside the content it is not drawn", () => {
    expect(ganttTickX(NOW, a, NOW)).toBeCloseTo(xOf(a, NOW));
    expect(ganttTickX(NOW - 3 * HOUR, a, NOW)).toBeNull();
    // Same time, same x on every row: one action's ticks line up.
    expect(ganttTickX(NOW - 5 * MIN, a, NOW)).toBe(ganttTickX(NOW - 5 * MIN, a, NOW));
  });
});

describe("a tick's group", () => {
  const rows = [
    {
      title: "A",
      ticks: [{ at: 5, kind: "change", changeId: "c1", by: "x", old: 100 * MIN, new: 50 * MIN }],
    },
    {
      title: "B",
      ticks: [{ at: 5, kind: "change", changeId: "c1", by: "x", old: 100 * MIN, new: 200 * MIN }],
    },
    {
      title: "C",
      ticks: [
        { at: 1, kind: "change", changeId: "c0", by: "y", new: 80 * MIN },
        { at: 5, kind: "change", changeId: "c1", by: "x", old: 80 * MIN, new: 90 * MIN },
        { at: 5, kind: "status", changeId: "c1", by: "x", status: "review" },
      ],
    },
    { title: "D", ticks: [{ at: 5, kind: "confirm", changeId: "c1", by: "y", new: 300 }] },
    { title: "E", ticks: [{ at: 5, kind: "status", changeId: "c1", by: "x", status: "done" }] },
    { title: "F" },
  ] as const;
  const s = {
    earlier: "moved up: {names}",
    later: "postponed: {names}",
    confirmed: "confirmed: {names}",
    set: "estimated: {names}",
    status: "status changed: {names}",
  };
  it("sorts each row by its old → new estimate", () => {
    const g = tickGroup(rows as never, "c1")!;
    expect(g).toMatchObject({
      at: 5,
      by: ["x", "y"],
      earlier: ["A"],
      later: ["B", "C"],
      confirmed: ["D"],
      status: ["E"],
      set: [],
    });
    expect(tickGroupText(g, s)).toBe(
      "moved up: A; postponed: B, C; confirmed: D; status changed: E",
    );
    expect(tickGroupText(tickGroup(rows as never, "c0")!, s)).toBe("estimated: C");
    expect(tickGroup(rows as never, "nope")).toBeNull();
  });
});

describe("labels", () => {
  it("a range reads 12–63M, one unit shared", () => {
    expect(rangeTime(12 * MIN, 63 * MIN)).toBe("12–63M");
    expect(rangeTime(50 * MIN, 2 * HOUR)).toBe("50M–2H");
    expect(rangeTime(12 * MIN, 45 * MIN)).toBe("12–45M");
    expect(rangeTime(2 * HOUR, 5 * HOUR)).toBe("2–5H");
    expect(rangeTime(20 * MIN, 20 * MIN)).toBe("20M");
  });
  it("a range until its P5 passes, then the time to the P95", () => {
    const t = { at: NOW + 45 * MIN, min: NOW + 12 * MIN };
    expect(etaLabel(t, NOW)).toBe("12–45M");
    expect(etaLabel(t, NOW + 20 * MIN)).toBe("25M");
    expect(etaLabel(t, NOW + 50 * MIN)).toBe("-5M");
    expect(etaLabel({ at: NOW + 5 * MIN }, NOW)).toBe("5M");
    const parts = etaParts(
      [{ id: "/a", title: "A: a", start: NOW, at: NOW + 45 * MIN, min: NOW + 12 * MIN }],
      NOW,
    );
    expect(parts).toEqual([{ name: "A", min: "12–45M" }]);
  });
});

describe("the tree hands the Gantt the range, the plan and the ticks", () => {
  it("maps a node's etaMinAt, plan and etaEvents", () => {
    const e: ProgressEntry = {
      id: "/x/a",
      assignee: { type: "agent", name: "a" },
      task: "A: a",
      status: "doing",
      kind: "task",
      creator: "a",
      by: "a",
      rev: 2,
      created: NOW,
      at: NOW,
      startedAt: NOW,
      etaAt: NOW + HOUR,
      etaMinAt: NOW + 10 * MIN,
      etaConfirmedAt: NOW,
      plan: { start: NOW, etaAt: NOW + 30 * MIN },
      etaEvents: [
        {
          at: NOW,
          kind: "change",
          changeId: "c1",
          by: "a",
          oldEtaAt: NOW + 30 * MIN,
          newEtaAt: NOW + HOUR,
        },
      ],
    };
    const root = overlayProgress({ title: "", links: [], children: [] }, [e]);
    const find = (n: typeof root): typeof root | undefined =>
      n.eta?.id === "/x/a" ? n : n.children.map(find).find(Boolean);
    expect(find(root)?.eta).toMatchObject({
      min: NOW + 10 * MIN,
      plan: { start: NOW, at: NOW + 30 * MIN },
      confirmedAt: NOW,
      ticks: [
        { at: NOW, kind: "change", changeId: "c1", by: "a", old: NOW + 30 * MIN, new: NOW + HOUR },
      ],
    });
  });
});

describe("tick colours are oklch and AA over the bars", () => {
  const cr = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  for (const theme of ["light", "dark"] as const)
    it(theme, () => {
      const c = GANTT_COLORS[theme];
      const track = oklchToSrgb(parseOklch(c.track));
      const ghost = over(parseOklch(c.ghost), track);
      const bar = over(parseOklch(c.bar), ghost);
      for (const bg of [track, ghost, bar])
        expect(
          cr(srgbLuminance(oklchToSrgb(parseOklch(c.tick))), srgbLuminance(bg)),
        ).toBeGreaterThanOrEqual(4.5);
      // The ghost is faint: barely off the track, never mistaken for a bar.
      expect(cr(srgbLuminance(ghost), srgbLuminance(track))).toBeLessThan(1.25);
      expect(c.ghost).toMatch(/^oklch\(/);
      expect(c.tick).toMatch(/^oklch\(/);
    });
});
