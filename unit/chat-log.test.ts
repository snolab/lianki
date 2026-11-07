import { beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { createTestD1 } from "../lib/d1/testDb";
import { answerText, chatLogLine, parseChatLogLine } from "../lib/chat-log-line";
import { type ChatLogDb, chatLogOp, deleteLine, deleteRange, listHistory } from "../lib/chat-log";
import { deleteHistory, getHistory, type HistoryUser } from "../lib/chat-history-api";
import { byDay, dayRange, plainText } from "../lib/chat-history-view";

const SCHEMA =
  "CREATE TABLE user (id TEXT PRIMARY KEY, email TEXT);\n" +
  "CREATE TABLE site_role (email TEXT, role TEXT, revoked_at INTEGER);\n" +
  readFileSync(new URL("../db/migrations/0057_chat_line.sql", import.meta.url), "utf8");

const T0 = 1_800_000_000_000;
let db: ChatLogDb;
let raw: ReturnType<ReturnType<typeof createTestD1>["raw"]>;

beforeEach(() => {
  const d = createTestD1(SCHEMA);
  raw = d.raw();
  raw.exec(`INSERT INTO user VALUES ('own1', 'owner@example.com'), ('fr1', 'f@example.com'), ('fr2', 'g@example.com');
            INSERT INTO site_role VALUES ('owner@example.com', 'owner', NULL);`);
  db = d as unknown as ChatLogDb;
});

const line = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  from: "owner",
  label: "/words pwa iPhone",
  text: `line ${id}`,
  at: T0,
  ...over,
});
const rows = () => raw.prepare("SELECT * FROM chat_line ORDER BY user_id, at_ms, id").all();

describe("chatLogLine: what is kept, and what never is", () => {
  it("keeps id, from, lane, text, time and the ask flag; nothing else", () => {
    const m = {
      ...line("a1", { source: "stt" }),
      raw: "rough stt",
      parts: [{ text: "rough", at: T0 }],
      scene: { path: "/vibe/x", title: "t", screen: "PRIVATE TRANSCRIPT TEXT" },
      context: { text: "PRIVATE SELECTION", url: "https://lianki.com/read/x" },
      attachments: [{ id: "f1", name: "a.png", type: "image/png", size: 1 }],
      sender: { id: "h", name: "Owner", avatars: ["https://x/y.png"] },
      email: "owner@example.com",
      timing: { sentAt: T0 },
      speaker: { v: 1 },
    };
    const out = chatLogLine(m as never);
    expect(out).toEqual({
      id: "a1",
      from: "owner",
      lane: null,
      text: "line a1",
      at: T0,
      ask: false,
      answer: null,
    });
    const s = JSON.stringify(out);
    for (const secret of ["PRIVATE", "rough", "a.png", "owner@example.com", "/vibe", "iPhone"])
      expect(s).not.toContain(secret);
  });

  it("an agent line's lane: the field, else its 【lane】 prefix (taken off), else main", () => {
    expect(chatLogLine(line("b1", { from: "agent", lane: "codex", text: "hi" }))).toMatchObject({
      lane: "codex",
      text: "hi",
    });
    expect(chatLogLine(line("b2", { from: "agent", text: "【agy】 done" }))).toMatchObject({
      lane: "agy",
      text: "done",
    });
    expect(chatLogLine(line("b3", { from: "agent", text: "plain" }))?.lane).toBe("main");
    // A user's line never gets a lane, whatever it claims.
    expect(chatLogLine(line("b4", { lane: "codex" }))?.lane).toBeNull();
  });

  it("an ask card and its answer: the flag, and the chosen options' labels", () => {
    const ask = {
      askId: "k1",
      questions: [
        {
          id: "q1",
          question: "Ship it?",
          options: [
            { id: "o1", label: "Yes" },
            { id: "o2", label: "No" },
          ],
        },
      ],
    };
    const answer = { choices: { q1: ["o1"] }, source: "tap", thread: "owner", label: "/", at: T0 };
    expect(chatLogLine(line("c1", { from: "agent", ask }))).toMatchObject({
      ask: true,
      answer: null,
    });
    expect(chatLogLine(line("c1", { from: "agent", ask, answer } as never))).toMatchObject({
      ask: true,
      answer: "Yes",
    });
    expect(answerText(undefined, undefined)).toBeNull();
  });

  it("refuses what is not a chat line", () => {
    expect(chatLogLine({ id: "x", from: "system", text: "t", at: T0 })).toBeNull();
    expect(chatLogLine({ id: "bad id!", from: "owner", text: "t", at: T0 })).toBeNull();
    expect(chatLogLine({ id: "x", from: "owner", text: "   ", at: T0 })).toBeNull();
    expect(parseChatLogLine({ id: "x", from: "owner", text: "t", at: "now" })).toBeNull();
  });
});

describe("chatLogOp: the hub's writes", () => {
  const put = (thread: string, ...ls: ReturnType<typeof line>[]) =>
    chatLogOp(db, { op: "put", thread, lines: ls.map((l) => chatLogLine(l)) });

  it("the owner's thread goes to the active owners' accounts; a revoked owner gets none", async () => {
    raw.exec(`INSERT INTO user VALUES ('own2', 'old@example.com');
              INSERT INTO site_role VALUES ('old@example.com', 'owner', 123);`);
    await put("owner", line("o1"));
    expect(rows().map((r) => [r.user_id, r.id, r.thread])).toEqual([["own1", "o1", "owner"]]);
  });

  it("a Learning Partner thread goes to that user alone; an unknown user to nobody", async () => {
    await put("fr1", line("f1", { from: "friend" }));
    await put("ghost", line("g1", { from: "friend" }));
    expect(rows().map((r) => [r.user_id, r.id])).toEqual([["fr1", "f1"]]);
  });

  it("put never overwrites; update changes only a kept line; split adds only while kept", async () => {
    await put("owner", line("p1"));
    await put("owner", line("p1", { text: "changed by a replay" }));
    expect(rows()[0]!.text).toBe("line p1");
    await chatLogOp(db, {
      op: "update",
      thread: "owner",
      lines: [chatLogLine(line("p1", { text: "polished" }))],
    });
    expect(rows()[0]!.text).toBe("polished");
    // A deleted line is not brought back by a later edit or split.
    await deleteLine(db, "own1", "p1");
    await chatLogOp(db, {
      op: "update",
      thread: "owner",
      lines: [chatLogLine(line("p1", { text: "again" }))],
    });
    await chatLogOp(db, {
      op: "split",
      thread: "owner",
      id: "p1",
      lines: [chatLogLine(line("p1")), chatLogLine(line("p2"))],
    });
    expect(rows()).toEqual([]);
  });

  it("backfill: the owner's thread only, once per account (a deleted line stays deleted)", async () => {
    const lines = [chatLogLine(line("h1")), chatLogLine(line("h2", { at: T0 + 1 }))];
    expect(await chatLogOp(db, { op: "backfill", thread: "fr1", lines })).toMatchObject({
      ok: false,
    });
    await chatLogOp(db, { op: "backfill", thread: "owner", lines });
    expect(rows().length).toBe(2);
    await deleteLine(db, "own1", "h1");
    await chatLogOp(db, { op: "backfill", thread: "owner", lines });
    expect(rows().map((r) => r.id)).toEqual(["h2"]);
  });

  it("refuses a bad request, writes nothing", async () => {
    for (const r of [
      null,
      { op: "drop", thread: "owner", lines: [] },
      { op: "put", thread: "owner" },
    ])
      expect(await chatLogOp(db, r)).toMatchObject({ ok: false });
    expect(await chatLogOp(undefined, { op: "put", thread: "owner", lines: [] })).toMatchObject({
      ok: false,
    });
    expect(rows()).toEqual([]);
  });
});

describe("history: account isolation, search, lanes, pages, delete", () => {
  beforeEach(async () => {
    const mk = (id: string, at: number, over: Record<string, unknown> = {}) =>
      chatLogLine(line(id, { at, ...over }))!;
    await chatLogOp(db, {
      op: "put",
      thread: "owner",
      lines: [
        mk("a", T0, { text: "Hello 100% done_now" }),
        mk("b", T0 + 1000, { from: "agent", lane: "codex", text: "codex says hello" }),
        mk("c", T0 + 2000, { from: "agent", text: "main says hi" }),
        mk("d", T0 + 86_400_000, { text: "next day" }),
      ],
    });
    await chatLogOp(db, {
      op: "put",
      thread: "fr1",
      lines: [mk("z", T0, { from: "friend", text: "friend hello" })],
    });
  });

  it("newest first, only the caller's own account", async () => {
    expect((await listHistory(db, "own1")).lines.map((l) => l.id)).toEqual(["d", "c", "b", "a"]);
    expect((await listHistory(db, "fr1")).lines.map((l) => l.id)).toEqual(["z"]);
    expect((await listHistory(db, "fr2")).lines).toEqual([]);
  });

  it("search is case-insensitive, and % and _ are literal", async () => {
    expect((await listHistory(db, "own1", { q: "HELLO" })).lines.map((l) => l.id)).toEqual([
      "b",
      "a",
    ]);
    expect((await listHistory(db, "own1", { q: "100%" })).lines.map((l) => l.id)).toEqual(["a"]);
    expect((await listHistory(db, "own1", { q: "o_1" })).lines).toEqual([]);
    expect((await listHistory(db, "own1", { q: "done_now" })).lines.map((l) => l.id)).toEqual([
      "a",
    ]);
  });

  it("lane filter: you, main, one lane", async () => {
    const ids = async (lane: "you" | "main" | "codex" | "agy") =>
      (await listHistory(db, "own1", { lane })).lines.map((l) => l.id);
    expect(await ids("you")).toEqual(["d", "a"]);
    expect(await ids("main")).toEqual(["c"]);
    expect(await ids("codex")).toEqual(["b"]);
    expect(await ids("agy")).toEqual([]);
  });

  it("pages by cursor, with no line twice or missed", async () => {
    const one = await listHistory(db, "own1", { limit: 3 });
    expect(one.lines.map((l) => l.id)).toEqual(["d", "c", "b"]);
    const two = await listHistory(db, "own1", { limit: 3, ...one.next! });
    expect(two.lines.map((l) => l.id)).toEqual(["a"]);
    expect(two.next).toBeNull();
  });

  it("delete: one line, a day; another account's line is not found", async () => {
    expect(await deleteLine(db, "fr1", "a")).toBe(false);
    expect(await deleteLine(db, "own1", "z")).toBe(false);
    expect(await deleteLine(db, "own1", "a")).toBe(true);
    expect(await deleteRange(db, "own1", T0, T0 + 86_400_000)).toBe(2);
    expect((await listHistory(db, "own1")).lines.map((l) => l.id)).toEqual(["d"]);
    expect((await listHistory(db, "fr1")).lines.map((l) => l.id)).toEqual(["z"]);
  });
});

describe("/api/chat/history handlers", () => {
  let who: HistoryUser | null;
  let backfills = 0;
  const deps = () => ({
    who: async () => who,
    db: () => db,
    backfill: async () => {
      backfills++;
      await chatLogOp(db, { op: "backfill", thread: "owner", lines: [] });
    },
  });
  const del = (body: unknown) =>
    deleteHistory(
      new Request("https://lianki.com/api/chat/history", {
        method: "DELETE",
        body: JSON.stringify(body),
      }),
      deps(),
    );
  beforeEach(async () => {
    backfills = 0;
    await chatLogOp(db, {
      op: "put",
      thread: "owner",
      lines: [chatLogLine(line("o1", { text: "owner secret plan" }))],
    });
  });

  it("no session: 404 for reading and deleting", async () => {
    who = null;
    expect(
      (await getHistory(new Request("https://lianki.com/api/chat/history"), deps())).status,
    ).toBe(404);
    expect((await del({ id: "o1" })).status).toBe(404);
  });

  it("another account sees none of the owner's lines and cannot delete them (404)", async () => {
    who = { id: "fr1", owner: false };
    const r = await getHistory(new Request("https://lianki.com/api/chat/history?q=secret"), deps());
    expect(((await r.json()) as { lines: unknown[] }).lines).toEqual([]);
    expect((await del({ id: "o1" })).status).toBe(404);
    expect(rows().length).toBe(1);
    expect(backfills).toBe(0);
  });

  it("the owner reads and searches; the backfill runs once", async () => {
    who = { id: "own1", owner: true };
    const get = (q = "") =>
      getHistory(new Request(`https://lianki.com/api/chat/history${q}`), deps());
    const out = (await (await get("?q=plan&lane=you")).json()) as { lines: { id: string }[] };
    expect(out.lines.map((l) => l.id)).toEqual(["o1"]);
    await get();
    expect(backfills).toBe(1);
  });

  it("delete: a line, a day; a range over a day and a bit is refused", async () => {
    who = { id: "own1", owner: true };
    expect((await del({ from: T0, to: T0 + 30 * 3600_000 })).status).toBe(400);
    expect((await del({ from: T0, to: T0 + 1000 })).status).toBe(200);
    expect(rows()).toEqual([]);
    expect((await del({ id: "o1" })).status).toBe(404);
  });
});

describe("the page's helpers", () => {
  it("groups by local day, newest first, and a day's bounds are local midnights", () => {
    const a = new Date(2026, 10, 7, 23, 0).getTime();
    const b = new Date(2026, 10, 7, 1, 0).getTime();
    const c = new Date(2026, 10, 6, 12, 0).getTime();
    const g = byDay([{ at: a }, { at: b }, { at: c }]);
    expect(g.map((x) => [x.day, x.lines.length])).toEqual([
      ["2026-11-07", 2],
      ["2026-11-06", 1],
    ]);
    expect(dayRange("2026-11-07")).toEqual({
      from: new Date(2026, 10, 7).getTime(),
      to: new Date(2026, 10, 8).getTime(),
    });
  });

  it("an agent line's rich-text tags are shown plain", () => {
    expect(plainText("<b>Done</b> &amp; shipped<br>next")).toBe("Done & shipped\nnext");
    expect(plainText("no tags")).toBe("no tags");
  });
});
