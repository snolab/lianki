import { describe, expect, it } from "bun:test";
import {
  ETA_GIVE_UP_MS,
  ETA_RETRY_MS,
  PROGRESS_OWNER_HEADER,
  ProgressHub,
} from "@/workers/push/src/progress";
import type { Socket, Storage } from "@/workers/push/src/debug";
import { type ProgressEntry, mergeProgress, parseEta, parseProgressReport } from "@/lib/progress";
import { liveTreeSource, overlayProgress } from "@/lib/progress-tree";
import { ETA_PATH, etaLineText, parseEtaPing } from "@/lib/eta-ping";
import { FLAGS } from "@/lib/flags";
import { parseProgressArgs } from "@/scripts/dev/progress-args";
import { chatLine } from "@/scripts/dev/node-args";
import {
  type EtaTask,
  LINGER_MS,
  dueTasks,
  etaClock,
  etaEnds,
  etaParts,
  etaPartsText,
  etaSummary,
  etaTasks,
  nextWake,
  shortLeft,
  splitTitle,
  taskFraction,
} from "@lianki/debug-chat/eta";
import {
  ETA_COLORS,
  EtaBar,
  EtaClockIcon,
  EtaList,
  keepFocus,
  summaryText,
  taskState,
} from "@lianki/debug-chat/EtaBar";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { CHAT_STRINGS_EN, contrastRatio, oklchLuminance } from "@lianki/debug-chat/wire";

const ROOT = "root-secret";
const MIN = 60_000;

class FakeSocket implements Socket {
  sent: Record<string, unknown>[] = [];
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {}
  serializeAttachment() {}
  deserializeAttachment() {
    return null;
  }
}
(globalThis as unknown as { WebSocketPair: unknown }).WebSocketPair = class {
  0 = new FakeSocket();
  1 = new FakeSocket();
};

function fakeStorage(): Storage & { store: Map<string, unknown>; alarm: number | null } {
  const store = new Map<string, unknown>();
  return {
    store,
    alarm: null,
    async getAlarm() {
      return this.alarm;
    },
    async setAlarm(at: number) {
      this.alarm = at;
    },
    get: async <T>(k: string) => structuredClone(store.get(k)) as T | undefined,
    put: async (k, v) => void store.set(k, structuredClone(v)),
    delete: async (k) => store.delete(k),
    list: async <T>({ prefix }: { prefix: string }) => {
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
      return new Map(keys.map((k) => [k, structuredClone(store.get(k)) as T]));
    },
  };
}

/** A progress hub with a fake chat hub behind its DEBUG binding. */
function setup(answer: () => Response | Promise<Response> = () => Response.json({ ok: true })) {
  let t = 1_000_000;
  const sockets: FakeSocket[] = [];
  const storage = fakeStorage();
  const pings: Record<string, unknown>[] = [];
  const DEBUG = {
    idFromName: (n: string) => n,
    get: () => ({
      fetch: async (req: Request) => {
        expect(new URL(req.url).pathname).toBe(ETA_PATH);
        pings.push((await req.json()) as Record<string, unknown>);
        return answer();
      },
    }),
  };
  const hub = new ProgressHub(
    {
      acceptWebSocket: (ws) => sockets.push(ws as FakeSocket),
      getWebSockets: () => sockets,
      storage,
    },
    { PROGRESS_TOKEN: ROOT, DEBUG },
    () => t,
  );
  const write = async (body: Record<string, unknown>) => {
    const res = await hub.fetch(
      new Request("https://lianki.com/api/version/progress", {
        method: "POST",
        headers: { authorization: `Bearer ${ROOT}` },
        body: JSON.stringify({ agent: "a1", status: "doing", task: "Native swipe", ...body }),
      }),
    );
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  const page = async () => {
    await hub.fetch(
      new Request("https://lianki.com/api/version/progress", {
        headers: { upgrade: "websocket", [PROGRESS_OWNER_HEADER]: "1" },
      }),
    );
    return sockets.at(-1)!;
  };
  const entry = (id: string) => storage.store.get(`e:${id}`) as ProgressEntry | undefined;
  return {
    hub,
    storage,
    pings,
    write,
    page,
    entry,
    tick: (ms: number) => (t += ms),
    now: () => t,
  };
}

describe("estimates: parsing and revising", () => {
  it("reads a duration or an ISO time; free text is no timer", () => {
    expect(parseEta("15m")).toEqual({ in: 15 * MIN });
    expect(parseEta("1h30m")).toEqual({ in: 90 * MIN });
    expect(parseEta("2h")).toEqual({ in: 120 * MIN });
    expect(parseEta("90s")).toEqual({ in: 90_000 });
    expect(parseEta("2026-11-07T21:00+09:00")).toEqual({ at: Date.parse("2026-11-07T12:00Z") });
    expect(parseEta("after CI")).toBeNull();
    expect(parseEta("2026-11-07 21:00")).toBeNull(); // no zone: ambiguous
    expect(parseEta("0m")).toBeNull();
    expect(parseEta("40d")).toBeNull();
  });

  it("the agent's estimate sets etaAt from the write's own clock; a new one moves it; free text clears it", () => {
    const r = (eta?: string) =>
      parseProgressReport({
        agent: "a",
        task: "t",
        status: "doing",
        ...(eta ? { eta } : {}),
      }) as never;
    const a = mergeProgress(undefined, r("15m"), 1000);
    expect(a.etaAt).toBe(1000 + 15 * MIN);
    const kept = mergeProgress(a, r(), 5000);
    expect(kept.etaAt).toBe(a.etaAt!);
    const moved = mergeProgress(kept, r("40m"), 6000);
    expect(moved.etaAt).toBe(6000 + 40 * MIN);
    expect(mergeProgress(moved, r("after CI"), 7000).etaAt).toBeUndefined();
  });

  it("the CLI passes --eta through; the hub computes etaAt", () => {
    const cmd = parseProgressArgs([
      "--agent",
      "a",
      "--task",
      "t",
      "--status",
      "doing",
      "--eta",
      "25m",
    ]);
    expect(cmd).toMatchObject({ cmd: "report", report: { eta: "25m", etaIn: 25 * MIN } });
  });

  it("the flag exists, owner only, off", () => {
    expect(FLAGS["chat.eta-bar"]).toMatchObject({ default: false, audience: "owner" });
  });
});

describe("the progress hub's ETA alarm and its single delivery", () => {
  it("arms the alarm at etaAt, moves it when the estimate is revised, and pings once when it passes", async () => {
    const h = setup();
    await h.write({ id: "/words/swipe", eta: "30m" });
    expect(h.entry("/words/swipe")?.etaAt).toBe(h.now() + 30 * MIN);
    expect(h.storage.alarm).toBe(h.now() + 30 * MIN);
    // Revised earlier: the alarm moves with it.
    await h.write({ id: "/words/swipe", eta: "10m" });
    const at = h.now() + 10 * MIN;
    expect(h.storage.alarm).toBe(at);
    h.tick(10 * MIN);
    await h.hub.alarm();
    expect(h.pings).toEqual([
      { id: "/words/swipe", title: "Native swipe", etaAt: at, assignee: "a1" },
    ]);
    expect(h.entry("/words/swipe")?.etaSent).toBe(at);
    // Again: nothing more.
    await h.hub.alarm();
    expect(h.pings.length).toBe(1);
  });

  it("two pages whose timers both go off, and the alarm too: one ping", async () => {
    const h = setup();
    await h.write({ id: "/words/swipe", eta: "5m" });
    const phone = await h.page();
    const mac = await h.page();
    h.tick(5 * MIN);
    await Promise.all([
      h.hub.webSocketMessage(phone, JSON.stringify({ type: "eta", id: "/words/swipe" })),
      h.hub.webSocketMessage(mac, JSON.stringify({ type: "eta", id: "/words/swipe" })),
    ]);
    await h.hub.alarm();
    expect(h.pings.length).toBe(1);
    // Both pages hear it was sent (their timers drop it).
    for (const p of [phone, mac])
      expect(p.sent.some((m) => m.type === "progress" && m.etaSent === m.etaAt)).toBe(true);
  });

  it("a page that fires early (its clock runs ahead) is not taken; the alarm still is", async () => {
    const h = setup();
    await h.write({ id: "/words/swipe", eta: "5m" });
    const p = await h.page();
    h.tick(4 * MIN);
    await h.hub.webSocketMessage(p, JSON.stringify({ type: "eta", id: "/words/swipe" }));
    expect(h.pings.length).toBe(0);
    h.tick(MIN);
    await h.hub.alarm();
    expect(h.pings.length).toBe(1);
  });

  it("a revision after the ping pings again at the new time; a done task never pings", async () => {
    const h = setup();
    await h.write({ id: "/words/swipe", eta: "5m" });
    h.tick(5 * MIN);
    await h.hub.alarm();
    await h.write({ id: "/words/swipe", eta: "20m" });
    expect(h.storage.alarm).toBe(h.now() + 20 * MIN);
    h.tick(20 * MIN);
    await h.hub.alarm();
    expect(h.pings.length).toBe(2);
    await h.write({ id: "/x/done", eta: "1m" });
    await h.write({ id: "/x/done", status: "done" });
    h.tick(2 * MIN);
    await h.hub.alarm();
    expect(h.pings.length).toBe(2);
  });

  it("no page open: the alarm alone delivers", async () => {
    const h = setup();
    await h.write({ id: "/words/swipe", eta: "1h" });
    h.tick(60 * MIN);
    await h.hub.alarm();
    expect(h.pings.length).toBe(1);
  });

  it("the chat hub could not take it: tried again later, then given up when very late", async () => {
    let ok = false;
    const h = setup(() =>
      ok ? Response.json({ ok: true }) : new Response("busy", { status: 503 }),
    );
    await h.write({ id: "/words/swipe", eta: "5m" });
    h.tick(5 * MIN);
    await h.hub.alarm();
    expect(h.pings.length).toBe(1);
    expect(h.entry("/words/swipe")?.etaSent).toBeUndefined();
    expect(h.storage.alarm).toBe(h.now() + ETA_RETRY_MS);
    ok = true;
    h.tick(ETA_RETRY_MS);
    await h.hub.alarm();
    expect(h.pings.length).toBe(2);
    expect(h.entry("/words/swipe")?.etaSent).toBe(h.entry("/words/swipe")?.etaAt);
    // Very late (the hub was away): marked sent, not sent.
    await h.write({ id: "/late", eta: "1m" });
    h.tick(ETA_GIVE_UP_MS + 2 * MIN);
    await h.hub.alarm();
    expect(h.pings.length).toBe(2);
    expect(h.entry("/late")?.etaSent).toBe(h.entry("/late")?.etaAt);
  });

  it("a scoped writer cannot move someone else's estimate", async () => {
    const h = setup();
    await h.write({ id: "/words/swipe", eta: "5m" });
    const grant = (await (
      await h.hub.fetch(
        new Request("https://lianki.com/api/version/progress/grant", {
          method: "POST",
          headers: { authorization: `Bearer ${ROOT}` },
          body: JSON.stringify({ node: "/words/swipe", agent: "b2" }),
        }),
      )
    ).json()) as { token: string };
    const res = await h.hub.fetch(
      new Request("https://lianki.com/api/version/progress", {
        method: "POST",
        headers: { authorization: `Bearer ${grant.token}` },
        body: JSON.stringify({
          id: "/words/swipe",
          agent: "b2",
          task: "Native swipe",
          status: "doing",
          eta: "5m",
        }),
      }),
    );
    expect(res.status).toBe(403);
  });
});

describe("the ETA line as the agents read it", () => {
  it("says what it is and is marked automatic in eval.ts chat output", () => {
    expect(etaLineText({ id: "/words/swipe", title: "Native swipe" })).toBe(
      "ETA reached for Native swipe (/words/swipe): report to the owner",
    );
    expect(parseEtaPing({ id: "/a", title: "t", etaAt: 5 })).toEqual({
      id: "/a",
      title: "t",
      etaAt: 5,
    });
    expect(parseEtaPing({ id: "/a", title: "", etaAt: 5 })).toBeNull();
    const line = chatLine(
      {
        id: "e1",
        from: "agent",
        to: "/",
        agentId: "eta",
        source: "eta",
        quiet: true,
        text: "ETA reached for t (/a): report to the owner",
        at: 1,
        thread: "owner",
        label: "ETA timer (automatic)",
        eta: { id: "/a", etaAt: 1 },
      },
      {},
      false,
    );
    expect(line).toMatchObject({ from: "agent", source: "eta", auto: true, eta: { id: "/a" } });
    // A listener with its own agent name still hears it (it is not its own line).
    expect(
      chatLine(
        { id: "e2", from: "agent", to: "/", agentId: "eta", source: "eta", text: "x", at: 1 },
        { agent: "main" },
        false,
      ),
    ).not.toBeNull();
  });
});

const task = (over: Partial<EtaTask>): EtaTask => ({
  id: "/a",
  title: "A",
  start: 0,
  at: 10 * MIN,
  ...over,
});

describe("the page: summary, short times, the one timer", () => {
  it("collects timed tasks from the overlaid tree", () => {
    const entry = (id: string, etaAt?: number, status = "doing") =>
      ({
        id,
        assignee: { type: "agent", name: "a" },
        task: id.slice(1),
        status,
        kind: "task",
        creator: "a",
        by: "a",
        rev: 1,
        created: 0,
        at: 0,
        ...(etaAt ? { etaAt } : {}),
      }) as ProgressEntry;
    const root = overlayProgress({ title: "", links: [], children: [] }, [
      entry("/words", undefined),
      entry("/words/swipe", 5 * MIN),
      entry("/read/pdf", 2 * MIN),
    ]);
    expect(etaTasks(root).map((t) => [t.id, t.at])).toEqual([
      ["/read/pdf", 2 * MIN],
      ["/words/swipe", 5 * MIN],
    ]);
  });

  it("weights progress by each estimate, counts several, names the next", () => {
    const tasks = [task({ id: "/a", at: 10 * MIN }), task({ id: "/b", title: "B", at: 30 * MIN })];
    const s = etaSummary(tasks, 5 * MIN);
    // (10·0.5 + 30·(5/30)) / 40 = 10/40
    expect(s.pct).toBe(25);
    expect(s.count).toBe(2);
    expect(s.leftMs).toBe(25 * MIN);
    expect(s.next?.id).toBe("/a");
    expect(summaryText(tasks, 5 * MIN, CHAT_STRINGS_EN, "en")).toBe(
      "2 tasks · 25m left · next in 5m",
    );
    expect(summaryText([tasks[0]!], 5 * MIN, CHAT_STRINGS_EN, "en")).toBe("A · 5m left");
    expect(summaryText([tasks[0]!], 11 * MIN, CHAT_STRINGS_EN, "en")).toBe("A · ETA reached");
    expect(taskFraction(tasks[0]!, 20 * MIN)).toBe(1);
  });

  it("a done task counts as full, then leaves after a moment", () => {
    const done = task({ done: true, doneAt: 4 * MIN });
    expect(etaSummary([done], 4 * MIN + 1).count).toBe(1);
    expect(etaSummary([done], 4 * MIN + LINGER_MS).count).toBe(0);
  });

  it("short times round minutes up", () => {
    expect(shortLeft(30_000, "en")).toBe("1m");
    expect(shortLeft(25 * MIN, "en")).toBe("25m");
    expect(shortLeft(65 * MIN, "en")).toBe("1h 5m");
    expect(shortLeft(120 * MIN, "en")).toBe("2h");
    expect(shortLeft(27 * 60 * MIN, "en")).toBe("1d 3h");
  });

  it("wakes at the next label change or estimate, never for a past or sent one", () => {
    expect(nextWake([task({ at: 10 * MIN })], 0)).toBe(MIN);
    expect(nextWake([task({ at: 10 * MIN })], 9 * MIN + 30_000)).toBe(10 * MIN);
    expect(nextWake([task({ at: 10 * MIN })], 11 * MIN)).toBeNull();
    expect(nextWake([task({ done: true, doneAt: 0 })], 1000)).toBe(LINGER_MS);
    expect(
      dueTasks([task({ at: 5, sent: true }), task({ id: "/b", at: 5 })], 10).map((t) => t.id),
    ).toEqual(["/b"]);
  });

  /** Fake timers: one list of pending callbacks with their due times. */
  const fakeClock = () => {
    let now = 0;
    const timers = new Map<number, { at: number; fn: () => void }>();
    let n = 0;
    return {
      now: () => now,
      setTimeout: (fn: () => void, ms: number) => (timers.set(++n, { at: now + ms, fn }), n),
      clearTimeout: (id: unknown) => void timers.delete(id as number),
      pending: () => [...timers.values()].map((t) => t.at),
      /** Run time forward, firing timers in order. */
      advance(ms: number) {
        const end = now + ms;
        for (;;) {
          const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
          if (!next || next[1].at > end) break;
          timers.delete(next[0]);
          now = next[1].at;
          next[1].fn();
        }
        now = end;
      },
    };
  };

  it("one timer per page, re-armed when the estimate is revised; reports once per estimate", () => {
    const c = fakeClock();
    const due: string[] = [];
    const ticks: number[] = [];
    const clock = etaClock({ ...c, onDue: (id) => due.push(id), onTick: (t) => ticks.push(t) });
    clock.update([task({ at: 3 * MIN })]);
    expect(c.pending()).toEqual([MIN]);
    clock.update([task({ at: 3 * MIN })]);
    expect(c.pending()).toEqual([MIN]); // still one
    // Revised to 90 s: re-armed to the new change.
    clock.update([task({ at: 90_000 })]);
    expect(c.pending()).toEqual([30_000]);
    c.advance(90_000);
    expect(due).toEqual(["/a"]);
    expect(c.pending()).toEqual([]);
    // The tree updates again (still unsent): no second report from this page.
    clock.update([task({ at: 90_000 })]);
    expect(due).toEqual(["/a"]);
    // A revised estimate is a new one: reported when it runs out.
    clock.update([task({ at: 3 * MIN })]);
    c.advance(2 * MIN);
    expect(due).toEqual(["/a", "/a"]);
    expect(ticks.length).toBeGreaterThan(0);
    clock.stop();
    expect(clock.armed()).toBe(false);
  });

  it("a page opened after an estimate ran out reports it at once; a sent one never", () => {
    const c = fakeClock();
    const due: string[] = [];
    const clock = etaClock({ ...c, onDue: (id) => due.push(id), onTick: () => {} });
    c.advance(20 * MIN);
    clock.update([task({ at: 10 * MIN }), task({ id: "/s", at: 10 * MIN, sent: true })]);
    expect(due).toEqual(["/a"]);
    expect(clock.armed()).toBe(false);
  });
});

describe("the bar and the list, rendered", () => {
  const two = [task({ id: "/a", at: 10 * MIN }), task({ id: "/b", title: "B", at: 30 * MIN })];
  const html = (el: Parameters<typeof renderToString>[0]) =>
    renderToString(el).replace(/<!-- -->/g, "");

  it("the bar: summary, percent, a label naming what a tap does; nothing without tasks", () => {
    const out = html(
      createElement(EtaBar, {
        tasks: two,
        now: 5 * MIN,
        strings: CHAT_STRINGS_EN,
        onOpen: () => {},
        lang: "en",
      }),
    );
    expect(out).toContain('data-testid="debug-chat-eta-bar"');
    expect(out).toContain("2 tasks · 25m left · next in 5m");
    expect(out).toContain('data-pct="25"');
    expect(out).toContain(CHAT_STRINGS_EN.etaOpen);
    expect(out).toContain("<svg");
    expect(out).not.toMatch(/#[0-9a-f]{3,6}\b|rgb\(/i); // oklch only
    // No meter of its own: the line's background is filled to the progress point.
    expect(out).not.toContain("debug-chat-eta-meter");
    expect(out).toMatch(/data-testid="debug-chat-eta-fill" data-tone="fill"[^>]*width:25%/);
    expect(out).not.toContain("opacity");
    const past = html(
      createElement(EtaBar, {
        tasks: two,
        now: 40 * MIN,
        strings: CHAT_STRINGS_EN,
        onOpen: () => {},
      }),
    );
    expect(past).toContain("2 tasks · ETA reached");
    const done = html(
      createElement(EtaBar, {
        tasks: [task({ done: true, doneAt: 0 }), task({ id: "/b", done: true, doneAt: 0 })],
        now: 1000,
        strings: CHAT_STRINGS_EN,
        onOpen: () => {},
      }),
    );
    expect(done).toContain("2 tasks · done");
    expect(done).toContain('data-tone="done"');
    expect(past).toContain('data-tone="past"');
    expect(
      html(
        createElement(EtaBar, { tasks: [], now: 0, strings: CHAT_STRINGS_EN, onOpen: () => {} }),
      ),
    ).toBe("");
  });

  it("the list: one row per task with its state; nothing without tasks", () => {
    const out = html(
      createElement(EtaList, {
        tasks: [...two, task({ id: "/c", title: "C", done: true, doneAt: 12 * MIN - 1000 })],
        now: 12 * MIN,
        strings: CHAT_STRINGS_EN,
        lang: "en",
      }),
    );
    expect(out.match(/data-testid="debug-chat-eta-row"/g)?.length).toBe(3);
    expect(out).toContain('data-state="reached"');
    expect(out).toContain('data-state="running"');
    expect(out).toContain('data-state="done"');
    expect(out).toContain("18m left");
    expect(out.match(/data-testid="debug-chat-eta-fill"/g)?.length).toBe(3);
    // A "name: description" title: the name bold, the description muted.
    const row = html(
      createElement(EtaList, {
        tasks: [task({ id: "/d", title: "Box ETA: on the box", at: 30 * MIN })],
        now: MIN,
        strings: CHAT_STRINGS_EN,
      }),
    );
    expect(row).toMatch(/<span class="font-semibold">Box ETA<\/span>/);
    expect(row).toMatch(/data-testid="debug-chat-eta-desc"[^>]*> on the box</);
    // The bar shows the name only.
    const one = html(
      createElement(EtaBar, {
        tasks: [task({ id: "/d", title: "Box ETA: on the box", at: 30 * MIN })],
        now: MIN,
        strings: CHAT_STRINGS_EN,
        onOpen: () => {},
        lang: "en",
      }),
    );
    expect(one).toContain("Box ETA · 29m left");
    expect(one).not.toContain("on the box");
    expect(out).not.toContain("debug-chat-eta-meter");
    expect(out).toContain(CHAT_STRINGS_EN.etaList);
    expect(html(createElement(EtaList, { tasks: [], now: 0, strings: CHAT_STRINGS_EN }))).toBe("");
    expect(html(createElement(EtaClockIcon, { size: 10 }))).toContain('width="10"');
    expect(taskState(task({ done: true }), 0, CHAT_STRINGS_EN)).toBe("done");
    let kept = false;
    keepFocus({ preventDefault: () => (kept = true) });
    expect(kept).toBe(true);
  });
});

describe("task titles: name, then description", () => {
  it("splits at the first ASCII or full-width colon; no colon is all name", () => {
    expect(splitTitle("Box ETA: the bar on my-snomiao")).toEqual({
      name: "Box ETA",
      desc: "the bar on my-snomiao",
    });
    expect(splitTitle("盒子进度条：在盒子上显示")).toEqual({
      name: "盒子进度条",
      desc: "在盒子上显示",
    });
    expect(splitTitle("a: b: c")).toEqual({ name: "a", desc: "b: c" });
    expect(splitTitle("  Native swipe ")).toEqual({ name: "Native swipe", desc: "" });
    expect(splitTitle(": only a description")).toEqual({ name: "only a description", desc: "" });
  });
});

describe("the minimized line: the nearest task and the last, in minutes", () => {
  const T = [
    task({ id: "/box", title: "Box: the whole thing", start: 0, at: 40 * MIN }),
    task({ id: "/box/eta", title: "ETA bar: on the box", start: 0, at: 5 * MIN }),
    task({ id: "/box/docs", title: "Docs", start: 0, at: 12 * MIN }),
    task({ id: "/old", title: "Old", at: 1 * MIN, done: true, doneAt: 0 }),
  ];
  it("small: the soonest open leaf; big: the open task due last", () => {
    const e = etaEnds(T)!;
    expect(e.small?.id).toBe("/box/eta");
    expect(e.big.id).toBe("/box");
    // An open parent due sooner than its child is not a leaf.
    const p = etaEnds([
      task({ id: "/w", at: 2 * MIN }),
      task({ id: "/w/x", at: 9 * MIN }),
      task({ id: "/z", at: 9 * MIN }),
    ])!;
    expect(p.small?.id).toBe("/w/x");
    // A tie for last: the shallower.
    expect(p.big.id).toBe("/z");
    expect(etaEnds([task({ id: "/one" })])).toEqual({ big: task({ id: "/one" }) });
    expect(etaEnds([task({ done: true })])).toBeNull();
    expect(etaEnds([])).toBeNull();
  });
  it("the two numbers are whole minutes from now, rounded up; names only", () => {
    const parts = etaParts(T, 2 * MIN + 1000, CHAT_STRINGS_EN.etaMinutes)!;
    expect(parts).toEqual([
      { name: "ETA bar", min: "3 min" },
      { name: "Box", min: "38 min" },
    ]);
    expect(etaPartsText(parts)).toBe("ETA bar 3 min · Box 38 min");
    // Past due: 0, never negative.
    expect(etaParts([task({ at: MIN })], 5 * MIN, "{n} 分钟")).toEqual([
      { name: "A", min: "0 分钟" },
    ]);
    expect(etaParts([], 0, "{n} min")).toBeNull();
  });
});

describe("the line's fill keeps its text readable", () => {
  const lum = (css: string) => {
    const m = /^oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)$/.exec(css);
    if (!m) throw new Error(`not an opaque oklch(): ${css}`);
    return oklchLuminance(Number(m[1]), Number(m[2]), Number(m[3]));
  };
  for (const theme of ["light", "dark"] as const)
    it(`${theme}: the text is AA (4.5:1) on the track and on every fill`, () => {
      const c = ETA_COLORS[theme];
      for (const bg of [c.track, c.fill, c.past, c.done]) {
        expect(contrastRatio(lum(c.text), lum(bg))).toBeGreaterThanOrEqual(4.5);
        // A row's description, muted, too.
        expect(contrastRatio(lum(c.muted), lum(bg))).toBeGreaterThanOrEqual(4.5);
      }
      // The fill still shows against the track.
      for (const bg of [c.fill, c.past, c.done])
        expect(contrastRatio(lum(c.track), lum(bg))).toBeGreaterThanOrEqual(1.2);
    });
});

describe('the page\'s {type:"eta"} on the progress socket', () => {
  it("goes out on an open socket of the live source; false with none", () => {
    const sent: string[] = [];
    const socks: Record<string, any>[] = [];
    const src = liveTreeSource({
      base: () => "# t\n",
      url: "wss://h/p",
      socket: () => {
        const s = {
          onopen: null,
          onmessage: null,
          onclose: null,
          onerror: null,
          readyState: 1,
          close() {},
          send: (d: string) => sent.push(d),
        };
        socks.push(s);
        return s as never;
      },
      setTimeout: () => 0,
      clearTimeout: () => {},
      onWake: () => () => {},
    });
    const off = src.subscribe(() => {});
    expect(src.send({ type: "eta", id: "/a" })).toBe(false); // not open yet
    socks[0]!.onopen({});
    expect(src.send({ type: "eta", id: "/a" })).toBe(true);
    expect(sent).toEqual([JSON.stringify({ type: "eta", id: "/a" })]);
    socks[0]!.readyState = 3;
    expect(src.send({ type: "eta", id: "/a" })).toBe(false);
    socks[0]!.readyState = 1;
    socks[0]!.send = () => {
      throw new Error("closed");
    };
    expect(src.send({ type: "eta", id: "/a" })).toBe(false);
    socks[0]!.onclose({});
    expect(src.send({ type: "eta", id: "/a" })).toBe(false);
    off();
  });
});
