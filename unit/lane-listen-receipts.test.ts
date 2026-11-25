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
  recoveredLines,
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

test("recovered lines read as listener lines; a bad answer gives none", () => {
  const out = JSON.stringify({
    v: 1,
    ok: true,
    command: "chat read",
    data: { messages: [{ id: "x", from: "owner", text: "codex 在吗", seq: 9 }], headSeq: 9 },
  });
  const lines = recoveredLines(out);
  expect(lines).toHaveLength(1);
  expect(lineOf(lines[0]!)).toMatchObject({ id: "x", seq: 9, history: false });
  expect(recoveredLines("not json")).toEqual([]);
  expect(recoverMaxMs({})).toBe(120 * 60_000);
  expect(recoverMaxMs({ LANE_RECOVER_MAX_MIN: "5" })).toBe(5 * 60_000);
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
