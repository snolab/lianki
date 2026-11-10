/**
 * The Gantt's categories (packages/debug-chat/src/gantt-groups.ts; owner,
 * 2026-11-10 23:13–23:14 JST): the table, which task goes where, the parent
 * row's roll-up, the lines in order with categories folded and open, the
 * lanes of a folded row (rgui gantt packLanes), the open list in session UI
 * state, and the compact list's category rows.
 */
import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { EtaList } from "@lianki/debug-chat/EtaBar";
import type { EtaTask } from "@lianki/debug-chat/eta";
import {
  GANTT_GROUPS,
  GANTT_GROUPS_KEY,
  GANTT_LANE_MIN_PX,
  ganttLines,
  groupMark,
  groupName,
  groupOf,
  groupRowH,
  laneBox,
  lineOf,
  parseGroups,
  patternScore,
  rollup,
  sliceSpan,
  toggleOpen,
} from "@lianki/debug-chat/gantt-groups";
import {
  GANTT_COLORS,
  centreRowTop,
  oklchToSrgb,
  over,
  parseOklch,
  srgbLuminance,
} from "@lianki/debug-chat/gantt-view";
import { cleanGanttGroupsUi } from "@lianki/debug-chat/ui-store";
import { CHAT_STRINGS_EN } from "@lianki/debug-chat/wire";
import { packLanes } from "../packages/rgui/src/gantt";

const MIN = 60_000;
const NOW = 1_000 * MIN;
const task = (o: Partial<EtaTask> & { id: string }): EtaTask => ({
  title: o.id,
  start: NOW - 10 * MIN,
  at: NOW + 10 * MIN,
  ...o,
});
const of = (id: string) => groupOf(id, GANTT_GROUPS)?.id ?? null;

describe("the category table", () => {
  it("has the owner's eight categories, each a string key with a context line", () => {
    expect(GANTT_GROUPS.map((g) => g.id)).toEqual([
      "chat",
      "gantt",
      "words",
      "ui",
      "import",
      "account",
      "ship",
      "arch",
    ]);
    for (const g of GANTT_GROUPS)
      expect(typeof (CHAT_STRINGS_EN as Record<string, string>)[g.name]).toBe("string");
    expect(GANTT_GROUPS.filter((g) => g.fallback).map((g) => g.id)).toEqual(["arch"]);
    expect(GANTT_GROUPS_KEY).toBe("gantt.groups");
  });

  it("puts each path where the owner said; the most specific pattern wins", () => {
    expect(of("/chat/gantt-groups")).toBe("gantt");
    expect(of("/chat/eta-ticks")).toBe("gantt");
    expect(of("/research/gantt-lod")).toBe("gantt");
    expect(of("/chat/mic")).toBe("chat");
    expect(of("/chat")).toBe("chat");
    expect(of("/voice/kws")).toBe("chat");
    expect(of("/words")).toBe("words");
    expect(of("/words/swipe/feel")).toBe("words");
    expect(of("/design/glass")).toBe("ui");
    expect(of("/i18n")).toBe("ui");
    expect(of("/reader/pdf")).toBe("ui");
    expect(of("/self-intro")).toBe("import");
    expect(of("/books/slugs")).toBe("import");
    expect(of("/membership/gift")).toBe("account");
    expect(of("/payments")).toBe("account");
    expect(of("/ci/flaky")).toBe("ship");
    expect(of("/research/affected-tests")).toBe("ship");
    expect(of("/research/upstream")).toBe("arch");
    expect(of("/box/eta")).toBe("arch");
    // A path only: "/words" is not "/wordsmith"; nothing else matching, the fallback takes it.
    expect(of("/wordsmith")).toBe("arch");
    expect(of("live-slug")).toBe("arch");
  });

  it("patterns: a path and what is under it, or a prefix with *", () => {
    expect(patternScore("/words", "/words")).toBe(6);
    expect(patternScore("/words/", "/words/x")).toBe(6);
    expect(patternScore("/words", "/wordsmith")).toBe(-1);
    expect(patternScore("/chat/gantt*", "/chat/gantt-groups")).toBe(11);
    expect(patternScore("/chat/gantt*", "/chat/mic")).toBe(-1);
    // No fallback: an id nothing matches has no category (its own row).
    expect(groupOf("/zzz", [{ id: "a", name: "x", match: ["/a"] }])).toBeNull();
    // A tie: the table's order.
    const two = [
      { id: "a", name: "x", match: ["/same"] },
      { id: "b", name: "y", match: ["/same"] },
    ];
    expect(groupOf("/same/x", two)?.id).toBe("a");
  });

  it("a stored table is checked entry by entry; not a list keeps the default", () => {
    expect(parseGroups({})).toBeNull();
    expect(parseGroups("x")).toBeNull();
    expect(
      parseGroups([
        { id: "ok", name: "etaGroupWords", match: ["/w", "no-slash", 3, "/has space"] },
        { id: "ok", name: "dup", match: ["/d"] },
        { id: "Bad Id", name: "x", match: ["/b"] },
        { id: "noname", match: ["/n"] },
        { id: "long", name: "x".repeat(61), match: ["/l"] },
        { id: "empty", name: "x", match: [] },
        { id: "fb", name: "x", match: [], fallback: true, label: "Other" },
        { id: "fb2", name: "y", match: ["/y"], fallback: true, label: "" },
        null,
      ]),
    ).toEqual([
      { id: "ok", name: "etaGroupWords", match: ["/w"] },
      { id: "fb", name: "x", match: [], fallback: true, label: "Other" },
      { id: "fb2", name: "y", match: ["/y"] },
    ]);
  });

  it("names: the translated string, else the label, else the id", () => {
    expect(groupName(GANTT_GROUPS[0]!, CHAT_STRINGS_EN)).toBe("Chat & voice");
    expect(groupName({ id: "x", name: "nope", match: [], label: "Other" }, CHAT_STRINGS_EN)).toBe(
      "Other",
    );
    expect(groupName({ id: "x", name: "nope", match: [] }, CHAT_STRINGS_EN)).toBe("x");
  });
});

describe("lanes: overlapping bars on one row", () => {
  it("packs greedily by start; the count is the most overlapping at once", () => {
    expect(packLanes([])).toEqual({ lane: [], lanes: 0 });
    // a [0,10] b [5,15] c [10,20] (c reuses a's lane: touching shares) d [12,13]
    expect(
      packLanes([
        { from: 0, to: 10 },
        { from: 5, to: 15 },
        { from: 10, to: 20 },
        { from: 12, to: 13 },
      ]),
    ).toEqual({ lane: [0, 1, 0, 2], lanes: 3 });
    // Input order is kept in `lane`; an instant (to < from) takes no time.
    expect(
      packLanes([
        { from: 30, to: 40 },
        { from: 0, to: 50 },
        { from: 45, to: 44 },
      ]),
    ).toEqual({ lane: [1, 0, 1], lanes: 2 });
    // Nothing overlaps: one lane.
    expect(
      packLanes([
        { from: 0, to: 1 },
        { from: 2, to: 3 },
      ]).lanes,
    ).toBe(1);
  });

  it("a folded row keeps the usual height until lanes would be too thin, then grows", () => {
    expect(groupRowH(1, 30)).toBe(30);
    expect(groupRowH(0, 30)).toBe(30);
    expect(groupRowH(5, 30)).toBe(30);
    expect(groupRowH(8, 30)).toBe(8 * GANTT_LANE_MIN_PX);
    expect(laneBox(2, 4, 40)).toEqual({ top: 20, h: 10 });
    expect(laneBox(0, 0, 30)).toEqual({ top: 0, h: 30 });
  });

  it("a bar's span runs on to now when late; queued and parked stop at the estimate; done to when it ended", () => {
    expect(sliceSpan(task({ id: "/a", at: NOW - MIN }), NOW)).toEqual({
      from: NOW - 10 * MIN,
      to: NOW,
    });
    expect(sliceSpan(task({ id: "/a", at: NOW - MIN, queued: true }), NOW).to).toBe(NOW - MIN);
    expect(sliceSpan(task({ id: "/a", at: NOW - MIN, parked: "owner" }), NOW).to).toBe(NOW - MIN);
    expect(
      sliceSpan(task({ id: "/a", at: NOW - 5 * MIN, done: true, doneAt: NOW - 2 * MIN }), NOW).to,
    ).toBe(NOW - 2 * MIN);
    expect(sliceSpan(task({ id: "/a", at: NOW - 5 * MIN, done: true }), NOW).to).toBe(
      NOW - 5 * MIN,
    );
  });
});

describe("the parent row", () => {
  it("spans the earliest start to the latest end; progress weighted by each estimate", () => {
    const p = rollup("words", "Words", [
      task({ id: "/a", start: NOW - 30 * MIN, at: NOW + 30 * MIN, pct: 50 }), // 60 min
      task({ id: "/b", start: NOW, at: NOW + 20 * MIN, done: true, doneAt: NOW + MIN }), // 20 min, 100%
      task({ id: "/c", start: NOW, at: NOW + 20 * MIN }), // 20 min, no pct: 0
    ]);
    expect(p).toMatchObject({
      id: "group:words",
      title: "Words",
      start: NOW - 30 * MIN,
      at: NOW + 30 * MIN,
    });
    expect(p.pct).toBe(Math.round((100 * (60 * 0.5 + 20)) / 100));
    expect(p.done).toBeUndefined();
    const done = rollup("x", "X", [
      task({ id: "/a", done: true, doneAt: NOW - MIN }),
      task({ id: "/b", done: true, doneAt: NOW - 3 * MIN }),
    ]);
    expect(done).toMatchObject({ done: true, doneAt: NOW - MIN, pct: 100 });
    // Every open child queued, or parked: so is the parent ("owner" if any waits for him).
    expect(rollup("x", "X", [task({ id: "/a", queued: true })]).queued).toBe(true);
    expect(
      rollup("x", "X", [task({ id: "/a", parked: "blocked" }), task({ id: "/b", parked: "owner" })])
        .parked,
    ).toBe("owner");
    expect(rollup("x", "X", [task({ id: "/a", parked: "blocked" })]).parked).toBe("blocked");
    expect(
      rollup("x", "X", [task({ id: "/a", parked: "owner" }), task({ id: "/b" })]).parked,
    ).toBeUndefined();
    // pct clamped; an estimate shorter than a minute weighs a minute.
    expect(rollup("x", "X", [task({ id: "/a", start: NOW, at: NOW, pct: 250 })]).pct).toBe(100);
  });

  it("carries the red mark of any child waiting for the owner", () => {
    expect(groupMark([task({ id: "/a" })])).toBeNull();
    expect(groupMark([task({ id: "/a", parked: "owner", question: true })])).toBe("?");
    expect(
      groupMark([
        task({ id: "/a", parked: "owner", question: true }),
        task({ id: "/b", parked: "owner" }),
      ]),
    ).toBe("!");
    expect(groupMark([task({ id: "/a", parked: "owner", done: true })])).toBeNull();
  });
});

describe("the lines", () => {
  const T = [
    task({ id: "/words/a", at: NOW + 5 * MIN }),
    task({ id: "/words/b", start: NOW - 5 * MIN, at: NOW + 40 * MIN }),
    task({ id: "/chat/mic", at: NOW + 20 * MIN }),
    task({ id: "/done/x", at: NOW - 60 * MIN, done: true, doneAt: NOW - 50 * MIN }),
  ];
  const name = (g: { id: string }) => g.id.toUpperCase();

  it("folded by default: one line per category, by end time", () => {
    const ls = ganttLines(T, GANTT_GROUPS, [], name, NOW);
    expect(ls.map((l) => l.key)).toEqual(["group:arch", "group:chat", "group:words"]);
    const words = ls[2]!;
    if (words.kind !== "group") throw new Error("a group");
    expect(words.task.title).toBe("WORDS");
    expect(words.children.map((t) => t.id)).toEqual(["/words/a", "/words/b"]);
    // The two overlap: two lanes.
    expect(words.lanes).toBe(2);
    expect(words.open).toBe(false);
    expect(words.mark).toBeNull();
    expect(lineOf(ls, "/words/b")).toBe(2);
    expect(lineOf(ls, "/nope")).toBe(-1);
  });

  it("open: the children follow their parent, each its own line", () => {
    const ls = ganttLines(T, GANTT_GROUPS, ["words"], name, NOW);
    expect(ls.map((l) => l.key)).toEqual([
      "group:arch",
      "group:chat",
      "group:words",
      "/words/a",
      "/words/b",
    ]);
    expect(ls[3]).toMatchObject({ kind: "task", group: "words" });
    expect(lineOf(ls, "/words/b")).toBe(4);
  });

  it("an id no category takes (no fallback) is a line of its own, sorted with the parents", () => {
    const defs = [{ id: "w", name: "x", match: ["/words"] }];
    const ls = ganttLines(T, defs, [], name, NOW);
    expect(ls.map((l) => l.key)).toEqual(["/done/x", "/chat/mic", "group:w"]);
    expect(ls[0]).toMatchObject({ kind: "task", group: null });
    // An empty table: the flat rows, by end time.
    expect(ganttLines(T, [], [], name, NOW).map((l) => l.key)).toEqual([
      "/done/x",
      "/words/a",
      "/chat/mic",
      "/words/b",
    ]);
  });

  it("toggles an id in the open list", () => {
    expect(toggleOpen([], "a")).toEqual(["a"]);
    expect(toggleOpen(["a", "b"], "a")).toEqual(["b"]);
  });

  it("centres a row of its own height, wherever it starts", () => {
    const base = { viewH: 400, axisH: 20, headSpace: 100, rowGap: 2 };
    expect(centreRowTop({ ...base, i: 2, rowH: 30 })).toBe(
      centreRowTop({ ...base, i: 2, rowH: 30, before: 64 }),
    );
    expect(centreRowTop({ ...base, i: 1, rowH: 60, before: 332 })).toBe(
      Math.round(20 + 100 + 332 + 30 - (20 + 380 / 2)),
    );
  });
});

describe("open categories: session UI state", () => {
  it("keeps only a list of short category ids, each once", () => {
    expect(cleanGanttGroupsUi(null)).toEqual({});
    expect(cleanGanttGroupsUi({ open: "words" })).toEqual({});
    expect(
      cleanGanttGroupsUi({ open: ["words", "words", "Bad", 3, "x".repeat(41), "ship"] }),
    ).toEqual({
      open: ["words", "ship"],
    });
  });
});

describe("the chat's task list, grouped", () => {
  const html = (o: Parameters<typeof EtaList>[0]) =>
    renderToString(createElement(EtaList, o)).replace(/<!-- -->/g, "");
  const T = [
    task({ id: "/words/a", title: "Swipe: feel", at: NOW + 5 * MIN, pct: 50 }),
    task({ id: "/words/b", start: NOW - 5 * MIN, at: NOW + 40 * MIN, parked: "owner" }),
    task({ id: "/chat/mic", at: NOW - 2 * MIN }),
  ];

  it("folded: a row per category, its tasks' bars in lanes, a ▸ button with its label", () => {
    const out = html({ tasks: T, now: NOW, strings: CHAT_STRINGS_EN });
    expect(out.match(/data-testid="debug-chat-eta-group"/g)?.length).toBe(2);
    expect(out).not.toContain('data-testid="debug-chat-eta-row"');
    expect(out.match(/data-testid="debug-chat-eta-slice"/g)?.length).toBe(3);
    expect(out).toContain('data-lanes="2"');
    expect(out).toMatch(
      /data-testid="debug-chat-eta-toggle" aria-expanded="false" aria-label="Tasks in Words page"/,
    );
    expect(out).toContain("Words page");
    expect(out).toContain(" ×2");
    // The waiting child's red mark on its parent; the late child's red time on its.
    expect(out).toMatch(/data-testid="debug-chat-eta-mark"[^>]*>!</);
    expect(out).toMatch(/data-late="true"[^>]*>-2M</);
    expect(out).toMatch(/<svg aria-hidden="true" data-open="false"/);
    expect(out).not.toMatch(/#[0-9a-f]{3,6}\b|rgb\(/i);
  });

  it("open: the roll-up bar, the children below as their own rows", () => {
    const out = html({ tasks: T, now: NOW, strings: CHAT_STRINGS_EN, open: ["words"] });
    expect(out).toMatch(/data-testid="debug-chat-eta-toggle" aria-expanded="true"/);
    expect(out).toMatch(/<svg aria-hidden="true" data-open="true"/);
    expect(out.match(/data-testid="debug-chat-eta-row"/g)?.length).toBe(2);
    expect(out).toContain("padding-inline-start:2.25rem");
    // A folded parent of done tasks and one of parked ones read "Done" and a reminder.
    const done = html({
      tasks: [task({ id: "/words/a", done: true, doneAt: NOW - 1000 })],
      now: NOW,
      strings: CHAT_STRINGS_EN,
    });
    expect(done).toContain(`>${CHAT_STRINGS_EN.etaDone}<`);
    const parked = html({
      tasks: [task({ id: "/words/a", parked: "blocked", at: NOW + 60 * MIN })],
      now: NOW,
      strings: CHAT_STRINGS_EN,
    });
    expect(parked).toContain("reminder in 1H");
  });
});

describe("a folded category's label", () => {
  it("sits on a see-through chip: its text AA over the chip over any bar", () => {
    for (const theme of ["light", "dark"] as const) {
      const c = GANTT_COLORS[theme];
      const track = oklchToSrgb(parseOklch(c.track));
      for (const under of ["bar", "queued", "past", "done", "fill"] as const) {
        const bg = over(parseOklch(c.chip), over(parseOklch(c[under]), track));
        for (const ink of ["text", "muted", "late"] as const) {
          const a = srgbLuminance(oklchToSrgb(parseOklch(c[ink])));
          const b = srgbLuminance(bg);
          const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
          expect(ratio).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });
});
