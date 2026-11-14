/**
 * The ETA history (docs/state-tree.md, "ETA history"): events per node,
 * confirms, one change id per action, P5–P95 ranges with overdue at the P95.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { stubGlobals } from "./support/globals";
import {
  CHANGE_ID_WINDOW_MS,
  PROGRESS_OWNER_HEADER,
  ProgressHub,
} from "@/workers/push/src/progress";
import type { Socket, Storage } from "@/workers/push/src/debug";
import {
  PROGRESS_ETA_EVENTS_MAX,
  type ProgressEntry,
  mergeProgress,
  parseEta,
  parseProgressReport,
} from "@/lib/progress";
import { parseBatchItems, parseProgressArgs } from "@/scripts/dev/progress-args";

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

function setup() {
  let t = 1_000_000;
  const sockets: FakeSocket[] = [];
  const storage = fakeStorage();
  const pings: Record<string, unknown>[] = [];
  const DEBUG = {
    idFromName: (n: string) => n,
    get: () => ({
      fetch: async (req: Request) => {
        pings.push((await req.json()) as Record<string, unknown>);
        return Response.json({ ok: true });
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
  const call = async (path: string, body?: unknown) => {
    const res = await hub.fetch(
      new Request(`https://lianki.com/api/version/progress${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { authorization: `Bearer ${ROOT}` },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  const write = (body: Record<string, unknown>) =>
    call("", { agent: "a1", status: "doing", task: "Swipe: drag", ...body });
  const entry = (id: string) => storage.store.get(`e:${id}`) as ProgressEntry | undefined;
  const page = async () => {
    await hub.fetch(
      new Request("https://lianki.com/api/version/progress", {
        headers: { upgrade: "websocket", [PROGRESS_OWNER_HEADER]: "1" },
      }),
    );
    return sockets.at(-1)!;
  };
  return {
    hub,
    call,
    write,
    entry,
    page,
    pings,
    storage,
    tick: (ms: number) => (t += ms),
    now: () => t,
  };
}

describe("ETA ranges (P5–P95)", () => {
  it("parses 12m-63m as P5 and P95; one number still works", () => {
    expect(parseEta("12m-63m")).toEqual({ in: 63 * MIN, min: 12 * MIN });
    expect(parseEta("12m–1h")).toEqual({ in: 60 * MIN, min: 12 * MIN });
    expect(parseEta("1h - 2h30m")).toEqual({ in: 150 * MIN, min: 60 * MIN });
    expect(parseEta("20m-20m")).toEqual({ in: 20 * MIN });
    expect(parseEta("15m")).toEqual({ in: 15 * MIN });
    expect(parseEta("63m-12m")).toBeNull(); // backwards
    expect(parseEta("after CI - soon")).toBeNull();
    expect(parseEta("2026-11-07T21:00+09:00")).toEqual({ at: Date.parse("2026-11-07T12:00Z") });
  });

  it("a report carries the P5 as etaMinIn; the hub sets etaMinAt and etaAt (the P95)", async () => {
    const r = parseProgressReport({ agent: "a", task: "t", status: "doing", eta: "12m-63m" });
    expect(r).toMatchObject({ etaIn: 63 * MIN, etaMinIn: 12 * MIN });
    const h = setup();
    await h.write({ id: "/x/a", eta: "12m-63m" });
    expect(h.entry("/x/a")).toMatchObject({
      etaMinAt: h.now() + 12 * MIN,
      etaAt: h.now() + 63 * MIN,
    });
    // One number again: the range goes.
    await h.write({ id: "/x/a", eta: "30m" });
    expect(h.entry("/x/a")?.etaMinAt).toBeUndefined();
    // A write without an estimate keeps it.
    await h.write({ id: "/x/a", eta: "10m-40m" });
    await h.write({ id: "/x/a", pct: 50 });
    expect(h.entry("/x/a")?.etaMinAt).toBe(h.now() + 10 * MIN);
  });

  it("overdue starts after the P95: no ping at the P5, one at the P95, and no --late needed between", async () => {
    const h = setup();
    await h.write({ id: "/x/a", eta: "12m-63m" });
    expect(h.storage.alarm).toBe(h.now() + 63 * MIN);
    h.tick(20 * MIN); // past the P5
    await h.hub.alarm();
    expect(h.pings).toEqual([]);
    // A new estimate between P5 and P95 is no overrun.
    expect((await h.write({ id: "/x/a", eta: "10m-43m" })).status).toBe(200);
    h.tick(43 * MIN);
    await h.hub.alarm();
    expect(h.pings.length).toBe(1);
    expect(h.pings[0]).toMatchObject({ id: "/x/a", etaAt: h.now() });
    // Past the P95: a new estimate needs the reason.
    expect((await h.write({ id: "/x/a", eta: "5m-20m" })).status).toBe(400);
    expect((await h.write({ id: "/x/a", eta: "5m-20m", late: "CI" })).status).toBe(200);
  });
});

describe("ETA events", () => {
  it("logs a change (old → new), a confirm and a status change, with etaConfirmedAt", async () => {
    const h = setup();
    const t0 = h.now();
    await h.write({ id: "/x/a", eta: "30m" });
    h.tick(5 * MIN);
    await h.write({ id: "/x/a", eta: "10m-40m" });
    h.tick(5 * MIN);
    await h.write({ id: "/x/a", confirm: true });
    h.tick(MIN);
    await h.write({ id: "/x/a", status: "review", pct: 90 });
    const e = h.entry("/x/a")!;
    expect(e.etaEvents!.map((v) => v.kind)).toEqual(["change", "change", "confirm", "status"]);
    expect(e.etaEvents![0]).toMatchObject({ at: t0, newEtaAt: t0 + 30 * MIN, by: "a1" });
    expect(e.etaEvents![0]!.oldEtaAt).toBeUndefined();
    expect(e.etaEvents![1]).toMatchObject({
      oldEtaAt: t0 + 30 * MIN,
      newEtaAt: t0 + 45 * MIN,
      newEtaMinAt: t0 + 15 * MIN,
    });
    expect(e.etaEvents![2]).toMatchObject({ kind: "confirm", newEtaAt: t0 + 45 * MIN });
    expect(e.etaEvents![3]).toMatchObject({ kind: "status", status: "review" });
    // The status change is no re-confirm.
    expect(e.etaConfirmedAt).toBe(t0 + 10 * MIN);
    // Every event has its own change id (no batch).
    expect(new Set(e.etaEvents!.map((v) => v.changeId)).size).toBe(4);
    // The original plan never moves.
    expect(e.plan).toEqual({ start: t0, etaAt: t0 + 30 * MIN });
  });

  it("keeps at most PROGRESS_ETA_EVENTS_MAX events", () => {
    let e: ProgressEntry | undefined;
    for (let i = 0; i < PROGRESS_ETA_EVENTS_MAX + 5; i++)
      e = mergeProgress(
        e,
        {
          id: "/x",
          assignee: { type: "agent", name: "a" },
          task: "t",
          status: "doing",
          etaIn: (i + 1) * MIN,
        },
        1000 + i,
      );
    expect(e!.etaEvents!.length).toBe(PROGRESS_ETA_EVENTS_MAX);
    expect(e!.plan!.etaAt).toBe(1000 + MIN);
  });

  it("a confirm needs an open estimate still ahead", async () => {
    const h = setup();
    expect((await h.write({ id: "/x/a", confirm: true })).status).toBe(400);
    await h.write({ id: "/x/a", eta: "10m" });
    expect(
      parseProgressReport({ agent: "a", task: "t", status: "doing", eta: "5m", confirm: true }),
    ).toBeInstanceOf(Error);
    h.tick(11 * MIN);
    const late = await h.write({ id: "/x/a", confirm: true });
    expect(late.status).toBe(400);
    expect(late.body.error).toContain("--late");
  });

  it("a confirm counts as on track: no overrun, the ping still at the estimate", async () => {
    const h = setup();
    await h.write({ id: "/x/a", eta: "10m" });
    h.tick(9 * MIN);
    const res = await h.write({ id: "/x/a", confirm: true });
    expect(res.status).toBe(200);
    expect(res.body.entry.etaConfirmedAgo).toBe("just now");
    expect(h.entry("/x/a")?.lateReason).toBeUndefined();
    expect(h.entry("/x/a")?.etaAt).toBe(h.now() + MIN);
  });

  it("show and the readers get etaConfirmedAt and an 'ago'", async () => {
    const h = setup();
    await h.write({ id: "/x/a", eta: "2h" });
    h.tick(7 * MIN);
    const shown = await h.call("");
    const a = (es: any[]) => es.find((e) => e.id === "/x/a");
    expect(a(shown.body.entries)).toMatchObject({ etaConfirmedAgo: "7 min ago" });
    const ws = await h.page();
    expect(a((ws.sent[0] as any).entries).etaConfirmedAgo).toBe("7 min ago");
    // The log keeps no ETA history (the node carries it).
    expect((ws.sent[0] as any).log[0].etaEvents).toBeUndefined();
    await h.write({ id: "/x/a", confirm: true });
    expect((ws.sent.at(-1) as any).etaConfirmedAgo).toBe("just now");
    expect((ws.sent.at(-1) as any).etaEvents.length).toBe(2);
  });
});

describe("change ids", () => {
  it("a batch writes every node with one time and one change id", async () => {
    const h = setup();
    await h.write({ id: "/x/a", eta: "30m" });
    await h.write({ id: "/x/b", eta: "30m" });
    h.tick(3 * MIN);
    const res = await h.call("/batch", {
      reports: [
        { agent: "a1", status: "doing", task: "A: a", id: "/x/a", eta: "10m" },
        { agent: "a1", status: "doing", task: "B: b", id: "/x/b", eta: "50m" },
        { agent: "a1", status: "doing", task: "C: c", id: "/x/c", eta: "1h" },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.results.length).toBe(3);
    const last = ["/x/a", "/x/b", "/x/c"].map((id) => h.entry(id)!.etaEvents!.at(-1)!);
    expect(new Set(last.map((e) => e.changeId))).toEqual(new Set([res.body.changeId]));
    expect(new Set(last.map((e) => e.at))).toEqual(new Set([h.now()]));
    expect(last[0]).toMatchObject({ oldEtaAt: h.now() + 27 * MIN, newEtaAt: h.now() + 10 * MIN });
  });

  it("a bad report fails the whole batch before anything is written", async () => {
    const h = setup();
    const res = await h.call("/batch", {
      reports: [
        { agent: "a1", status: "doing", task: "A", id: "/x/a", eta: "10m" },
        { agent: "a1", status: "nope", task: "B", id: "/x/b" },
      ],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("reports[1]");
    expect(h.entry("/x/a")).toBeUndefined();
    expect((await h.call("/batch", { reports: [] })).status).toBe(400);
  });

  it("--change-id on separate calls keeps the first call's time within the window", async () => {
    const h = setup();
    const t0 = h.now();
    await h.write({ id: "/x/a", eta: "30m", changeId: "replan-1" });
    h.tick(20_000);
    await h.write({ id: "/x/b", eta: "40m", changeId: "replan-1" });
    expect(h.entry("/x/b")!.etaEvents![0]).toMatchObject({ at: t0, changeId: "replan-1" });
    h.tick(CHANGE_ID_WINDOW_MS);
    await h.write({ id: "/x/c", eta: "40m", changeId: "replan-1" });
    expect(h.entry("/x/c")!.etaEvents![0]!.at).toBe(h.now());
  });
});

describe("progress.ts flags", () => {
  it("--confirm, --change-id and a range", () => {
    const c = parseProgressArgs([
      "--agent",
      "a",
      "--path",
      "/x",
      "--task",
      "X: x",
      "--status",
      "doing",
      "--confirm",
      "--change-id",
      "re-1",
    ]);
    expect(c).toMatchObject({ cmd: "report", report: { confirm: true, changeId: "re-1" } });
    const r = parseProgressArgs([
      "--agent",
      "a",
      "--path",
      "/x",
      "--task",
      "X: x",
      "--status",
      "doing",
      "--eta",
      "12m-63m",
    ]);
    expect(r).toMatchObject({ report: { etaIn: 63 * MIN, etaMinIn: 12 * MIN } });
    expect(
      parseProgressArgs([
        "--agent",
        "a",
        "--task",
        "X",
        "--status",
        "doing",
        "--change-id",
        "no spaces",
      ]),
    ).toBeInstanceOf(Error);
  });

  it("batch takes a JSON list keyed by the flags", () => {
    const c = parseProgressArgs([
      "batch",
      "--change-id",
      "re-2",
      JSON.stringify([
        { agent: "a", path: "/x/a", task: "A: a", status: "doing", eta: "20m" },
        { agent: "a", path: "/x/b", task: "B: b", done: true },
      ]),
    ]);
    expect(c).toMatchObject({ cmd: "batch", changeId: "re-2" });
    if (c instanceof Error || c.cmd !== "batch") throw c;
    expect(c.reports.map((r) => r.status)).toEqual(["doing", "done"]);
    expect(
      parseBatchItems([{ agent: "a", task: "A", status: "doing", token: "x" }]),
    ).toBeInstanceOf(Error);
    expect(parseBatchItems([])).toBeInstanceOf(Error);
    expect(parseProgressArgs(["batch", "not json"])).toBeInstanceOf(Error);
  });
});
