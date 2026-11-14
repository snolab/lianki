import { afterAll, describe, expect, it } from "bun:test";
import { stubGlobals } from "./support/globals";
import {
  ETA_GIVE_UP_MS,
  ETA_RETRY_MS,
  PROGRESS_OWNER_HEADER,
  ProgressHub,
} from "@/workers/push/src/progress";
import type { Socket, Storage } from "@/workers/push/src/debug";
import { type ProgressEntry, mergeProgress, parseEta, parseProgressReport } from "@/lib/progress";
import { liveTreeSource, overlayProgress } from "@/lib/progress-tree";
import { ETA_EXPLAIN_MS, ETA_PATH, etaLineText, parseEtaPing } from "@/lib/eta-ping";
import { FLAGS } from "@/lib/flags";
import {
  OWNER_WAIT_REMIND_DEFAULT,
  OWNER_WAIT_REMIND_KEY,
  parseRemindDays,
  remindDelayMs,
} from "@/lib/owner-wait";
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
  compactTime,
  ganttPlan,
  ganttRow,
  ganttWindow,
  splitTitle,
  taskFraction,
} from "@lianki/debug-chat/eta";
import {
  ETA_COLORS,
  ETA_SHIMMER_CSS,
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
afterAll(
  stubGlobals({
    WebSocketPair: class {
      0 = new FakeSocket();
      1 = new FakeSocket();
    },
  }),
);

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
function setup(
  answer: () => Response | Promise<Response> = () => Response.json({ ok: true }),
  sessions?: { config?(key: string): Promise<unknown> },
) {
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
    { PROGRESS_TOKEN: ROOT, DEBUG, ...(sessions ? { SESSIONS: sessions } : {}) },
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
      {
        id: "/words/swipe",
        title: "Native swipe",
        etaAt: at,
        assignee: "a1",
        code: expect.stringMatching(/^[a-z0-9]{6}$/),
        ackMin: 5,
        ownerMin: 5,
      },
    ]);
    expect(h.entry("/words/swipe")?.etaCode).toBe(h.pings[0]!.code as string);
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
    await h.write({ id: "/words/swipe", eta: "20m", late: "review took longer" });
    // The alarm set for the silent check goes off first, finds it explained, waits for the new ETA.
    h.tick(ETA_EXPLAIN_MS);
    await h.hub.alarm();
    expect(h.storage.alarm).toBe(h.now() + 15 * MIN);
    h.tick(15 * MIN);
    await h.hub.alarm();
    // due, late (the owner's line), due again.
    expect(h.pings.map((p) => p.kind ?? "due")).toEqual(["due", "late", "due"]);
    await h.write({ id: "/x/done", eta: "1m" });
    await h.write({ id: "/x/done", status: "done" });
    h.tick(2 * MIN);
    await h.hub.alarm();
    expect(h.pings.filter((p) => p.id === "/x/done")).toEqual([]);
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
    expect(h.pings.filter((p) => p.id === "/late")).toEqual([]);
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

describe("ETA overrun: the reason and a new ETA, or the owner is told", () => {
  it("past its ETA, a new estimate without --late is refused; with it, the owner hears both", async () => {
    const h = setup();
    await h.write({ id: "/words/swipe", eta: "5m" });
    // Before the ETA: revising needs no reason.
    expect((await h.write({ id: "/words/swipe", eta: "6m" })).status).toBe(200);
    h.tick(6 * MIN);
    await h.hub.alarm();
    const refused = await h.write({ id: "/words/swipe", eta: "20m" });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toContain("--late");
    // Free text is a new estimate too.
    expect((await h.write({ id: "/words/swipe", eta: "after CI" })).status).toBe(400);
    // Progress without a new estimate, and done, still go through.
    expect((await h.write({ id: "/words/swipe", pct: 80 })).status).toBe(200);
    const ok = await h.write({ id: "/words/swipe", eta: "20m", late: "CI 排队" });
    expect(ok.status).toBe(200);
    expect(ok.body.told).toBe(true);
    expect(ok.body.entry).toMatchObject({ lateReason: "CI 排队", etaAt: h.now() + 20 * MIN });
    expect(h.pings.at(-1)).toMatchObject({
      kind: "late",
      reason: "CI 排队",
      id: "/words/swipe",
      etaAt: h.now() + 20 * MIN,
    });
    expect(h.entry("/words/swipe")?.notes?.at(-1)?.text).toBe("late: CI 排队");
    // Explained: no "未说明原因" later.
    h.tick(ETA_EXPLAIN_MS + MIN);
    await h.hub.alarm();
    expect(h.pings.filter((p) => p.kind === "silent")).toEqual([]);
  });

  it("no ack: the coordinating lane at 5 min; no reason and no new ETA: the owner at 10", async () => {
    const h = setup();
    await h.write({ id: "/words/swipe", eta: "5m" });
    h.tick(5 * MIN);
    await h.hub.alarm();
    expect(h.pings.length).toBe(1);
    expect(h.storage.alarm).toBe(h.entry("/words/swipe")!.etaAt! + ETA_EXPLAIN_MS);
    h.tick(ETA_EXPLAIN_MS - 1000);
    await h.hub.alarm();
    expect(h.pings.length).toBe(1);
    h.tick(1000);
    await h.hub.alarm();
    expect(h.pings.at(-1)).toMatchObject({ kind: "main", lane: "main", id: "/words/swipe" });
    expect(h.pings.at(-1)!.code).toBe(h.pings[0]!.code as string);
    h.tick(5 * MIN);
    await h.hub.alarm();
    expect(h.pings.at(-1)).toMatchObject({ kind: "silent", id: "/words/swipe" });
    expect(h.pings.at(-1)).not.toHaveProperty("n");
    expect(h.entry("/words/swipe")?.etaSilent).toBe(h.entry("/words/swipe")?.etaAt);
    await h.hub.alarm();
    expect(h.pings.length).toBe(3);
    // A task done in the window is never reported.
    await h.write({ id: "/b", eta: "1m" });
    h.tick(MIN);
    await h.hub.alarm();
    await h.write({ id: "/b", status: "done" });
    h.tick(ETA_EXPLAIN_MS);
    await h.hub.alarm();
    expect(h.pings.filter((p) => p.id === "/b").map((p) => p.kind ?? "due")).toEqual(["due"]);
  });

  it("a page's timer delivers the due line; the silent check is armed all the same", async () => {
    const h = setup();
    await h.write({ id: "/words/swipe", eta: "5m" });
    const p = await h.page();
    h.tick(5 * MIN);
    await h.hub.webSocketMessage(p, JSON.stringify({ type: "eta", id: "/words/swipe" }));
    expect(h.storage.alarm).toBe(h.entry("/words/swipe")!.etaAt! + ETA_EXPLAIN_MS);
  });

  it("the CLI: --late goes with a new --eta, never alone", () => {
    const base = ["--agent", "a", "--task", "t", "--status", "doing"];
    expect(parseProgressArgs([...base, "--eta", "20m", "--late", "slow CI"])).toMatchObject({
      report: { late: "slow CI", etaIn: 20 * MIN },
    });
    expect(parseProgressArgs([...base, "--late", "slow CI"])).toBeInstanceOf(Error);
    expect(parseProgressArgs([...base, "--eta", "after CI", "--late", "x"])).toBeInstanceOf(Error);
  });
});

describe("waiting on the owner: one reminder with the reason, then spaced ones", () => {
  const DAY = 24 * 60 * MIN;
  const kinds = (h: ReturnType<typeof setup>, id: string) =>
    h.pings.filter((p) => p.id === id).map((p) => p.kind ?? "due");

  it("the reminder carries the reason, never the lane prompt or 未说明原因; then 1, 3, 7, 7 days", async () => {
    const h = setup();
    await h.write({
      id: "/x/approve",
      status: "waiting-owner",
      needs: "批准 DNS 改动",
      task: "DNS 切换: move the apex",
      eta: "5m",
    });
    h.tick(5 * MIN);
    await h.hub.alarm();
    expect(h.pings).toEqual([
      expect.objectContaining({ id: "/x/approve", kind: "waiting", reason: "批准 DNS 改动" }),
    ]);
    expect(etaLineText(h.pings[0] as never)).toBe("DNS 切换：在等你——批准 DNS 改动");
    const etaAt = h.entry("/x/approve")!.etaAt!;
    expect(h.entry("/x/approve")).toMatchObject({ etaSent: etaAt, etaSilent: etaAt, remindN: 1 });
    expect(h.storage.alarm).toBe(h.now() + DAY);
    // No "silent" five minutes later, nothing within the day.
    h.tick(ETA_EXPLAIN_MS + MIN);
    await h.hub.alarm();
    h.tick(DAY - ETA_EXPLAIN_MS - 2 * MIN);
    await h.hub.alarm();
    expect(kinds(h, "/x/approve")).toEqual(["waiting"]);
    let at = h.entry("/x/approve")!.remindAt!;
    for (const [n, gap] of [
      [2, 3],
      [3, 7],
      [4, 7],
      [5, 7],
    ] as const) {
      h.tick(at - h.now());
      await h.hub.alarm();
      expect(kinds(h, "/x/approve").length).toBe(n);
      at = h.entry("/x/approve")!.remindAt!;
      expect(at).toBe(h.now() + gap * DAY);
      expect(h.storage.alarm).toBe(at);
    }
    expect(new Set(kinds(h, "/x/approve"))).toEqual(new Set(["waiting"]));
  });

  it("a new estimate needs no --late; done, or no longer waiting, stops the reminders", async () => {
    const h = setup();
    await h.write({ id: "/x/a", status: "waiting-owner", needs: "看一下", eta: "5m" });
    h.tick(6 * MIN);
    await h.hub.alarm();
    // Past its ETA, still waiting: a new time goes through without a reason.
    const moved = await h.write({ id: "/x/a", status: "waiting-owner", eta: "2h" });
    expect(moved.status).toBe(200);
    expect(moved.body.told).toBeUndefined();
    expect((await h.write({ id: "/x/a", status: "waiting-owner", confirm: true })).status).toBe(
      200,
    );
    // Back to the lane's own work (needs cleared): no reminder, and nothing "silent" for it.
    await h.write({ id: "/x/a", status: "doing", needs: "" });
    h.tick(10 * DAY);
    await h.hub.alarm();
    expect(kinds(h, "/x/a")).toEqual(["waiting"]);
    // A done one, and one the owner resolves, hear nothing more.
    await h.write({ id: "/x/b", status: "waiting-owner", needs: "选一个", eta: "1m" });
    await h.write({ id: "/x/c", needs: "点批准", eta: "1m" });
    h.tick(MIN);
    await h.hub.alarm();
    await h.write({ id: "/x/b", status: "done" });
    await h.hub.resolve("/x/c");
    h.tick(30 * DAY);
    await h.hub.alarm();
    expect(kinds(h, "/x/b")).toEqual(["waiting"]);
    expect(kinds(h, "/x/c")).toEqual(["waiting"]);
  });

  it("the lane's own late work keeps its rules", async () => {
    const h = setup();
    await h.write({ id: "/x/work", eta: "5m" });
    h.tick(5 * MIN);
    await h.hub.alarm();
    expect((await h.write({ id: "/x/work", eta: "20m" })).status).toBe(400);
    h.tick(10 * MIN);
    await h.hub.alarm();
    await h.hub.alarm();
    // A refused write is no report: no ack, so the coordinating lane first, then the owner.
    expect(kinds(h, "/x/work")).toEqual(["due", "main", "silent"]);
  });

  it("a lane that hands its overrun to the owner: his reminder at once, no 未说明原因", async () => {
    const h = setup();
    await h.write({ id: "/x/d", eta: "5m" });
    h.tick(5 * MIN);
    await h.hub.alarm();
    await h.write({ id: "/x/d", status: "waiting-owner", needs: "要你的 token 授权" });
    await h.hub.alarm();
    h.tick(ETA_EXPLAIN_MS);
    await h.hub.alarm();
    expect(kinds(h, "/x/d")).toEqual(["due", "waiting"]);
    expect(h.pings.at(-1)).toMatchObject({ reason: "要你的 token 授权" });
  });

  it("the spacing is a config value, read live, with the default when unreadable", async () => {
    expect(parseRemindDays(OWNER_WAIT_REMIND_DEFAULT)).toEqual([1, 3, 7]);
    expect(parseRemindDays("2, 5")).toEqual([2, 5]);
    expect(parseRemindDays("0,3")).toEqual([1, 3, 7]);
    expect(parseRemindDays("weekly")).toEqual([1, 3, 7]);
    expect(remindDelayMs([2, 5], 1)).toBe(2 * DAY);
    expect(remindDelayMs([2, 5], 9)).toBe(5 * DAY);
    const h = setup(undefined, { config: async (k) => (k === OWNER_WAIT_REMIND_KEY ? "2" : 0) });
    await h.write({ id: "/x/e", status: "waiting-owner", eta: "1m" });
    h.tick(MIN);
    await h.hub.alarm();
    expect(etaLineText(h.pings[0] as never)).toBe("Native swipe：在等你");
    expect(h.entry("/x/e")!.remindAt).toBe(h.now() + 2 * DAY);
    const broken = setup(undefined, {
      config: async () => {
        throw new Error("d1 down");
      },
    });
    await broken.write({ id: "/x/f", status: "waiting-owner", eta: "1m" });
    broken.tick(MIN);
    await broken.hub.alarm();
    expect(broken.entry("/x/f")!.remindAt).toBe(broken.now() + DAY);
  });

  it("a node pinged before reminders existed: its reminders start a day out, no line now", async () => {
    const h = setup();
    await h.write({ id: "/x/old", status: "waiting-owner", needs: "看", eta: "1m" });
    const e = h.entry("/x/old")!;
    // As the old hub left it: pinged, nothing more.
    h.storage.store.set("e:/x/old", { ...e, etaSent: e.etaAt });
    h.tick(2 * MIN);
    await h.hub.alarm();
    expect(h.pings).toEqual([]);
    expect(h.entry("/x/old")).toMatchObject({ remindN: 1, remindAt: h.now() + DAY });
    h.tick(DAY);
    await h.hub.alarm();
    expect(kinds(h, "/x/old")).toEqual(["waiting"]);
  });

  it("the chat hub could not take it: put back and tried again", async () => {
    let ok = false;
    const h = setup(() =>
      ok ? Response.json({ ok: true }) : new Response("busy", { status: 503 }),
    );
    await h.write({ id: "/x/g", status: "waiting-owner", needs: "看", eta: "1m" });
    h.tick(MIN);
    await h.hub.alarm();
    expect(h.entry("/x/g")!.remindN).toBeUndefined();
    expect(h.storage.alarm).toBe(h.now() + ETA_RETRY_MS);
    ok = true;
    h.tick(ETA_RETRY_MS);
    await h.hub.alarm();
    expect(h.entry("/x/g")!.remindN).toBe(1);
    expect(kinds(h, "/x/g")).toEqual(["waiting", "waiting"]);
  });
});

describe("the ETA line as the agents read it", () => {
  it("says what it is and is marked automatic in eval.ts chat output", () => {
    const due = etaLineText({
      id: "/words/swipe",
      title: "Native swipe: drag it",
      etaAt: 0,
      assignee: "swipe-agent",
    });
    expect(due).toContain("ETA reached for Native swipe: drag it (/words/swipe)");
    expect(due).toContain("--agent swipe-agent --path /words/swipe");
    expect(due).toContain('--eta <N>m --late "');
    expect(due).toContain('"Native swipe 超时，未说明原因"');
    expect(etaLineText({ id: "/a", title: "Box: x", etaAt: 0, kind: "silent" })).toBe(
      "Box 超时，未说明原因",
    );
    expect(
      etaLineText({ id: "/a", title: "Box: x", etaAt: 20 * MIN, kind: "late", reason: "CI" }, 1),
    ).toBe("Box 超时：CI。再要 20 分钟");
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
    expect(summaryText(tasks, 5 * MIN, CHAT_STRINGS_EN)).toBe("2 tasks · 25M · next in 5M");
    expect(summaryText([tasks[0]!], 5 * MIN, CHAT_STRINGS_EN)).toBe("A · 5M");
    expect(summaryText([tasks[0]!], 11 * MIN, CHAT_STRINGS_EN)).toBe("A · -1M");
    expect(taskFraction(tasks[0]!, 20 * MIN)).toBe(1);
  });

  it("a done task counts as full, then leaves after a moment", () => {
    const done = task({ done: true, doneAt: 4 * MIN });
    expect(etaSummary([done], 4 * MIN + 1).count).toBe(1);
    expect(etaSummary([done], 4 * MIN + LINGER_MS).count).toBe(0);
  });

  it("one compact, language-neutral time format: <n>M under an hour, decimal H from it, minus past due", () => {
    expect(compactTime(30_000)).toBe("1M");
    expect(compactTime(5 * MIN)).toBe("5M");
    expect(compactTime(40 * MIN)).toBe("40M");
    expect(compactTime(59 * MIN + 30_000)).toBe("1H");
    expect(compactTime(60 * MIN)).toBe("1H");
    expect(compactTime(80 * MIN)).toBe("1.3H"); // not "1h20m"
    expect(compactTime(89 * MIN)).toBe("1.5H");
    expect(compactTime(120 * MIN)).toBe("2H");
    expect(compactTime(150 * MIN)).toBe("2.5H");
    // From a day the larger units (owner, 2026-11-10): one formatter with the Gantt.
    expect(compactTime(27 * 60 * MIN)).toBe("1.1D");
    expect(compactTime(0)).toBe("0M");
    // Past due: negative, the same form.
    expect(compactTime(-5 * MIN)).toBe("-5M");
    expect(compactTime(-30_000)).toBe("-1M");
    expect(compactTime(-89 * MIN)).toBe("-1.5H");
    expect(compactTime(-120 * MIN)).toBe("-2H");
  });

  it("wakes at the next label change or estimate; past due, at the next whole minute over", () => {
    expect(nextWake([task({ at: 10 * MIN })], 0)).toBe(MIN);
    expect(nextWake([task({ at: 10 * MIN })], 9 * MIN + 30_000)).toBe(10 * MIN);
    // "-1M" turns "-2M" right after 11 min.
    expect(nextWake([task({ at: 10 * MIN })], 11 * MIN)).toBe(11 * MIN + 1);
    expect(nextWake([task({ at: 10 * MIN, done: true })], 11 * MIN)).toBeNull();
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
    // Past due, the label counts on: "0M" turns "-1M" at once.
    expect(c.pending()).toEqual([90_001]);
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
    // Armed only for the labels counting on ("-10M" → "-11M"), never to report again.
    expect(clock.armed()).toBe(true);
    c.advance(5 * MIN);
    expect(due).toEqual(["/a"]);
    clock.stop();
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
      }),
    );
    expect(out).toContain('data-testid="debug-chat-eta-bar"');
    expect(out).toContain('aria-label="2 tasks · 25M · next in 5M · 25%');
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
    expect(past).toContain('aria-label="2 tasks · -10M');
    // A negative time is red.
    expect(past).toMatch(
      /data-testid="debug-chat-eta-time" data-late="true"[^>]*color:light-dark\(oklch\(0.47 0.17 27\)/,
    );
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

  it("in progress the fill shimmers (off under reduced motion); done it is still; glass drops the track", () => {
    const running = html(
      createElement(EtaBar, {
        tasks: two,
        now: 5 * MIN,
        strings: CHAT_STRINGS_EN,
        onOpen: () => {},
      }),
    );
    expect(running).toContain('data-testid="debug-chat-eta-shimmer"');
    expect(ETA_SHIMMER_CSS).toContain("prefers-reduced-motion: reduce");
    expect(ETA_SHIMMER_CSS).toContain("[data-eta-shimmer]{display:none}");
    const done = html(
      createElement(EtaBar, {
        tasks: [task({ done: true, doneAt: 0 })],
        now: 1000,
        strings: CHAT_STRINGS_EN,
        onOpen: () => {},
      }),
    );
    expect(done).not.toContain("debug-chat-eta-shimmer");
    const glass = html(
      createElement(EtaBar, {
        tasks: two,
        now: 5 * MIN,
        strings: CHAT_STRINGS_EN,
        onOpen: () => {},
        glass: true,
      }),
    );
    expect(glass).toContain("background:transparent");
    expect(glass).not.toContain("mb-1");
    expect(running).toContain("mb-1");
    expect(running + glass).not.toMatch(/#[0-9a-f]{3,6}\b|rgb\(/i); // oklch only
  });

  it("the list: with no categories, one row per task with its state; nothing without tasks", () => {
    const out = html(
      createElement(EtaList, {
        tasks: [...two, task({ id: "/c", title: "C", done: true, doneAt: 12 * MIN - 1000 })],
        now: 12 * MIN,
        strings: CHAT_STRINGS_EN,
        groups: [],
      }),
    );
    expect(out.match(/data-testid="debug-chat-eta-row"/g)?.length).toBe(3);
    expect(out).toContain('data-state="reached"');
    expect(out).toContain('data-state="running"');
    expect(out).toContain('data-state="done"');
    // No duration numbers but the time left: "18M", and "-2M" (red) for the one past due.
    expect(out).toContain(">18M<");
    expect(out).toMatch(/data-late="true"[^>]*>-2M</);
    expect(out.replace(/<[^>]*>/g, " ")).not.toMatch(/\d+m left|\d ?min\b/);
    // Each row is a Gantt bar on the shared axis, with the red Now line and its label.
    expect(out.match(/data-testid="debug-chat-eta-span"/g)?.length).toBe(3);
    expect(out).toContain('data-testid="debug-chat-eta-over"');
    expect(out).toContain('data-testid="debug-chat-eta-now-label"');
    expect(out).toContain(">Now<");
    expect(out).not.toMatch(/#[0-9a-f]{3,6}\b|rgb\(/i);
    // A "name: description" title: the name bold, the description muted.
    const row = html(
      createElement(EtaList, {
        tasks: [task({ id: "/d", title: "Box ETA: on the box", at: 30 * MIN })],
        now: MIN,
        strings: CHAT_STRINGS_EN,
        groups: [],
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
      }),
    );
    expect(one).toContain('aria-label="Box ETA · 29M');
    expect(one).not.toContain("on the box");
    expect(out).not.toContain("debug-chat-eta-meter");
    expect(out).toContain(CHAT_STRINGS_EN.etaList);
    expect(html(createElement(EtaList, { tasks: [], now: 0, strings: CHAT_STRINGS_EN }))).toBe("");
    // Without onExpand no expand button; with it, one that opens the full-screen Gantt.
    expect(out).not.toContain("debug-chat-eta-expand");
    const ex = html(
      createElement(EtaList, {
        tasks: two,
        now: MIN,
        strings: CHAT_STRINGS_EN,
        onExpand: () => {},
      }),
    );
    expect(ex).toContain('data-testid="debug-chat-eta-expand"');
    expect(ex).toContain(`aria-label="${CHAT_STRINGS_EN.etaOpen}"`);
    expect(html(createElement(EtaClockIcon, { size: 10 }))).toContain('width="10"');
    expect(taskState(task({ done: true }), 0, CHAT_STRINGS_EN)).toBe("done");
    expect(taskState(task({ at: 0 }), 5 * MIN, CHAT_STRINGS_EN)).toBe("-5M");
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
    const parts = etaParts(T, 2 * MIN + 1000)!;
    expect(parts).toEqual([
      { name: "ETA bar", min: "3M" },
      { name: "Box", min: "38M" },
    ]);
    expect(etaPartsText(parts)).toBe("ETA bar 3M · Box 38M");
    // Past due: negative, marked late (red).
    expect(etaParts([task({ at: MIN })], 5 * MIN)).toEqual([{ name: "A", min: "-4M", late: true }]);
    expect(etaParts([task({ at: 100 * MIN })], 10 * MIN)).toEqual([{ name: "A", min: "1.5H" }]);
    expect(etaParts([], 0)).toBeNull();
  });
});

describe("the bar's hide/show toggle (EtaFold)", () => {
  const two = [task({ id: "/a", at: 10 * MIN }), task({ id: "/b", title: "B", at: 30 * MIN })];
  const html = (el: Parameters<typeof renderToString>[0]) =>
    renderToString(el).replace(/<!-- -->/g, "");
  const bar = (folded: boolean) =>
    html(
      createElement(EtaBar, {
        tasks: two,
        now: 5 * MIN,
        strings: CHAT_STRINGS_EN,
        onOpen: () => {},
        folded,
        onFold: () => {},
      }),
    );

  it("shown: the line and a ▾ that says it hides the bar", () => {
    const out = bar(false);
    expect(out).toContain('data-testid="debug-chat-eta-bar"');
    expect(out).toMatch(/data-testid="debug-chat-eta-fold"[^>]*aria-expanded="true"/);
    expect(out).toContain(`aria-label="${CHAT_STRINGS_EN.etaHide}"`);
    expect(out).toContain('data-open="true"');
  });

  it("hidden: no line, only the ▸ with the clock, which says it shows the bar again", () => {
    const out = bar(true);
    expect(out).not.toContain('data-testid="debug-chat-eta-bar"');
    expect(out).toMatch(/data-testid="debug-chat-eta-fold"[^>]*data-folded="true"/);
    expect(out).toContain('aria-expanded="false"');
    expect(out).toContain(`aria-label="${CHAT_STRINGS_EN.etaShow}"`);
    expect(out).toContain('data-open="false"');
    expect(out).not.toMatch(/#[0-9a-f]{3,6}\b|rgb\(/i); // oklch only
  });

  it("no tasks: nothing, folded or not; without onFold, no toggle", () => {
    const none = (folded: boolean) =>
      html(
        createElement(EtaBar, {
          tasks: [],
          now: 0,
          strings: CHAT_STRINGS_EN,
          onOpen: () => {},
          folded,
          onFold: () => {},
        }),
      );
    expect(none(true)).toBe("");
    expect(none(false)).toBe("");
    const plain = html(
      createElement(EtaBar, {
        tasks: two,
        now: 5 * MIN,
        strings: CHAT_STRINGS_EN,
        onOpen: () => {},
      }),
    );
    expect(plain).not.toContain("debug-chat-eta-fold");
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
      for (const bg of [c.track, c.bar, c.fill, c.past, c.done]) {
        expect(contrastRatio(lum(c.text), lum(bg))).toBeGreaterThanOrEqual(4.5);
        // A row's description, muted, too.
        expect(contrastRatio(lum(c.muted), lum(bg))).toBeGreaterThanOrEqual(4.5);
        // A negative time, and the red Now line and its label, on every part of a row.
        expect(contrastRatio(lum(c.late), lum(bg))).toBeGreaterThanOrEqual(4.5);
      }
      // The bar shows against the track, the progress and the overrun against the bar.
      for (const bg of [c.bar, c.fill, c.past, c.done])
        expect(contrastRatio(lum(c.track), lum(bg))).toBeGreaterThanOrEqual(1.1);
      expect(contrastRatio(lum(c.bar), lum(c.fill))).toBeGreaterThanOrEqual(1.1);
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

describe("the Gantt list: one axis, queued tasks in line, Now clamped", () => {
  it("the axis runs from the earliest start to the latest end; it rescales with the tasks", () => {
    const a = task({ id: "/a", start: 10 * MIN, at: 30 * MIN });
    const b = task({ id: "/b", start: 20 * MIN, at: 50 * MIN });
    expect(ganttWindow([a, b], 25 * MIN)).toEqual({ lo: 10 * MIN, hi: 50 * MIN });
    // A done task ends when it finished.
    const c = task({ id: "/c", start: 0, at: 40 * MIN, done: true, doneAt: 60 * MIN });
    expect(ganttWindow([a, c], 60 * MIN)).toEqual({ lo: 0, hi: 60 * MIN });
    expect(ganttWindow([a], 25 * MIN)).toEqual({ lo: 10 * MIN, hi: 30 * MIN });
    expect(ganttWindow([], 0)).toBeNull();
  });

  it("a row: offset by its start, as long as its estimate, pct a deeper fill, overrun to now", () => {
    const w = { lo: 0, hi: 100 * MIN };
    expect(ganttRow(task({ start: 20 * MIN, at: 60 * MIN, pct: 50 }), w, 40 * MIN)).toEqual({
      left: 20,
      plan: 40,
      fill: 50,
      over: 0,
      now: 40,
    });
    // Past its estimate: the overrun runs on to now.
    expect(ganttRow(task({ start: 0, at: 50 * MIN }), w, 70 * MIN)).toMatchObject({
      plan: 50,
      over: 20,
      fill: 0,
    });
    expect(ganttRow(task({ done: true, doneAt: 10 * MIN }), w, 70 * MIN).fill).toBe(100);
  });

  it("now outside the range is clamped to an edge", () => {
    const w = { lo: 10 * MIN, hi: 20 * MIN };
    expect(ganttRow(task({}), w, 0).now).toBe(0);
    expect(ganttRow(task({}), w, 30 * MIN).now).toBe(100);
    expect(ganttRow(task({}), w, 15 * MIN).now).toBe(50);
  });

  it("running tasks overlap; queued ones start one after another, in order of creation", () => {
    const run1 = task({ id: "/r1", start: 0, at: 20 * MIN });
    const run2 = task({ id: "/r2", start: 5 * MIN, at: 30 * MIN });
    const q2 = task({ id: "/q2", queued: true, created: 2, queuedMs: 15 * MIN, start: 1, at: 99 });
    const q1 = task({ id: "/q1", queued: true, created: 1, queuedMs: 10 * MIN, start: 1, at: 99 });
    const plan = ganttPlan([run1, run2, q2, q1], 10 * MIN);
    const at = (id: string) => plan.find((t) => t.id === id)!;
    // Running: as they are.
    expect(at("/r1")).toEqual(run1);
    expect(at("/r2")).toEqual(run2);
    // The first queued starts when the soonest running one is due; the next after it.
    expect([at("/q1").start, at("/q1").at]).toEqual([20 * MIN, 30 * MIN]);
    expect([at("/q2").start, at("/q2").at]).toEqual([30 * MIN, 45 * MIN]);
    // The axis reaches the queue's computed end.
    expect(ganttWindow(plan, 10 * MIN)).toEqual({ lo: 0, hi: 45 * MIN });
    // Nothing running, or its estimate past: the queue starts now.
    const alone = ganttPlan([q1], 10 * MIN);
    expect([alone[0]!.start, alone[0]!.at]).toEqual([10 * MIN, 20 * MIN]);
    const late = ganttPlan([task({ id: "/r", at: 5 * MIN }), q1], 10 * MIN);
    expect(late[1]!.start).toBe(10 * MIN);
  });

  it("the tree marks a waiting task queued, with its estimate as posted", () => {
    const root = overlayProgress({ title: "", links: [], children: [] }, [
      {
        id: "/q",
        assignee: { type: "agent", name: "a" },
        task: "q",
        status: "waiting",
        kind: "task",
        creator: "a",
        by: "a",
        rev: 1,
        created: 5,
        at: 1000,
        etaAt: 1000 + 20 * MIN,
        startedAt: 500,
        pct: 30,
      } as ProgressEntry,
    ]);
    expect(etaTasks(root)[0]).toMatchObject({
      queued: true,
      created: 5,
      queuedMs: 20 * MIN,
      start: 500,
      pct: 30,
    });
  });
});
