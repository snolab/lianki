import { expect, test } from "bun:test";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  lineOf,
  makeAcker,
  makeDeliverer,
  makeSeqCursor,
  readCursor,
  receiptAfter,
  catchUpTrigger,
  liftReceipt,
  makeRecovery,
  recoveredPage,
  recoverRange,
  type RecoveredPage,
  recoverMaxMs,
  writeCursor,
  type Line,
} from "../scripts/dev/lane-listen-lib";

test("lineOf keeps the hub's seq, and only a valid one", () => {
  const raw = (seq: unknown) =>
    JSON.stringify({ type: "chat", message: { id: "a", from: "owner", text: "hi", seq } });
  expect(lineOf(raw(7))?.seq).toBe(7);
  expect(lineOf(raw(-1))?.seq).toBeUndefined();
  expect(lineOf(raw("7"))?.seq).toBeUndefined();
});

test("the cursor stops before a held line and moves past passed ones and gaps", () => {
  const c = makeSeqCursor(10);
  c.pass(11);
  expect(c.value()).toBe(11);
  c.hold(13); // 12 never came: a gap the hub explains, not a hold
  c.pass(14);
  expect(c.value()).toBe(12);
  c.release([13]);
  expect(c.value()).toBe(14);
  c.hold(15);
  c.hold(16);
  c.release([16]);
  expect(c.value()).toBe(14); // 15 was lost: recovery reads after 14
  c.hold(9); // at or before the start: already done
  expect(c.value()).toBe(14);
});

test("a receipt covers the newest handed-over line, never past a held one", () => {
  expect(receiptAfter([5, 7], 9, 0)).toBe(7);
  expect(receiptAfter([5, 7], 6, 0)).toBe(6);
  expect(receiptAfter([5, 7], 9, 7)).toBeNull();
  expect(receiptAfter([undefined], 9, 0)).toBeNull();
});

test("the acker posts one at a time and coalesces a burst", async () => {
  const posted: number[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const a = makeAcker(async (s) => {
    posted.push(s);
    if (posted.length === 1) await gate;
    return true;
  });
  const p = a.ack(3);
  a.ack(4);
  a.ack(5);
  a.ack(2);
  release();
  await p;
  expect(posted).toEqual([3, 5]);
  expect(a.last()).toBe(5);
  await a.ack(5);
  expect(posted).toEqual([3, 5]);
});

test("a failed receipt is not counted, and the next one retries", async () => {
  let ok = false;
  const posted: number[] = [];
  const a = makeAcker(async (s) => (posted.push(s), ok));
  await a.ack(4);
  expect(a.last()).toBe(0);
  ok = true;
  await a.ack(4);
  expect(a.last()).toBe(4);
  expect(posted).toEqual([4, 4]);
});

test("the cursor file is the owner's alone and survives a restart", () => {
  const env = { LIANKI_LANE_TOKEN_DIR: join(mkdtempSync(join(tmpdir(), "lane-seq-")), "lanes") };
  expect(readCursor("codex", env)).toBeNull();
  writeCursor("codex", 42, env);
  expect(readCursor("codex", env)).toBe(42);
  expect(statSync(join(env.LIANKI_LANE_TOKEN_DIR, "codex.seq")).mode & 0o077).toBe(0);
  writeCursor("codex", -3, env);
  expect(readCursor("codex", env)).toBe(42);
});

test("a read answer is a page with its coverage; a failure or an old hub is no page", () => {
  const out = JSON.stringify({
    v: 1,
    ok: true,
    command: "chat read",
    data: {
      messages: [{ id: "x", from: "owner", text: "codex 在吗", seq: 9 }],
      throughSeq: 9,
      headSeq: 12,
    },
  });
  const page = recoveredPage(out)!;
  expect(page.throughSeq).toBe(9);
  expect(page.headSeq).toBe(12);
  expect(lineOf(page.lines[0]!)).toMatchObject({ id: "x", seq: 9, history: false });
  expect(recoveredPage("not json")).toBeNull();
  expect(recoveredPage(JSON.stringify({ ok: true, data: { messages: [] } }))).toBeNull();
  expect(
    recoveredPage(JSON.stringify({ ok: false, data: { messages: [], throughSeq: 1, headSeq: 1 } })),
  ).toBeNull();
  expect(recoverMaxMs({})).toBe(120 * 60_000);
  expect(recoverMaxMs({ LANE_RECOVER_MAX_MIN: "5" })).toBe(5 * 60_000);
});

test("the barrier: while recovery is pending the cursor never passes where it began", () => {
  const c = makeSeqCursor(10);
  expect(c.bar()).toBe(10);
  c.hold(50);
  c.release([50]);
  expect(c.value()).toBe(10);
  expect(c.barred()).toBe(true);
  c.lift();
  expect(c.value()).toBe(50);
});

/**
 * lane-listen's own wiring (handle, deliverer, cursor, receipts, recovery),
 * against a synthetic hub with `head` lines and a page limit of 100.
 */
function harness(start: number, hub: { lines: number; fail?: () => boolean }) {
  const cursor = makeSeqCursor(start);
  const delivered: number[] = [];
  const receipts: number[] = [];
  const seen = new Set<string>();
  let saved = start;
  let lastDelivered = -1;
  const raw = (seq: number) =>
    JSON.stringify({
      type: "chat",
      message: {
        id: `s${seq}`,
        from: "owner",
        thread: "owner",
        text: `codex, synthetic ${seq}`,
        seq,
        at: new Date().toISOString(),
      },
    });
  const out = makeDeliverer(
    { lane: "codex", repo: "/synthetic" },
    async () => 0,
    async () => false,
    () => {},
    10,
    (lines: Line[], ok: boolean) => {
      if (!ok) return;
      const seqs = lines.map((l) => l.seq);
      delivered.push(...(seqs as number[]));
      for (const q of seqs as number[]) lastDelivered = Math.max(lastDelivered, q);
      cursor.release(seqs);
      saved = cursor.value();
      const top = Math.max(...(seqs as number[]));
      const r = Math.min(top, cursor.value());
      if (r > (receipts.at(-1) ?? 0)) receipts.push(r);
    },
  );
  const handle = async (line: string) => {
    const l = lineOf(line)!;
    if (seen.has(l.id)) return cursor.pass(l.seq);
    seen.add(l.id);
    cursor.hold(l.seq);
    await out.add(l);
  };
  const read = async (after: number, through?: number): Promise<RecoveredPage | null> => {
    if (hub.fail?.()) return null;
    const end = Math.min(hub.lines, through ?? hub.lines, after + 100);
    const lines = [];
    for (let s = after + 1; s <= end; s++) lines.push(raw(s));
    return { lines, throughSeq: end, headSeq: hub.lines };
  };
  const recover = makeRecovery({
    cursor: () => cursor,
    read,
    handle,
    covered: () => {
      saved = cursor.value();
      const r = liftReceipt(lastDelivered, cursor.value(), receipts.at(-1) ?? 0);
      if (r !== null) receipts.push(r);
    },
    log: () => {},
    sleep: async () => {},
  });
  return { cursor, delivered, receipts, saved: () => saved, handle, raw, recover };
}

test("race (A): a live line during a failing recovery never moves the cursor past the gap", async () => {
  let failures = 2;
  const h = harness(10, { lines: 49, fail: () => failures-- > 0 });
  const running = h.recover();
  // Live line 50 lands while the recovery is still failing.
  await h.handle(h.raw(50));
  expect(h.saved()).toBe(10);
  expect(Math.max(0, ...h.receipts)).toBeLessThanOrEqual(10);
  await running;
  // Retried, then covered: 11..49 were all handed over before the cursor moved.
  for (let s = 11; s <= 50; s++) expect(h.delivered).toContain(s);
  expect(h.cursor.value()).toBe(50);
  expect(h.saved()).toBe(50);
  // The receipt held back by the barrier is sent once it lifts: through 50.
  expect(h.receipts.at(-1)).toBe(50);
});

test("the lift receipt: owed only for lines handed over, never past the cursor", () => {
  expect(liftReceipt(50, 50, 10)).toBe(50);
  expect(liftReceipt(50, 30, 10)).toBe(30);
  expect(liftReceipt(50, 50, 50)).toBeNull();
  expect(liftReceipt(-1, 50, 0)).toBeNull();
});

test("catch-up starts at the socket's ready, once per connection", () => {
  let n = 0;
  const t = catchUpTrigger(() => n++);
  t("not json");
  t(JSON.stringify({ type: "lane", state: "listener" }));
  expect(n).toBe(0);
  t(JSON.stringify({ type: "ready" }));
  t(JSON.stringify({ type: "ready" }));
  t(JSON.stringify({ type: "chat", message: { id: "a", text: "x" } }));
  expect(n).toBe(1);
  // No ready before the first line: the first line starts it.
  let m = 0;
  const u = catchUpTrigger(() => m++);
  u(JSON.stringify({ type: "chat", message: { id: "a", text: "x" } }));
  expect(m).toBe(1);
});

test("ready-bound catch-up: lines before ready are recovered, lines after come live, none lost", async () => {
  const hub = { lines: 20 };
  const h = harness(10, hub);
  let running: Promise<void> | null = null;
  const trigger = catchUpTrigger(() => (running = h.recover()));
  h.cursor.bar(); // the listener bars on connect, before ready
  trigger(JSON.stringify({ type: "ready" }));
  // A line lands right after ready: on the live stream.
  hub.lines = 21;
  await h.handle(h.raw(21));
  await running;
  for (let s = 11; s <= 21; s++) expect(h.delivered).toContain(s);
  expect(h.cursor.value()).toBe(21);
  expect(h.receipts.at(-1)).toBe(21);
});

test("pages (B): a 101-line backlog is read in two pages; seq 101 is never skipped", async () => {
  const h = harness(0, { lines: 101 });
  await h.recover();
  await h.handle(h.raw(102));
  for (let s = 1; s <= 102; s++) expect(h.delivered).toContain(s);
  expect(h.cursor.value()).toBe(102);
});

test("recoverRange: no progress or a failed page is not coverage", async () => {
  const stuck = async (after: number) => ({ lines: [], throughSeq: after, headSeq: after + 5 });
  expect(await recoverRange(0, stuck, async () => {})).toBe(false);
  let n = 0;
  const flaky = async (after: number) =>
    n++ === 0 ? { lines: [], throughSeq: after + 1, headSeq: after + 5 } : null;
  expect(await recoverRange(0, flaky, async () => {})).toBe(false);
  expect(
    await recoverRange(
      0,
      async () => ({ lines: [], throughSeq: 3, headSeq: 3 }),
      async () => {},
    ),
  ).toBe(true);
  const endless = async (after: number) => ({ lines: [], throughSeq: after + 1, headSeq: 10_000 });
  expect(await recoverRange(0, endless, async () => {}, 5)).toBe(false);
});

test("a newer recovery (a reconnect) replaces an older one", async () => {
  const c = makeSeqCursor(5);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let calls = 0;
  const run = makeRecovery({
    cursor: () => c,
    read: async (after) => {
      calls++;
      if (calls === 1) await gate;
      return { lines: [], throughSeq: after, headSeq: after };
    },
    handle: async () => {},
    covered: () => {},
    log: () => {},
    sleep: async () => {},
  });
  const first = run();
  await run();
  release();
  await first;
  expect(c.barred()).toBe(false);
  const none = makeRecovery({
    cursor: () => null,
    read: async () => null,
    handle: async () => {},
    covered: () => {},
    log: () => {},
    sleep: async () => {},
  });
  await none();
});

test("the deliverer reports each hand-over and whether ay took it", async () => {
  const reports: [string[], boolean][] = [];
  let code = 0;
  const d = makeDeliverer(
    { lane: "codex", repo: "/r" },
    async () => code,
    async () => false,
    () => {},
    10,
    (lines: Line[], ok: boolean) => reports.push([lines.map((l) => l.id), ok]),
  );
  await d.add({ id: "a", thread: "owner", from: "owner", text: "codex 看一下", seq: 1 });
  code = 1;
  await d.add({ id: "b", thread: "owner", from: "owner", text: "codex 再看", seq: 2 });
  expect(reports).toEqual([
    [["a"], true],
    [["b"], false],
  ]);
});
