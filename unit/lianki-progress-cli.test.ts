// `lianki progress` (packages/lianki-cli/progress.mjs, cli.mjs): the flags of
// scripts/dev/progress.ts mapped to the hub's requests, the hub's answers as
// lines, every verb against a fake hub, and no token in any output.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import * as cliMod from "../packages/lianki-cli/cli.mjs";
import * as authMod from "../packages/lianki-cli/auth.mjs";
import * as progressMod from "../packages/lianki-cli/progress.mjs";
import { PROGRESS_KINDS, PROGRESS_STATUSES, RECEIPT_RE, CHANGE_ID_RE } from "@/lib/progress";

const cli: any = cliMod;
const auth: any = authMod;
const p: any = progressMod;
const TOKEN = `lk_${"5c".repeat(32)}`;

describe("progress.mjs: flags → request bodies", () => {
  test("the statuses and kinds are the hub's", () => {
    expect(p.PROGRESS_STATUSES).toEqual([...PROGRESS_STATUSES]);
    expect(p.PROGRESS_KINDS).toEqual([...PROGRESS_KINDS]);
    expect(p.RECEIPT_RE.source).toBe(RECEIPT_RE.source);
    expect(p.CHANGE_ID_RE.source).toBe(CHANGE_ID_RE.source);
  });

  test("a report: path, done, pct, pr lists, change id, verified kinds", () => {
    expect(
      p.reportBody({
        path: "/words/swipe",
        task: "Swipe: snap",
        status: "doing",
        pct: "40%",
        eta: "30m",
        note: "n",
        "change-id": "c.1",
      }),
    ).toEqual({
      id: "/words/swipe",
      task: "Swipe: snap",
      status: "doing",
      pct: 40,
      eta: "30m",
      note: "n",
      changeId: "c.1",
    });
    expect(p.reportBody({ path: "/x", task: "X: a", done: true, pr: "703,707" })).toEqual({
      id: "/x",
      task: "X: a",
      status: "done",
      prs: [703, 707],
      unverified: true,
    });
    expect(
      p.reportBody({
        path: "/x",
        task: "X: a",
        done: true,
        pr: "#310",
        verified: "pr #310 merged",
      }),
    ).toEqual({
      id: "/x",
      task: "X: a",
      status: "done",
      pr: 310,
      verified: "pr #310 merged",
    });
    expect(
      p.reportBody({
        id: "slug",
        parent: "/x",
        task: "S: b",
        status: "review",
        agent: "codex",
        kind: "group",
        rev: "3",
      }),
    ).toEqual({
      id: "slug",
      parent: "/x",
      task: "S: b",
      status: "review",
      agent: "codex",
      kind: "group",
      rev: 3,
    });
    expect(
      p.reportBody({ path: "/x", task: "X: a", status: "doing", human: true, agent: "Taku" })
        .assignee,
    ).toEqual({ type: "human", name: "Taku" });
    expect(
      p.reportBody({
        path: "/x",
        task: "X: a",
        status: "doing",
        eta: "20m",
        late: "CI slow",
        confirm: true,
      }),
    ).toMatchObject({ eta: "20m", late: "CI slow", confirm: true });
    expect(
      p.reportBody({ path: "/x", task: "X: a", status: "blocked", who: "owner", needs: "approve" }),
    ).toMatchObject({ who: "owner", needs: "approve" });
    expect(
      p.reportBody({ path: "/x", task: "X: a", done: true, ended: "2026-11-01T00:00:00Z" }).endedAt,
    ).toBe(Date.parse("2026-11-01T00:00:00Z"));
  });

  test("usage errors name the flag, nothing is sent", () => {
    const bad = (a: Record<string, unknown>, re: RegExp) => {
      try {
        p.reportBody(a);
      } catch (e: any) {
        expect(e.code).toBe("usage");
        expect(e.message).toMatch(re);
        return;
      }
      throw new Error("expected a usage error");
    };
    bad({ path: "/x", status: "doing" }, /--task/);
    bad({ path: "/x", task: "X: a" }, /--status/);
    bad({ path: "/x", task: "X: a", status: "later" }, /--status must be one of/);
    bad({ path: "/x", task: "X: a", status: "blocked" }, /--who/);
    bad({ path: "/x", id: "/y", task: "X: a", status: "doing" }, /--path and --id differ/);
    bad({ path: "/x", task: "X: a", status: "doing", pct: "120" }, /--pct/);
    bad({ path: "/x", task: "X: a", status: "doing", pr: "a,b" }, /--pr/);
    bad({ path: "/x", task: "X: a", status: "doing", late: "why" }, /--late .* --eta/);
    bad({ path: "/x", task: "X: a", status: "doing", verified: "x" }, /--done/);
    bad(
      { path: "/x", task: "X: a", done: true, verified: "x", unverified: true },
      /one or the other/,
    );
    bad(
      { path: "/x", task: "X: a", status: "doing", "change-id": "no spaces here!" },
      /--change-id/,
    );
    bad({ path: "/x", task: "X: a", status: "doing", kind: "epic" }, /--kind/);
  });

  test("batch, ack and since", () => {
    expect(
      p.batchBody(
        '[{"path":"/x/a","task":"A: one","status":"doing","eta":"20m"},{"path":"/x/b","task":"B: two","done":true}]',
        "c1",
      ),
    ).toEqual({
      reports: [
        { id: "/x/a", task: "A: one", status: "doing", eta: "20m" },
        { id: "/x/b", task: "B: two", status: "done", unverified: true },
      ],
      changeId: "c1",
    });
    expect(() => p.batchBody("[]")).toThrow(/JSON list/);
    expect(() => p.batchBody("nope")).toThrow(/batch:/);
    expect(() =>
      p.batchBody('[{"path":"/x","task":"X: a","status":"doing","changeId":"c"}]'),
    ).toThrow(/goes on the batch/);
    expect(() => p.batchBody('[{"path":"/x","status":"doing"}]')).toThrow(/batch item 0: .*--task/);
    expect(p.ackBody(" K3X9QA ")).toEqual({ code: "k3x9qa" });
    expect(() => p.ackBody("abc")).toThrow(/receipt code/);
    expect(p.sinceMs(undefined)).toBe(7 * 86_400_000);
    expect(p.sinceMs("12h")).toBe(12 * 3_600_000);
    expect(() => p.sinceMs("soon")).toThrow(/--since/);
    expect(p.parseTtl("1h30m")).toBe(90 * 60_000);
    expect(p.parseTtl("")).toBeNull();
  });

  test("answers as lines: a report, a batch, stats", () => {
    expect(
      p.entryLine({
        entry: { id: "/x", status: "doing", rev: 2, etaAt: Date.UTC(2026, 10, 7, 11, 30) },
        readers: 1,
        told: true,
      }),
    ).toBe(
      "progress: /x doing (rev 2, ETA 2026-11-07 20:30 JST, 1 watching)\nprogress: the owner was told the reason and the new time",
    );
    expect(
      p.entryLine({ entry: { id: "/x", status: "done", rev: 3, doneKind: "unverified" } }),
    ).toContain("not verified yet");
    expect(
      p.batchLines({
        changeId: "c1",
        results: [{ entry: { id: "/a", status: "doing" } }, { status: 403, error: "nope" }],
      }),
    ).toBe("progress: /a doing\nprogress: 403 nope\nprogress: change c1 (2 nodes)");
    const done = [
      {
        at: 100,
        agent: "codex",
        id: "/a",
        title: "A",
        estimateMs: 60_000,
        actualMs: 120_000,
        revisions: 1,
      },
      { at: 90, agent: "codex", id: "/b", title: "B", actualMs: 30_000, revisions: 0 },
      {
        at: 10,
        agent: "agy",
        id: "/c",
        title: "C",
        estimateMs: 60_000,
        actualMs: 60_000,
        revisions: 0,
      },
    ];
    const stats = p.statsOf(done, { now: 100, since: 50 });
    expect(stats).toEqual([
      { agent: "codex", done: 2, estimated: 1, medianRatio: 2, tasks: expect.any(Array) },
    ]);
    expect(p.formatStats(stats)).toContain("codex: 2 done, 1 estimated, median ×2.00");
    expect(p.formatStats(p.statsOf(done, { agent: "agy", now: 100 }))).toContain(
      "agy: 1 done, 1 estimated, median ×1.00",
    );
    expect(p.formatStats([])).toContain("no done tasks");
    expect(
      p.formatHistory([
        {
          id: "/a",
          title: "A",
          agent: "codex",
          endedAt: Date.UTC(2026, 10, 7, 11, 30),
          prs: [3],
          doneKind: "verified",
          evidence: "pr #3 merged",
        },
      ]),
    ).toBe("2026-11-07 20:30 JST  /a  #3  A  (codex)  [verified: pr #3 merged]");
  });
});

type Call = {
  method: string;
  path: string;
  query: string;
  auth: string | null;
  body: any;
  client: string | null;
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

function harness(server: Record<string, (c: Call) => Response> = {}) {
  const calls: Call[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const home = mkdtempSync(join(tmpdir(), "lianki-progress-"));
  const env = { XDG_CONFIG_HOME: home, LIANKI_NO_KEYCHAIN: "1", LIANKI_TOKEN: TOKEN };
  const handlers: Record<string, (c: Call) => Response> = {
    "POST /api/version/progress": (c) =>
      c.body.task === "Late: x"
        ? json({ error: "past the ETA a new eta needs late" }, 400)
        : json({
            entry: { id: c.body.id, status: c.body.status, rev: 1, creator: "codex" },
            readers: 2,
          }),
    "POST /api/version/progress/batch": (c) =>
      json({
        ok: true,
        changeId: "c1",
        at: 1,
        results: c.body.reports.map((r: any) => ({ entry: { id: r.id, status: r.status } })),
      }),
    "POST /api/version/progress/ack": (c) => json({ ok: true, id: "/x", task: "X: a", etaAt: 1 }),
    "GET /api/version/progress": () => json({ entries: [{ id: "/x", status: "doing" }], log: [] }),
    "GET /api/version/progress/stats": () =>
      json({
        done: [
          {
            at: Date.now(),
            agent: "codex",
            id: "/a",
            title: "A",
            estimateMs: 60_000,
            actualMs: 90_000,
            revisions: 0,
          },
        ],
      }),
    "GET /api/version/progress/history": () =>
      json({ items: [{ id: "/a", title: "A", agent: "codex", endedAt: Date.now() }] }),
    ...server,
  };
  const deps = {
    env,
    version: "0.4.0",
    fetch: async (input: URL, init: any = {}) => {
      const u = new URL(String(input));
      const c: Call = {
        method: init.method ?? "GET",
        path: u.pathname,
        query: u.search,
        auth: init.headers?.authorization ?? null,
        body: init.body ? JSON.parse(init.body) : undefined,
        client: init.headers?.["x-lianki-client"] ?? null,
      };
      calls.push(c);
      if (c.auth !== `Bearer ${TOKEN}`) return json({ error: "unknown" }, 401);
      const h = handlers[`${c.method} ${c.path}`];
      return h ? h(c) : new Response("404", { status: 404 });
    },
    out: (s: string) => void out.push(s),
    err: (s: string) => void err.push(s),
    store: { get: async () => null, set: async () => "file", delete: async () => {} },
    config: auth.fileConfig({ XDG_CONFIG_HOME: home }),
    readStdin: async () => "",
    readFile: async (path: string) => require("fs").readFileSync(path, "utf8"),
    ask: async () => "n",
    hostname: "t",
    stdinIsTTY: false,
    columns: 100,
    timeoutMs: 1000,
    now: () => Date.now(),
  };
  const run = async (...args: string[]) => ({
    code: await cli.run(args, deps),
    out: out.splice(0),
    err: err.splice(0),
    calls: calls.splice(0),
  });
  return { run, home, close: () => rmSync(home, { recursive: true, force: true }) };
}

describe("lianki progress: every verb against a fake hub", () => {
  test("report (the default verb), with the token as a bearer and nothing else", async () => {
    const h = harness();
    const r = await h.run(
      "progress",
      "--path",
      "/dev/cli",
      "--task",
      "CLI: progress",
      "--status",
      "doing",
      "--pct",
      "40",
      "--eta",
      "30m",
    );
    expect(r.code).toBe(0);
    expect(r.calls[0]).toMatchObject({
      method: "POST",
      path: "/api/version/progress",
      auth: `Bearer ${TOKEN}`,
      body: { id: "/dev/cli", task: "CLI: progress", status: "doing", pct: 40, eta: "30m" },
    });
    expect(r.calls[0].body.agent).toBeUndefined();
    expect(r.out).toEqual(["progress: /dev/cli doing (rev 1, 2 watching)"]);
    const j = await h.run(
      "progress",
      "report",
      "--path",
      "/dev/cli",
      "--task",
      "CLI: progress",
      "--done",
      "--pr",
      "310",
      "--json",
    );
    expect(JSON.parse(j.out[0])).toMatchObject({
      v: 1,
      ok: true,
      command: "progress",
      data: { entry: { id: "/dev/cli", status: "done" } },
    });
    expect(j.calls[0].body).toMatchObject({ status: "done", pr: 310, unverified: true });
    h.close();
  });

  test("a refusal is exit 5 with the hub's words; a usage error sends nothing", async () => {
    const h = harness();
    const r = await h.run(
      "progress",
      "--path",
      "/x",
      "--task",
      "Late: x",
      "--status",
      "doing",
      "--eta",
      "20m",
    );
    expect(r.code).toBe(5);
    expect(r.err[0]).toContain("past the ETA a new eta needs late");
    const u = await h.run("progress", "--path", "/x", "--task", "X: a", "--status", "blocked");
    expect(u.code).toBe(1);
    expect(u.calls).toEqual([]);
    expect(u.err[0]).toContain("--who");
    h.close();
  });

  test("batch (inline and --file), ack, show --all, stats, history", async () => {
    const h = harness();
    const list =
      '[{"path":"/x/a","task":"A: one","status":"doing","eta":"20m"},{"path":"/x/b","task":"B: two","done":true}]';
    const b = await h.run("progress", "batch", list, "--change-id", "c1");
    expect(b.code).toBe(0);
    expect(b.calls[0].body).toEqual({
      reports: [
        { id: "/x/a", task: "A: one", status: "doing", eta: "20m" },
        { id: "/x/b", task: "B: two", status: "done", unverified: true },
      ],
      changeId: "c1",
    });
    expect(b.out[0]).toBe(
      "progress: /x/a doing\nprogress: /x/b done\nprogress: change c1 (2 nodes)",
    );
    const f = join(h.home, "batch.json");
    writeFileSync(f, list);
    expect((await h.run("progress", "batch", "--file", f)).calls[0].body.reports).toHaveLength(2);
    const a = await h.run("progress", "ack", "K3X9QA");
    expect(a.calls[0]).toMatchObject({
      path: "/api/version/progress/ack",
      body: { code: "k3x9qa" },
    });
    expect(a.out[0]).toBe("progress: acked /x (receipt k3x9qa)");
    const s = await h.run("progress", "show", "--all", "--json");
    expect(s.calls.map((c) => `${c.method} ${c.path}${c.query}`)).toEqual([
      "GET /api/version/progress",
      "GET /api/version/progress/history?limit=2000",
    ]);
    expect(JSON.parse(s.out[0]).data).toMatchObject({
      entries: [{ id: "/x" }],
      history: [{ id: "/a" }],
    });
    const st = await h.run("progress", "stats", "--since", "30d");
    expect(st.out[0]).toContain("codex: 1 done, 1 estimated, median ×1.50");
    const hi = await h.run("progress", "history", "--agent", "codex");
    expect(hi.out[0]).toContain("/a  A  (codex)");
    expect((await h.run("progress", "history", "--agent", "nobody")).out[0]).toContain(
      "no done nodes",
    );
    h.close();
  });

  test("no token: exit 2 before any request; the token is never printed", async () => {
    const h = harness();
    const r = await h.run(
      "progress",
      "--path",
      "/x",
      "--task",
      "X: a",
      "--status",
      "doing",
      "--token",
      `lk_${"00".repeat(32)}`,
    );
    expect(r.code).toBe(2);
    expect(r.calls).toHaveLength(1);
    for (const line of [...r.out, ...r.err]) expect(line).not.toMatch(/lk_[0-9a-f]{8}/);
    h.close();
  });
});
