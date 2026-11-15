/**
 * The ETA bar's change ticker (packages/debug-chat/src/eta-ticker.ts): task
 * snapshots → announcements, the queue (newest first, capped, each shown for
 * its seconds, then the summary), the owner's own changes skipped, and the
 * bar drawing an announcement in place of its summary.
 */
import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { EtaTask } from "@lianki/debug-chat/eta";
import {
  ETA_TICKER_KEEP,
  ETA_TICKER_SEC,
  TICKER_EMPTY,
  type TickerItem,
  etaChanges,
  lateCrossings,
  tickerNextWake,
  tickerPush,
  tickerShown,
  tickerText,
} from "@lianki/debug-chat/eta-ticker";
import { useEtaTicker } from "@lianki/debug-chat/eta-ticker-hook";
import { ETA_FLASH_CSS, EtaBar } from "@lianki/debug-chat/EtaBar";
import { CHAT_STRINGS_EN } from "@lianki/debug-chat/wire";
import { CONFIG } from "@/lib/config";
import { stubGlobals } from "./support/globals";

const MIN = 60_000;
const task = (over: Partial<EtaTask> & { id: string }): EtaTask => ({
  title: `${over.id.slice(1)}: what it does`,
  start: 0,
  at: 30 * MIN,
  ...over,
});
const by = (name: string) => ({
  ticks: [{ at: 0, kind: "change" as const, changeId: "c", by: name }],
});

describe("etaChanges", () => {
  const a = task({ id: "/a", ...by("codex") });
  it("the first snapshot is the page loading: nothing", () => {
    expect(etaChanges(null, [a], 0)).toEqual([]);
  });
  it("a new task, with the agent that made it", () => {
    const [n] = etaChanges([], [a], 0);
    expect(n).toMatchObject({ kind: "new", id: "/a", by: "codex", key: "new:/a" });
  });
  it("a new task already done is not news; an unchanged one neither", () => {
    expect(etaChanges([], [task({ id: "/x", done: true, doneAt: 1 })], 0)).toEqual([]);
    expect(etaChanges([a], [a], 0)).toEqual([]);
  });
  it("done on time, and done early with how much", () => {
    const done = etaChanges([a], [{ ...a, done: true, doneAt: 30 * MIN }], 0);
    expect(done[0]).toMatchObject({ kind: "done", key: "done:/a" });
    const early = etaChanges([a], [{ ...a, done: true, doneAt: 10 * MIN }], 0);
    expect(early[0]).toMatchObject({ kind: "early", deltaMs: 20 * MIN });
    // No doneAt: now is when it was done.
    expect(etaChanges([a], [{ ...a, done: true }], 25 * MIN)[0]!.kind).toBe("early");
    // Already done before: not again.
    const d = { ...a, done: true, doneAt: 1 };
    expect(etaChanges([d], [d], 0)).toEqual([]);
  });
  it("ETA pushed later, with the delta; under a minute or earlier is not news", () => {
    const later = etaChanges([a], [{ ...a, at: 50 * MIN }], 0);
    expect(later[0]).toMatchObject({
      kind: "later",
      deltaMs: 20 * MIN,
      key: `later:/a:${50 * MIN}`,
    });
    expect(etaChanges([a], [{ ...a, at: 30 * MIN + 30_000 }], 0)).toEqual([]);
    expect(etaChanges([a], [{ ...a, at: 10 * MIN }], 0)).toEqual([]);
  });
  it("blocked, and waiting on the owner", () => {
    expect(etaChanges([a], [{ ...a, parked: "blocked" }], 0)[0]!.kind).toBe("blocked");
    expect(etaChanges([a], [{ ...a, parked: "owner" }], 0)[0]!.kind).toBe("waiting");
    // Coming off parked with a later time (the reminder): not "later".
    expect(etaChanges([{ ...a, parked: "owner" }], [{ ...a, at: 90 * MIN }], 0)).toEqual([]);
  });
  it("late: the hub marked it pinged", () => {
    expect(etaChanges([a], [{ ...a, sent: true }], 0)[0]).toMatchObject({ kind: "late" });
    expect(etaChanges([a], [{ ...a, sent: true, queued: true }], 0)).toEqual([]);
  });
  it("the owner's own change is never announced", () => {
    const mine = task({ id: "/m", ...by("owner") });
    expect(etaChanges([], [mine], 0)).toEqual([]);
    expect(etaChanges([mine], [{ ...mine, done: true, doneAt: 0 }], 0)).toEqual([]);
  });
  it("no ticks: no name", () => {
    expect(etaChanges([], [task({ id: "/n" })], 0)[0]!.by).toBeUndefined();
  });
});

describe("lateCrossings", () => {
  it("open running tasks whose ETA the clock just passed", () => {
    const ts = [
      task({ id: "/a", at: 10 * MIN }),
      task({ id: "/b", at: 20 * MIN }),
      task({ id: "/c", at: 10 * MIN, done: true }),
      task({ id: "/d", at: 10 * MIN, parked: "owner" }),
    ];
    expect(lateCrossings(ts, 5 * MIN, 15 * MIN).map((i) => i.id)).toEqual(["/a"]);
    expect(lateCrossings(ts, 10 * MIN, 15 * MIN)).toEqual([]);
  });
});

describe("the queue", () => {
  const item = (n: number): TickerItem => ({
    key: `k${n}`,
    kind: "new",
    id: `/t${n}`,
    title: `T${n}`,
  });
  it("newest first, capped, a pass per arrival; a repeated key is not news", () => {
    let s = tickerPush(TICKER_EMPTY, [item(1)], 100, 3);
    expect(s).toEqual({ items: [item(1)], since: 100 });
    s = tickerPush(s, [item(2), item(3)], 200, 3);
    expect(s.items.map((i) => i.key)).toEqual(["k3", "k2", "k1"]);
    s = tickerPush(s, [item(4)], 300, 3);
    expect(s.items.map((i) => i.key)).toEqual(["k4", "k3", "k2"]);
    expect(tickerPush(s, [item(4)], 400, 3)).toBe(s);
    expect(tickerPush(s, [], 400, 3)).toBe(s);
    expect(tickerPush(TICKER_EMPTY, [item(1), item(1)], 0, 0).items).toEqual([item(1)]);
  });
  it("each item for its seconds, then the summary; the wake times", () => {
    const s = tickerPush(TICKER_EMPTY, [item(1), item(2)], 1000, 5);
    expect(tickerShown(s, 1000, 100)?.key).toBe("k2");
    expect(tickerShown(s, 1150, 100)?.key).toBe("k1");
    expect(tickerShown(s, 1200, 100)).toBeNull();
    expect(tickerShown(s, 999, 100)).toBeNull();
    expect(tickerShown(s, 1000, 0)).toBeNull();
    expect(tickerShown(TICKER_EMPTY, 1000, 100)).toBeNull();
    expect(tickerNextWake(s, 1050, 100)).toBe(1100);
    expect(tickerNextWake(s, 1100, 100)).toBe(1200);
    expect(tickerNextWake(s, 1200, 100)).toBeNull();
    expect(tickerNextWake(TICKER_EMPTY, 0, 100)).toBeNull();
    expect(tickerNextWake(s, 0, 0)).toBeNull();
  });
});

describe("tickerText", () => {
  const t = (kind: TickerItem["kind"], deltaMs?: number) =>
    tickerText(
      { key: "k", kind, id: "/a", title: "Swipe fix: drag the card", deltaMs },
      CHAT_STRINGS_EN,
    );
  it("the kind's template, the task's name, the ETA delta in the bar's time", () => {
    expect(t("new")).toBe("new: Swipe fix");
    expect(t("done")).toBe("done: Swipe fix");
    expect(t("early", 20 * MIN)).toBe("done 20M early: Swipe fix");
    expect(t("later", 90 * MIN)).toBe("1.5H later: Swipe fix");
    expect(t("blocked")).toBe("blocked: Swipe fix");
    expect(t("waiting")).toBe("waiting for you: Swipe fix");
    expect(t("late")).toBe("ETA reached: Swipe fix");
  });
});

describe("config", () => {
  it("public keys with the code defaults", () => {
    expect(CONFIG["chat.etaTickerSec"]).toMatchObject({
      default: ETA_TICKER_SEC,
      audience: "public",
    });
    expect(CONFIG["chat.etaTickerKeep"]).toMatchObject({
      default: ETA_TICKER_KEEP,
      audience: "public",
    });
    expect(ETA_TICKER_SEC).toBe(6);
    expect(ETA_TICKER_KEEP).toBe(1);
  });
});

describe("the bar with an announcement", () => {
  const tasks = [task({ id: "/a", at: 10 * MIN }), task({ id: "/b", at: 30 * MIN })];
  const bar = (news: Parameters<typeof EtaBar>[0]["news"], compact = false) =>
    renderToStaticMarkup(
      <EtaBar
        tasks={tasks}
        now={5 * MIN}
        strings={CHAT_STRINGS_EN}
        onOpen={() => {}}
        news={news}
        compact={compact}
      />,
    );
  it("the announcement replaces the summary, with the lane, its icon and the flash", () => {
    const out = bar({
      item: {
        key: "later:/a:1",
        kind: "later",
        id: "/a",
        title: "a: x",
        by: "codex",
        deltaMs: 20 * MIN,
      },
      since: 1,
    });
    expect(out).toContain('data-news="later"');
    expect(out).toContain('data-testid="debug-chat-eta-news"');
    expect(out).toContain("codex");
    expect(out).toContain("20M later: a");
    expect(out).toContain('aria-label="codex: 20M later: a · 25%');
    expect(out).toContain('data-testid="debug-chat-eta-flash"');
    expect(out).toContain('data-kind="later"');
    expect(out).not.toContain("2 tasks");
    // The percent stays: nothing moves.
    expect(out).toContain("25%</span>");
  });
  it("every kind has its mark; late is the clock in the late colour", () => {
    for (const kind of ["new", "done", "early", "blocked", "waiting"] as const)
      expect(bar({ item: { key: kind, kind, id: "/a", title: "a" }, since: 1 })).toContain(
        `data-kind="${kind}"`,
      );
    const late = bar({ item: { key: "l", kind: "late", id: "/a", title: "a" }, since: 1 });
    expect(late).toContain("ETA reached: a");
    expect(late).not.toContain("debug-chat-eta-news-icon");
  });
  it("no announcement, or the folded chat: the summary", () => {
    expect(bar(null)).toContain("2 tasks");
    expect(bar(null)).not.toContain("debug-chat-eta-flash");
    const folded = bar({ item: { key: "n", kind: "new", id: "/a", title: "a" }, since: 1 }, true);
    expect(folded).not.toContain("debug-chat-eta-news");
  });
  it("the flash honours reduced motion", () => {
    expect(ETA_FLASH_CSS).toContain("prefers-reduced-motion: reduce");
  });
});

describe("useEtaTicker on a page", () => {
  it("announces an agent's change, then returns to the summary", async () => {
    const { Window } = await import("happy-dom");
    const win = new Window();
    const restore = stubGlobals({
      window: win,
      document: win.document,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const host = win.document.createElement("div");
    win.document.body.appendChild(host);
    const root = createRoot(host as never);
    const cfg = { sec: 0.05, keep: 5 };
    function Probe({ tasks, now }: { tasks: EtaTask[] | null; now: number }) {
      const n = useEtaTicker(tasks, now, cfg);
      return <p data-kind={n?.item.kind ?? "none"}>{n?.item.id ?? ""}</p>;
    }
    const p = () => host.querySelector("p")!.getAttribute("data-kind");
    const a = task({ id: "/a", at: Date.now() + 10 * MIN, ...by("codex") });
    try {
      await act(() => root.render(<Probe tasks={null} now={0} />));
      expect(p()).toBe("none");
      await act(() => root.render(<Probe tasks={[a]} now={0} />));
      // The first snapshot is the load: no news.
      expect(p()).toBe("none");
      await act(() => root.render(<Probe tasks={[a, task({ id: "/b", ...by("agy") })]} now={0} />));
      expect(p()).toBe("new");
      await act(() => Bun.sleep(120));
      expect(p()).toBe("none");
      // The page's clock passes /a's ETA: late.
      await act(() =>
        root.render(<Probe tasks={[a, task({ id: "/b", ...by("agy") })]} now={a.at + 1} />),
      );
      expect(p()).toBe("late");
      // Backwards or the same clock: nothing new.
      await act(() =>
        root.render(<Probe tasks={[a, task({ id: "/b", ...by("agy") })]} now={a.at + 1} />),
      );
      await act(() => root.render(<Probe tasks={null} now={a.at + 2} />));
      await act(() => root.unmount());
    } finally {
      restore();
    }
  });
  it("default config", () => {
    function P() {
      useEtaTicker(null, 0);
      return null;
    }
    expect(renderToStaticMarkup(<P />)).toBe("");
  });
});

describe("icons the ticker draws", () => {
  it("check and pause, beside the set's other drawn icons", async () => {
    const { Icon, TreeIcon, HistoryIcon } = await import("@lianki/debug-chat/icons");
    expect(renderToStaticMarkup(<Icon name="check" />)).toContain('data-icon="check"');
    expect(renderToStaticMarkup(<Icon name="pause" weight="fill" />)).toContain(
      'data-icon="pause"',
    );
    expect(renderToStaticMarkup(<TreeIcon />)).toContain("<rect");
    expect(renderToStaticMarkup(<HistoryIcon />)).toContain("<path");
  });
});
