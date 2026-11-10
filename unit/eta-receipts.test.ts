/**
 * Receipts, backoff, blocked vs paused, done kinds and title width
 * (docs/state-tree.md; lib/eta-nudge.ts, workers/push/src/progress.ts).
 * The harness is unit/eta.test.ts's: a progress hub with a fake chat hub.
 */
import { describe, expect, it } from "bun:test";
import { ETA_RETRY_MS, ProgressHub } from "@/workers/push/src/progress";
import type { Socket, Storage } from "@/workers/push/src/debug";
import {
  type ProgressEntry,
  type ProgressReport,
  displayWidth,
  progressHistory,
  waitsOnOwner,
} from "@/lib/progress";
import { ETA_HEARD_PATH, compactSpan, etaLineText, parseEtaPing } from "@/lib/eta-ping";
import { NUDGE_DEFAULTS, backoffDelayMs, nudgeRules } from "@/lib/eta-nudge";
import { parseProgressArgs, settleDoneKind } from "@/scripts/dev/progress-args";
import { roadmapSections } from "@/lib/roadmap-tree";

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

type Ping = Record<string, any>;

/** A progress hub; `answer` is the chat hub's reply to each ping. */
function setup(
  answer: (p: Ping) => Response = () => Response.json({ ok: true }),
  config?: Record<string, unknown>,
) {
  let t = 1_000_000;
  const sockets: FakeSocket[] = [];
  const storage = fakeStorage();
  const pings: Ping[] = [];
  const DEBUG = {
    idFromName: (n: string) => n,
    get: () => ({
      fetch: async (req: Request) => {
        const p = (await req.json()) as Ping;
        pings.push(p);
        return answer(p);
      },
    }),
  };
  const SESSIONS = config ? { config: async (k: string) => config[k] } : undefined;
  const hub = new ProgressHub(
    {
      acceptWebSocket: (ws) => sockets.push(ws as FakeSocket),
      getWebSockets: () => sockets,
      storage,
    },
    { PROGRESS_TOKEN: ROOT, DEBUG, ...(SESSIONS ? { SESSIONS } : {}) },
    () => t,
  );
  const call = async (path: string, body: unknown, token = ROOT) => {
    const res = await hub.fetch(
      new Request(`https://lianki.com/api/version/progress${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      }),
    );
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  const write = (body: Record<string, unknown>) =>
    call("", { agent: "a1", status: "doing", task: "Swipe: drag it", ...body });
  const heard = () =>
    hub.fetch(new Request(`https://lianki-push${ETA_HEARD_PATH}`, { method: "POST" }));
  const entry = (id: string) => storage.store.get(`e:${id}`) as ProgressEntry | undefined;
  const kinds = (id: string) => pings.filter((p) => p.id === id).map((p) => p.kind ?? "due");
  return {
    hub,
    storage,
    pings,
    call,
    write,
    heard,
    entry,
    kinds,
    tick: (ms: number) => (t += ms),
    now: () => t,
  };
}

describe("receipts: the ETA line carries a code; no ack → the coordinating lane, then the owner", () => {
  it("`ack <code>` stops the coordinating lane's line; the owner still hears it unexplained at 10 min", async () => {
    const h = setup();
    await h.write({ id: "/w/s", eta: "5m" });
    h.tick(5 * MIN);
    await h.hub.alarm();
    const code = h.pings[0]!.code as string;
    expect(code).toMatch(/^[a-z0-9]{6}$/);
    expect(etaLineText(h.pings[0] as never)).toContain(`progress.ts ack ${code}`);
    const ack = await h.call("/ack", { code });
    expect(ack).toMatchObject({ status: 200, body: { ok: true, id: "/w/s" } });
    expect(h.entry("/w/s")!.etaAcked).toBe(h.entry("/w/s")!.etaAt);
    h.tick(5 * MIN);
    await h.hub.alarm();
    expect(h.kinds("/w/s")).toEqual(["due"]);
    h.tick(5 * MIN);
    await h.hub.alarm();
    expect(h.kinds("/w/s")).toEqual(["due", "silent"]);
    // Unknown codes and malformed ones.
    expect((await h.call("/ack", { code: "zzzzzz" })).status).toBe(404);
    expect((await h.call("/ack", { code: "nope" })).status).toBe(400);
  });

  it("any report on the node is an ack; a reason and a new ETA end the whole chain", async () => {
    const h = setup();
    await h.write({ id: "/w/s", eta: "5m" });
    h.tick(5 * MIN);
    await h.hub.alarm();
    await h.write({ id: "/w/s", pct: 60 });
    h.tick(5 * MIN);
    await h.hub.alarm();
    expect(h.kinds("/w/s")).toEqual(["due"]);
    await h.write({ id: "/w/s", eta: "20m", late: "测试太慢" });
    h.tick(10 * MIN);
    await h.hub.alarm();
    expect(h.kinds("/w/s")).toEqual(["due", "late"]);
  });

  it("an ack from a scoped token outside its scope is refused", async () => {
    const h = setup();
    await h.write({ id: "/w/s", eta: "5m" });
    await h.write({ id: "/other/x", eta: "50m" });
    h.tick(5 * MIN);
    await h.hub.alarm();
    const grant = await h.call("/grant", { node: "/other", agent: "b2" });
    const code = h.pings[0]!.code as string;
    expect((await h.call("/ack", { code }, grant.body.token)).status).toBe(403);
  });

  it("no listener: the line is queued, the clock does not start; a listener connecting sends it", async () => {
    let listening = false;
    const h = setup((p) =>
      !listening && (p.kind ?? "due") === "due"
        ? Response.json({ ok: true, delivered: false, queued: true })
        : Response.json({ ok: true, delivered: true }),
    );
    await h.write({ id: "/w/s", eta: "5m" });
    h.tick(5 * MIN);
    await h.hub.alarm();
    const e = h.entry("/w/s")!;
    expect(e.etaSent).toBeUndefined();
    expect(e.etaQueued).toBe(e.etaAt);
    // Hours pass with no one listening: no retries, no coordinating lane, no owner line.
    h.tick(3 * 60 * MIN);
    await h.hub.alarm();
    expect(h.kinds("/w/s")).toEqual(["due"]);
    listening = true;
    await h.heard();
    expect(h.kinds("/w/s")).toEqual(["due", "due"]);
    expect(h.entry("/w/s")!.etaHeardAt).toBe(h.now());
    // The clock runs from when it was heard.
    h.tick(5 * MIN - 1000);
    await h.hub.alarm();
    expect(h.kinds("/w/s")).toEqual(["due", "due"]);
    h.tick(1000);
    await h.hub.alarm();
    expect(h.kinds("/w/s")).toEqual(["due", "due", "main"]);
  });

  it("the windows and the coordinator are config values", async () => {
    const h = setup(undefined, {
      "chat.etaAckMin": 2,
      "chat.etaOwnerMin": 3,
      "chat.etaCoordinator": "lead",
    });
    await h.write({ id: "/w/s", eta: "5m" });
    h.tick(5 * MIN);
    await h.hub.alarm();
    expect(h.pings[0]).toMatchObject({ ackMin: 2, ownerMin: 3 });
    h.tick(2 * MIN);
    await h.hub.alarm();
    expect(h.pings.at(-1)).toMatchObject({ kind: "main", lane: "lead" });
    h.tick(3 * MIN);
    await h.hub.alarm();
    expect(h.kinds("/w/s")).toEqual(["due", "main", "silent"]);
    expect(nudgeRules({ "chat.etaAckMin": "x" }).ackMs).toBe(5 * MIN);
  });
});

describe("backoff: after 未说明原因, again at 10, 20, 40… min (at most every 4 h)", () => {
  it("repeats with a growing gap until a reason and a new ETA come", async () => {
    const h = setup();
    await h.write({ id: "/w/s", eta: "5m" });
    h.tick(5 * MIN);
    await h.hub.alarm();
    h.tick(5 * MIN);
    await h.hub.alarm();
    h.tick(5 * MIN);
    await h.hub.alarm();
    expect(h.kinds("/w/s")).toEqual(["due", "main", "silent"]);
    const at: number[] = [];
    for (const gap of [10, 20, 40, 80]) {
      h.tick(gap * MIN - 1000);
      await h.hub.alarm();
      expect(h.pings.length).toBe(3 + at.length);
      h.tick(1000);
      await h.hub.alarm();
      at.push(h.now());
    }
    expect(h.pings.slice(3).map((p) => [p.kind, p.n])).toEqual([
      ["silent", 1],
      ["silent", 2],
      ["silent", 3],
      ["silent", 4],
    ]);
    expect(etaLineText(h.pings.at(-1) as never, h.now())).toMatch(
      /^Swipe 仍超时，未说明原因（已超 \d/,
    );
    // Explained: no more.
    await h.write({ id: "/w/s", eta: "30m", late: "等 CI" });
    h.tick(20 * MIN);
    await h.hub.alarm();
    expect(h.pings.filter((p) => p.kind === "silent").length).toBe(5);
  });

  it("the spacing's last value repeats: the 4 h cap", () => {
    expect(NUDGE_DEFAULTS.backoffMs.map((ms) => ms / MIN)).toEqual([10, 20, 40, 80, 160, 240]);
    expect(backoffDelayMs(NUDGE_DEFAULTS.backoffMs, 1)).toBe(10 * MIN);
    expect(backoffDelayMs(NUDGE_DEFAULTS.backoffMs, 99)).toBe(240 * MIN);
    expect(compactSpan(90 * MIN)).toBe("1.5H");
    expect(compactSpan(40 * MIN)).toBe("40M");
  });

  it("done stops the repeats", async () => {
    const h = setup();
    await h.write({ id: "/w/s", eta: "5m" });
    for (let i = 0; i < 3; i++) {
      h.tick(5 * MIN);
      await h.hub.alarm();
    }
    await h.write({ id: "/w/s", status: "done", verified: "PR #9 merged" });
    h.tick(60 * MIN);
    await h.hub.alarm();
    expect(h.kinds("/w/s")).toEqual(["due", "main", "silent"]);
  });
});

describe("blocked (someone can act now) vs paused (an outside event)", () => {
  it("blocked on the owner: nudged at once and with backoff, never an ETA line or 未说明原因", async () => {
    const h = setup();
    await h.write({ id: "/w/b", eta: "5m" });
    const w = await h.write({ id: "/w/b", status: "blocked", who: "owner", needs: "批准 DNS" });
    expect(w.status).toBe(200);
    expect(h.storage.alarm).toBe(h.now());
    await h.hub.alarm();
    expect(h.pings.at(-1)).toMatchObject({
      kind: "blocked",
      lane: "owner",
      reason: "批准 DNS",
      n: 1,
    });
    expect(etaLineText(h.pings.at(-1) as never)).toBe("Swipe 卡住了，等你——批准 DNS");
    h.tick(10 * MIN);
    await h.hub.alarm();
    h.tick(20 * MIN);
    await h.hub.alarm();
    expect(h.kinds("/w/b")).toEqual(["blocked", "blocked", "blocked"]);
    // Past its ETA while blocked: a new ETA needs no --late.
    expect((await h.write({ id: "/w/b", status: "blocked", eta: "1h" })).status).toBe(200);
    // It is his to act on: the board lists it as waiting on him.
    expect(waitsOnOwner(h.entry("/w/b")!)).toBe(true);
    // Unblocked: no more nudges.
    await h.write({ id: "/w/b", status: "doing" });
    h.tick(60 * MIN);
    await h.hub.alarm();
    expect(h.kinds("/w/b").filter((k) => k === "blocked").length).toBe(3);
  });

  it("blocked on a lane: a line for it; queued without a listener, sent when one connects", async () => {
    let listening = false;
    const h = setup((p) =>
      !listening && p.kind === "blocked"
        ? Response.json({ ok: true, delivered: false, queued: true })
        : Response.json({ ok: true, delivered: true }),
    );
    await h.write({ id: "/w/r", status: "blocked", who: "@codex", needs: "合并 #812" });
    expect(h.entry("/w/r")!.who).toBe("codex");
    expect(waitsOnOwner(h.entry("/w/r")!)).toBe(false);
    await h.hub.alarm();
    expect(h.entry("/w/r")!.nudgeQueued).toBe(1);
    expect(h.entry("/w/r")!.nudgeAt).toBeUndefined();
    h.tick(60 * MIN);
    await h.hub.alarm();
    expect(h.kinds("/w/r")).toEqual(["blocked"]);
    listening = true;
    await h.heard();
    expect(h.pings.at(-1)).toMatchObject({ kind: "blocked", lane: "codex", n: 1 });
    expect(h.entry("/w/r")).toMatchObject({ nudgeN: 1, nudgeAt: h.now() + 10 * MIN });
    // A new who or needs starts over at once.
    await h.write({ id: "/w/r", status: "blocked", who: "main", needs: "rebase" });
    await h.hub.alarm();
    expect(h.pings.at(-1)).toMatchObject({ lane: "main", n: 1, reason: "rebase" });
  });

  it("paused (waiting): no ETA line, no 未说明原因, no nudges, no --late needed", async () => {
    const h = setup();
    await h.write({ id: "/w/p", status: "waiting", eta: "5m", note: "等 Apple 审核" });
    h.tick(60 * MIN);
    await h.hub.alarm();
    await h.hub.alarm();
    expect(h.kinds("/w/p")).toEqual([]);
    expect((await h.write({ id: "/w/p", status: "waiting", eta: "2h" })).status).toBe(200);
    // Back to work with that time still ahead: the normal rules again.
    await h.write({ id: "/w/p", status: "doing" });
    h.tick(2 * 60 * MIN);
    await h.hub.alarm();
    expect(h.kinds("/w/p")).toEqual(["due"]);
  });

  it("back from a hold after its ETA passed: not told it is late for the held time", async () => {
    const h = setup();
    await h.write({ id: "/w/q", status: "waiting", eta: "5m" });
    h.tick(10 * MIN);
    await h.write({ id: "/w/q", status: "doing" });
    h.tick(10 * MIN);
    await h.hub.alarm();
    await h.hub.alarm();
    expect(h.kinds("/w/q")).toEqual([]);
  });

  it("the CLI: blocked names who; --who with no blocked is kept for later", () => {
    const base = ["--agent", "a", "--task", "T: x", "--path", "/w/b"];
    expect(parseProgressArgs([...base, "--status", "blocked"])).toBeInstanceOf(Error);
    expect(
      parseProgressArgs([...base, "--status", "blocked", "--who", "owner", "--needs", "OK"]),
    ).toMatchObject({ report: { status: "blocked", who: "owner", needs: "OK" } });
    expect(parseProgressArgs([...base, "--status", "blocked", "--who", "a b"])).toBeInstanceOf(
      Error,
    );
    expect(parseProgressArgs([...base, "--status", "waiting"])).toMatchObject({ cmd: "report" });
  });
});

describe("done kinds: verified, unverified (a verify child), not done", () => {
  it("--verified keeps the evidence; history and the board carry the kind", async () => {
    const h = setup();
    const w = await h.write({ id: "/w/v", status: "done", verified: "PR #812 merged, deployed" });
    expect(w.body.entry).toMatchObject({
      doneKind: "verified",
      evidence: "PR #812 merged, deployed",
    });
    const hist = progressHistory(h.entry("/w/v")!);
    expect(hist).toMatchObject({ doneKind: "verified", evidence: "PR #812 merged, deployed" });
    const board = roadmapSections([], [hist]);
    expect(board.done[0]!.items[0]).toMatchObject({ doneKind: "verified" });
    expect(h.entry("/w/v/verify")).toBeUndefined();
  });

  it("--unverified adds 'verify: <name>' for the same lane with a short ETA; verifying it verifies the parent", async () => {
    const h = setup(undefined, { "chat.verifyEtaMin": 20 });
    await h.write({ id: "/w/u", eta: "1h" });
    const w = await h.write({ id: "/w/u", status: "done", unverified: true, pr: 9 });
    expect(w.body.entry.doneKind).toBe("unverified");
    const v = h.entry("/w/u/verify")!;
    expect(v).toMatchObject({
      task: "verify: Swipe",
      status: "doing",
      assignee: { type: "agent", name: "a1" },
      creator: "a1",
      parent: "/w/u",
      etaAt: h.now() + 20 * MIN,
    });
    // Written again done: no second child.
    await h.write({ id: "/w/u", status: "done", unverified: true });
    expect([...h.storage.store.keys()].filter((k) => k.includes("verify")).length).toBe(1);
    await h.write({
      id: "/w/u/verify",
      task: "verify: Swipe",
      status: "done",
      verified: "tested on the phone",
    });
    expect(h.entry("/w/u")).toMatchObject({
      doneKind: "verified",
      evidence: "verify: tested on the phone",
    });
    // A verify node never gets a verify child of its own.
    expect(h.entry("/w/u/verify/verify")).toBeUndefined();
  });

  it("a slug's verify child is <slug>.verify", async () => {
    const h = setup();
    await h.write({ id: "lane-task", status: "done", unverified: true });
    expect(h.entry("lane-task.verify")).toMatchObject({ parent: "lane-task" });
  });

  it("the CLI default: verified when every PR is merged, else unverified", () => {
    const r = (x: Partial<ProgressReport>): ProgressReport => ({
      id: "/w/x",
      assignee: { type: "agent", name: "a" },
      task: "X: y",
      status: "done",
      ...x,
    });
    expect(settleDoneKind(r({ pr: 9 }), () => true)).toMatchObject({ verified: "pr #9 merged" });
    expect(settleDoneKind(r({ pr: 9 }), () => false)).toMatchObject({ unverified: true });
    expect(settleDoneKind(r({ pr: 9 }), () => undefined)).toMatchObject({ unverified: true });
    expect(settleDoneKind(r({}), () => true)).toMatchObject({ unverified: true });
    expect(settleDoneKind(r({ prs: [1, 2] }), (n) => n === 1)).toMatchObject({ unverified: true });
    expect(settleDoneKind(r({ verified: "x" }), () => false)).toMatchObject({ verified: "x" });
    expect(settleDoneKind(r({ status: "doing" }), () => true)).not.toHaveProperty("unverified");
    const base = ["--agent", "a", "--task", "T: x", "--path", "/w/b"];
    expect(parseProgressArgs([...base, "--done", "--verified", "PR #1 merged"])).toMatchObject({
      report: { status: "done", verified: "PR #1 merged" },
    });
    expect(parseProgressArgs([...base, "--done", "--unverified"])).toMatchObject({
      report: { unverified: true },
    });
    expect(parseProgressArgs([...base, "--status", "doing", "--unverified"])).toBeInstanceOf(Error);
    expect(
      parseProgressArgs([...base, "--done", "--unverified", "--verified", "x"]),
    ).toBeInstanceOf(Error);
    expect(parseProgressArgs(["ack", "K3X9QA"])).toEqual({ cmd: "ack", code: "k3x9qa" });
    expect(parseProgressArgs(["ack"])).toBeInstanceOf(Error);
  });
});

describe("title width: ≤ 20 columns for new or renamed names; old nodes keep theirs", () => {
  it("counts East Asian wide characters and emoji as 2", () => {
    expect(displayWidth("Swipe fix")).toBe(9);
    expect(displayWidth("滑动修复")).toBe(8);
    expect(displayWidth("ｗｉｄｅ")).toBe(8);
    expect(displayWidth("한국어")).toBe(6);
    expect(displayWidth("👍🏽")).toBe(2);
    expect(displayWidth("e\u0301")).toBe(1);
  });

  it("the hub refuses a new wide name and keeps an existing one", async () => {
    const h = setup();
    const long = `${"提".repeat(11)}: x`;
    const refused = await h.write({ id: "/w/t", task: long });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toContain("columns");
    // A node from before the rule (written straight to storage) keeps its name, any description.
    const ok = await h.write({ id: "/w/t", task: "提醒: x" });
    expect(ok.status).toBe(200);
    h.storage.store.set("e:/w/t", { ...h.entry("/w/t")!, task: long });
    expect((await h.write({ id: "/w/t", task: `${"提".repeat(11)}: y`, pct: 5 })).status).toBe(200);
    // Renamed: checked.
    expect((await h.write({ id: "/w/t", task: `${"醒".repeat(11)}: y` })).status).toBe(400);
  });

  it("the CLI only warns when the hub may grandfather it", () => {
    const base = ["--agent", "a", "--status", "doing", "--task"];
    expect(parseProgressArgs([...base, `${"提".repeat(11)}: x`])).toMatchObject({
      cmd: "report",
      warning: expect.stringContaining("unless this node already has that name"),
    });
    expect(parseProgressArgs([...base, `${"x".repeat(21)}: y`])).toBeInstanceOf(Error);
  });
});

describe("the pings as the chat hub reads them", () => {
  it("parses the new kinds and their fields", () => {
    const base = { id: "/w/s", title: "Swipe: x", etaAt: 5 };
    expect(parseEtaPing({ ...base, code: "k3x9qa", ackMin: 5, ownerMin: 5 })).toEqual({
      ...base,
      code: "k3x9qa",
      ackMin: 5,
      ownerMin: 5,
    });
    expect(parseEtaPing({ ...base, kind: "main" })).toBeNull();
    expect(parseEtaPing({ ...base, kind: "blocked", lane: "codex", n: 2, reason: "r" })).toEqual({
      ...base,
      kind: "blocked",
      lane: "codex",
      n: 2,
      reason: "r",
    });
    expect(parseEtaPing({ ...base, kind: "silent", n: 3, code: "k3x9qa" })).toEqual({
      ...base,
      kind: "silent",
      n: 3,
    });
    expect(parseEtaPing({ ...base, code: "bad code" })).toEqual(base);
  });
});

it("ETA_RETRY_MS still applies when the chat hub cannot take a nudge", async () => {
  let ok = false;
  const h = setup(() => (ok ? Response.json({ ok: true }) : new Response("busy", { status: 503 })));
  await h.write({ id: "/w/b", status: "blocked", who: "owner", needs: "看" });
  await h.hub.alarm();
  expect(h.entry("/w/b")!.nudgeN).toBe(0);
  expect(h.storage.alarm).toBe(h.now() + ETA_RETRY_MS);
  ok = true;
  h.tick(ETA_RETRY_MS);
  await h.hub.alarm();
  expect(h.entry("/w/b")!.nudgeN).toBe(1);
});
