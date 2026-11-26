/**
 * Chat wake (docs/chat-wake.md; lib/chat-wake/*): the chat_mention row, the
 * one wake() fan-out, the pull adapter (the tool's chat/mentions and SEP-3415
 * events/poll). Scope (only the token's own thread and mentions), cursor
 * paging, the flag gates, the loop guard, dedupe, retention, the rate cap.
 * Synthetic data only: example.com accounts, tokens minted in an in-memory D1.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { createTestD1, type TestD1Database } from "../lib/d1/testDb";
import { testSchema } from "../lib/d1/testSchema";
import type { D1Like } from "../lib/d1/types";
import { createToken, revokeToken } from "../lib/api-tokens";
import { CONFIG, defaultConfig } from "../lib/config";
import { FLAGS } from "../lib/flags";
import { eventsLimits } from "../lib/mcp-events/rules";
import { eventsRpc, mentionEvents, type EventsDeps } from "../lib/mcp-events/server";
import { wake, wakeOnPut } from "../lib/chat-wake/core";
import {
  WAKE_PULL_FLAG,
  cursorTruncated,
  decodeCursor,
  dedupe,
  encodeCursor,
  mentionId,
  pageSize,
  wakeLimits,
  type WakeAdapter,
  type WakeEvent,
  type WakeLimits,
  type WakeReport,
} from "../lib/chat-wake/rules";
import { TOOLS } from "../packages/lianki-cli/mcp-tools.mjs";
import { handle, type Env } from "../workers/mcp/src/mcp";

let db: TestD1Database;
let now: number;
let eventsOn: boolean;
let pullOn: boolean;
let limits: WakeLimits;
let arden: { token: string; id: string };
let bo: { token: string; id: string };

const D = () => db as unknown as D1Like;
const DAY = 86_400_000;

function deps(over: Partial<EventsDeps> = {}): EventsDeps {
  return {
    db: D(),
    flagOn: async () => eventsOn,
    pullOn: async () => pullOn,
    wakeLimits: async () => limits,
    limits: async () => ({ ...eventsLimits(defaultConfig()), callbackHosts: [] }),
    sealSecret: "s".repeat(40),
    fetch: async () => {
      throw new Error("no network in these tests");
    },
    resolve: async () => null,
    now: () => now,
    sleep: async () => {},
    ...over,
  };
}

const put = (
  text: string,
  id = "l1",
  from: "owner" | "friend" | "agent" = "owner",
  thread = "owner",
) => ({
  op: "put",
  thread,
  lines: [{ id, from, lane: from === "agent" ? "main" : null, text, at: now }],
});

const rows = () =>
  db.raw().prepare("SELECT * FROM chat_mention ORDER BY seq").all() as {
    id: string;
    token_id: string;
    thread: string;
    line_id: string;
    text: string;
    author: string;
    created_at: number;
  }[];

async function mint(userId: string, email: string, name: string, scopes = ["chat:read"]) {
  const t = await createToken(
    D(),
    { userId, email },
    { name, scopes: scopes as never, expiresAt: new Date(now + 30 * DAY) },
    now,
  );
  return { token: t.token, id: t.id };
}

type Res = { result?: Record<string, unknown>; error?: { code: number; message: string } };
const rpc = async (token: string, method: string, params: unknown = {}) =>
  (await eventsRpc(deps(), token, { method, params })).body as Res;

beforeEach(async () => {
  db = createTestD1(testSchema());
  db.raw().exec(
    `INSERT INTO user(id,email,emailVerified,createdAt,updatedAt) VALUES
     ('owner1','owner@example.com',1,'2026-11-01','2026-11-01'),
     ('user2','user2@example.com',1,'2026-11-01','2026-11-01');
     INSERT INTO account_permission (email, permission, granted_by, granted_at)
     VALUES ('owner@example.com','dev','test',1);`,
  );
  now = Date.parse("2026-11-27T00:00:00Z");
  eventsOn = true;
  pullOn = true;
  limits = wakeLimits(defaultConfig());
  arden = await mint("owner1", "owner@example.com", "Arden");
  bo = await mint("owner1", "owner@example.com", "Bo");
});

describe("rules", () => {
  test("the event id is deterministic per token and line", async () => {
    const a = await mentionId("h1", "l1");
    expect(a).toMatch(/^men_[0-9a-f]{32}$/);
    expect(await mentionId("h1", "l1")).toBe(a);
    expect(await mentionId("h2", "l1")).not.toBe(a);
    expect(await mentionId("h1", "l2")).not.toBe(a);
  });

  test("the cursor round-trips and refuses anything else", () => {
    const c = { at: now, seq: 42 };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
    for (const bad of ["", "w1.1.2", "w2.x.2", "w2.1", 7, null, `w2.${"9".repeat(40)}.1`])
      expect(decodeCursor(bad)).toBeNull();
    // A cursor naming a row: truncated exactly when that row is gone.
    expect(cursorTruncated({ at: now, seq: 1 }, false, now, limits)).toBe(true);
    expect(cursorTruncated({ at: now - 30 * DAY, seq: 1 }, true, now, limits)).toBe(false);
    // A cursor naming no row: truncated when older than retention.
    expect(cursorTruncated({ at: now - limits.retentionMs - 1, seq: 0 }, false, now, limits)).toBe(
      true,
    );
    expect(cursorTruncated({ at: now - 1000, seq: 0 }, false, now, limits)).toBe(false);
  });

  test("page size: the default, at most 100, a whole number", () => {
    expect(pageSize(undefined, limits)).toBe(20);
    expect(pageSize(5, limits)).toBe(5);
    expect(pageSize(1000, limits)).toBe(100);
    expect(pageSize(0, limits)).toBeNull();
    expect(pageSize(1.5, limits)).toBeNull();
    expect(pageSize("3", limits)).toBeNull();
  });

  test("dedupe keeps the first of each event id", () => {
    const e = (id: string, text: string) => ({ id, text }) as unknown as WakeEvent;
    expect(dedupe([e("a", "1"), e("b", "2"), e("a", "3")]).map((x) => x.text)).toEqual(["1", "2"]);
  });

  test("defaults live in the config registry; the pull flag ships on, owner audience", () => {
    for (const k of [
      "chat.wakeRetentionDays",
      "chat.wakePerMinute",
      "chat.wakeMaxTokens",
      "chat.wakePullTtlMin",
      "chat.wakePullLimit",
      "chat.wakePullPerMinute",
      "chat.wakeNextPollMs",
    ])
      expect(k in CONFIG).toBe(true);
    expect(limits.retentionMs).toBe(7 * DAY);
    expect(FLAGS[WAKE_PULL_FLAG].default).toBe(true);
    expect(FLAGS[WAKE_PULL_FLAG].audience).toBe("owner");
  });
});

describe("the core: one row per mention", () => {
  test("a person naming the token: one row with the line, in its thread", async () => {
    const r = await mentionEvents(deps(), put("@Arden what is due?", "l1", "friend"));
    expect(r.recorded).toBe(1);
    const [m] = rows();
    expect(m).toMatchObject({
      id: await mentionId(arden.id, "l1"),
      token_id: arden.id,
      thread: "owner",
      line_id: "l1",
      text: "@Arden what is due?",
      author: "friend",
      created_at: now,
    });
  });

  test("only the named token: @Arden writes nothing for Bo", async () => {
    await mentionEvents(deps(), put("@Arden and Bo, not @Bob"));
    expect(rows().map((m) => m.token_id)).toEqual([arden.id]);
    await mentionEvents(deps(), put("@Arden @Bo both", "l2"));
    expect(rows().filter((m) => m.line_id === "l2")).toHaveLength(2);
  });

  test("the loop guard: an agent's line, even naming itself, writes nothing", async () => {
    const r = await mentionEvents(deps(), put("【Arden】 noted, @Arden here", "a1", "agent"));
    expect(r.recorded).toBe(0);
    expect(rows()).toEqual([]);
  });

  test("another thread, a site sub-thread, or an account outside the audience: nothing", async () => {
    await mint("user2", "user2@example.com", "Arden");
    await mentionEvents(deps(), put("@Arden", "l1", "owner", "user2"));
    await mentionEvents(deps(), put("@Arden", "l2", "owner", "owner~abcdef12"));
    await mentionEvents(deps(), put("@Arden", "l3", "owner", "not a thread"));
    expect(rows()).toEqual([]);
  });

  test("a token without chat:read, expired or revoked is never recorded", async () => {
    await mint("owner1", "owner@example.com", "Cy", ["chat:write"]);
    await mentionEvents(deps(), put("@Cy hi"));
    expect(rows()).toEqual([]);
    db.raw().exec(
      `UPDATE api_tokens SET expires_at = '2026-11-26T00:00:00.000Z' WHERE name = 'Bo'`,
    );
    await mentionEvents(deps(), put("@Bo hi", "l2"));
    expect(rows()).toEqual([]);
  });

  test("dedupe: a line put again, or twice in one put, is one row", async () => {
    expect((await mentionEvents(deps(), put("@Arden"))).recorded).toBe(1);
    expect((await mentionEvents(deps(), put("@Arden"))).recorded).toBe(0);
    const twice = {
      ...put("@Arden", "l9"),
      lines: [put("@Arden", "l9").lines[0], put("@Arden", "l9").lines[0]],
    };
    await mentionEvents(deps(), twice);
    expect(rows().map((m) => m.line_id)).toEqual(["l1", "l9"]);
  });

  test("the per-token rate cap on new rows", async () => {
    limits = { ...limits, perMinute: 2 };
    for (let i = 0; i < 4; i++) await mentionEvents(deps(), put("@Arden", `m${i}`));
    expect(rows()).toHaveLength(2);
    now += 61_000;
    await mentionEvents(deps(), put("@Arden", "m9"));
    expect(rows()).toHaveLength(3);
  });

  test("the flag mcp.events off: nothing written", async () => {
    eventsOn = false;
    await mentionEvents(deps(), put("@Arden"));
    expect(rows()).toEqual([]);
  });

  test("chat.wake.pull off: rows still kept (the core), reading refused", async () => {
    pullOn = false;
    await mentionEvents(deps(), put("@Arden"));
    expect(rows()).toHaveLength(1);
    expect((await rpc(arden.token, "chat/mentions")).error?.code).toBe(-32601);
  });

  test("revoking the token deletes its mentions (D1 trigger)", async () => {
    await mentionEvents(deps(), put("@Arden @Bo"));
    await revokeToken(D(), { userId: "owner1", email: "owner@example.com" }, arden.id);
    expect(rows().map((m) => m.token_id)).toEqual([bo.id]);
  });
});

describe("wake(): one fan-out per token", () => {
  test("each enabled adapter gets the token's events once; a failing one stops no other", async () => {
    const got: { adapter: string; ids: string[]; fresh: boolean[] }[] = [];
    const adapter = (id: string, on: boolean, boom = false): WakeAdapter<EventsDeps> => ({
      id,
      mode: "push",
      enabled: async () => on,
      wake: async (_d, t, events) => {
        if (boom) throw new Error("down");
        got.push({
          adapter: id,
          ids: events.map((e) => e.lineId),
          fresh: events.map((e) => e.fresh),
        });
        expect(t.tokenHash).toBe(arden.id);
      },
    });
    const list = [adapter("boom", true, true), adapter("a", true), adapter("off", false)];
    await wakeOnPut(deps(), put("@Arden"), list);
    await wakeOnPut(deps(), put("@Arden"), list);
    expect(got).toEqual([
      { adapter: "a", ids: ["l1"], fresh: [true] },
      { adapter: "a", ids: ["l1"], fresh: [false] },
    ]);
  });

  test("wake() dedupes on the event id", async () => {
    const seen: string[] = [];
    const a: WakeAdapter<EventsDeps> = {
      id: "x",
      mode: "push",
      enabled: async () => true,
      wake: async (_d, _t, events) => void seen.push(...events.map((e) => e.id)),
    };
    const e = { id: "men_1" } as WakeEvent;
    const report: WakeReport = { delivered: 0, skipped: 0, dropped: 0, recorded: 0 };
    await wake(deps(), {} as never, [e, e, { id: "men_2" } as WakeEvent], [a], report);
    expect(seen).toEqual(["men_1", "men_2"]);
  });

  test("a push adapter hears when a token it routes to is not live", async () => {
    const heard: string[] = [];
    const a: WakeAdapter<EventsDeps> = {
      id: "x",
      mode: "push",
      enabled: async () => true,
      tokensIn: async () => [bo.id],
      notLive: async (_d, h, _t, why) => void heard.push(`${h === bo.id}:${why}`),
      wake: async () => {},
    };
    db.raw().exec(`UPDATE account_permission SET revoked_at = 2`);
    await wakeOnPut(deps(), put("@Bo"), [a]);
    expect(heard).toEqual(["true:audience"]);
  });
});

describe("pull: chat/mentions (the tool)", () => {
  test("only the caller's own mentions, never another token's", async () => {
    await mentionEvents(deps(), put("@Arden one"));
    await mentionEvents(deps(), put("@Bo two", "l2"));
    const a = (await rpc(arden.token, "chat/mentions")).result!;
    expect((a.mentions as { text: string }[]).map((m) => m.text)).toEqual(["@Arden one"]);
    expect(a.mentions).toEqual([
      {
        id: await mentionId(arden.id, "l1"),
        lineId: "l1",
        text: "@Arden one",
        author: "owner",
        at: new Date(now).toISOString(),
      },
    ]);
    const b = (await rpc(bo.token, "chat/mentions")).result!;
    expect((b.mentions as { text: string }[]).map((m) => m.text)).toEqual(["@Bo two"]);
  });

  test("a token outside the audience gets nothing at all; one without chat:read is asked for it", async () => {
    await mentionEvents(deps(), put("@Arden"));
    const other = await mint("user2", "user2@example.com", "Arden");
    expect((await rpc(other.token, "chat/mentions")).error?.code).toBe(-32601);
    const w = await mint("owner1", "owner@example.com", "W", ["chat:write"]);
    expect((await rpc(w.token, "chat/mentions")).error?.code).toBe(-32003);
  });

  test("cursor paging: pages in order, hasMore, then only newer ones", async () => {
    for (let i = 0; i < 5; i++) await mentionEvents(deps(), put(`@Arden ${i}`, `m${i}`));
    const texts = (r: Res) => (r.result!.mentions as { text: string }[]).map((m) => m.text);
    const p1 = await rpc(arden.token, "chat/mentions", { limit: 2 });
    expect(texts(p1)).toEqual(["@Arden 0", "@Arden 1"]);
    expect(p1.result!.hasMore).toBe(true);
    const p2 = await rpc(arden.token, "chat/mentions", { limit: 2, cursor: p1.result!.cursor });
    expect(texts(p2)).toEqual(["@Arden 2", "@Arden 3"]);
    const p3 = await rpc(arden.token, "chat/mentions", { limit: 2, cursor: p2.result!.cursor });
    expect(texts(p3)).toEqual(["@Arden 4"]);
    expect(p3.result!.hasMore).toBe(false);
    const p4 = await rpc(arden.token, "chat/mentions", { cursor: p3.result!.cursor });
    expect(texts(p4)).toEqual([]);
    expect(decodeCursor(p4.result!.cursor)?.seq).toBe(decodeCursor(p3.result!.cursor)?.seq);
    await mentionEvents(deps(), put("@Arden new", "m9"));
    expect(texts(await rpc(arden.token, "chat/mentions", { cursor: p4.result!.cursor }))).toEqual([
      "@Arden new",
    ]);
  });

  test("no cursor: only the recent window; an empty window still returns a usable cursor", async () => {
    await mentionEvents(deps(), put("@Arden old", "old"));
    now += limits.pullTtlMs + 1;
    const r = (await rpc(arden.token, "chat/mentions")).result!;
    expect(r.mentions).toEqual([]);
    await mentionEvents(deps(), put("@Arden fresh", "new"));
    const next = (await rpc(arden.token, "chat/mentions", { cursor: r.cursor })).result!;
    expect((next.mentions as { text: string }[]).map((m) => m.text)).toEqual(["@Arden fresh"]);
  });

  test("bad cursor or limit: invalid params", async () => {
    expect((await rpc(arden.token, "chat/mentions", { cursor: "nope" })).error?.code).toBe(-32602);
    expect((await rpc(arden.token, "chat/mentions", { limit: 0 })).error?.code).toBe(-32602);
  });

  test("retention: old rows are deleted, and an old cursor says truncated", async () => {
    await mentionEvents(deps(), put("@Arden"));
    const c = (await rpc(arden.token, "chat/mentions")).result!.cursor as string;
    await mentionEvents(deps(), put("@Arden later", "l2"));
    now += limits.retentionMs + 1;
    const r = (await rpc(arden.token, "chat/mentions", { cursor: c })).result!;
    expect(r.mentions).toEqual([]);
    expect(r.truncated).toBe(true);
    expect(rows()).toEqual([]);
  });

  test("the per-token pull rate cap", async () => {
    limits = { ...limits, pullPerMinute: 2 };
    expect((await rpc(arden.token, "chat/mentions")).result).toBeDefined();
    expect((await rpc(arden.token, "chat/mentions")).result).toBeDefined();
    expect((await rpc(arden.token, "chat/mentions")).error?.code).toBe(-32005);
  });

  test("the flags: mcp.events off or chat.wake.pull off is Method not found", async () => {
    eventsOn = false;
    expect((await rpc(arden.token, "chat/mentions")).error?.code).toBe(-32601);
    eventsOn = true;
    pullOn = false;
    expect((await rpc(arden.token, "chat/mentions")).error?.code).toBe(-32601);
    expect((await rpc(arden.token, "events/poll", { name: "chat.mention" })).error?.code).toBe(
      -32601,
    );
  });
});

describe("pull: SEP-3415 events/poll", () => {
  const poll = (cursor: unknown, over: Record<string, unknown> = {}) =>
    rpc(arden.token, "events/poll", { name: "chat.mention", arguments: {}, cursor, ...over });

  test("a null cursor bootstraps from now; then each mention once, as an EventOccurrence", async () => {
    await mentionEvents(deps(), put("@Arden before"));
    const boot = (await poll(null)).result!;
    expect(boot).toMatchObject({
      resultType: "complete",
      events: [],
      truncated: false,
      hasMore: false,
    });
    expect(boot.nextPollMs).toBe(limits.nextPollMs);
    await mentionEvents(deps(), put("@Arden after", "l2", "friend"));
    const r = (await poll(boot.cursor)).result!;
    expect(r.events).toEqual([
      {
        eventId: await mentionId(arden.id, "l2"),
        name: "chat.mention",
        timestamp: new Date(now).toISOString(),
        data: { id: "l2", text: "@Arden after", author: "friend" },
      },
    ]);
    expect((await poll(r.cursor)).result!.events).toEqual([]);
  });

  test("maxEvents pages with hasMore; maxAgeMs is a floor", async () => {
    const boot = (await poll(null)).result!;
    for (let i = 0; i < 3; i++) await mentionEvents(deps(), put(`@Arden ${i}`, `m${i}`));
    const r = (await poll(boot.cursor, { maxEvents: 2 })).result!;
    expect((r.events as unknown[]).length).toBe(2);
    expect(r.hasMore).toBe(true);
    now += 10 * 60_000;
    expect((await poll(boot.cursor, { maxAgeMs: 60_000 })).result!.events).toEqual([]);
  });

  test("unknown event, arguments, or a bad cursor: invalid params", async () => {
    expect((await poll(null, { name: "chat.other" })).error?.code).toBe(-32602);
    expect((await poll(null, { arguments: { thread: "user2" } })).error?.code).toBe(-32602);
    expect((await poll("w9.1.1")).error?.code).toBe(-32602);
  });

  test("events/list adds poll delivery only while chat.wake.pull is on", async () => {
    type L = { result: { events: { delivery: string[] }[] } };
    expect(((await rpc(arden.token, "events/list")) as L).result.events[0].delivery).toEqual([
      "webhook",
      "poll",
    ]);
    pullOn = false;
    expect(((await rpc(arden.token, "events/list")) as L).result.events[0].delivery).toEqual([
      "webhook",
    ]);
  });
});

describe("the MCP tool and the remote server", () => {
  const tool = TOOLS.find((t) => t.name === "lianki_chat_mentions_since")!;

  test("the tool needs chat:read and calls chat/mentions on the events route", async () => {
    expect(tool.scope).toBe("chat:read");
    const calls: unknown[] = [];
    const api = async (r: unknown) => {
      calls.push(r);
      return { result: { mentions: [{ text: "@Arden" }], cursor: "w1.3.1", hasMore: false } };
    };
    const out = await tool.run(api as never, { cursor: "w1.1.1", limit: 5 } as never, {} as never);
    expect(out).toEqual({
      mentions: [{ text: "@Arden" }],
      cursor: "w1.3.1",
      hasMore: false,
      truncated: false,
    });
    expect(calls).toEqual([
      {
        method: "POST",
        path: "/api/mcp-events",
        body: { method: "chat/mentions", params: { cursor: "w1.1.1", limit: 5 } },
      },
    ]);
  });

  test("off: the tool says so instead of returning an empty list", async () => {
    const api = async () => ({ error: { code: -32601, message: "Method not found" } });
    await expect(tool.run(api as never, {} as never, {} as never)).rejects.toThrow(
      /not switched on/,
    );
  });

  test("lianki-mcp forwards events/poll with the caller's token", async () => {
    const TOKEN = `lk_${"a".repeat(64)}`;
    const seen: string[] = [];
    const main = {
      fetch: async (req: Request) => {
        const body = await req.text();
        if (new URL(req.url).pathname === "/api/mcp-events") {
          seen.push(`${req.headers.get("authorization")}|${JSON.parse(body).method}`);
          return Response.json({
            result: { resultType: "complete", events: [], cursor: "w1.0.1" },
          });
        }
        return new Response("", { status: 404 });
      },
    };
    const res = await handle(
      new Request("https://lianki.com/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "events/poll",
          params: { name: "chat.mention", cursor: null },
        }),
      }),
      { MAIN: main, PUSH: main } as unknown as Env,
    );
    expect(((await res.json()) as { result: { cursor: string } }).result.cursor).toBe("w1.0.1");
    expect(seen).toEqual([`Bearer ${TOKEN}|events/poll`]);
  });
});

describe("review fixes: a stable cursor across expiry, retention for idle tokens", () => {
  const texts = (r: Res) => (r.result!.mentions as { text: string }[]).map((m) => m.text);
  const at = (i: number) => Date.parse("2026-11-27T00:00:00Z") + i * DAY;

  test("rows expiring between pages: nothing still kept is skipped, and the gap is reported", async () => {
    // m0..m4 one day apart; page through two at a time while time moves on.
    for (let i = 0; i < 5; i++) {
      now = at(i);
      await mentionEvents(deps(), put(`@Arden ${i}`, `m${i}`));
    }
    const p1 = await rpc(arden.token, "chat/mentions", { limit: 2, cursor: "w2.0.0" });
    expect(texts(p1)).toEqual(["@Arden 0", "@Arden 1"]);
    // m0 and m1 (the cursor's own row) pass retention; m2..m4 are still kept.
    now = at(1) + limits.retentionMs + 1;
    const p2 = await rpc(arden.token, "chat/mentions", { limit: 2, cursor: p1.result!.cursor });
    expect(texts(p2)).toEqual(["@Arden 2", "@Arden 3"]);
    expect(p2.result!.truncated).toBe(true);
    const p3 = await rpc(arden.token, "chat/mentions", { limit: 2, cursor: p2.result!.cursor });
    expect(texts(p3)).toEqual(["@Arden 4"]);
    expect(p3.result!.truncated).toBe(false);
  });

  test("rows before the cursor expiring do not shift it, and are not a gap", async () => {
    for (let i = 0; i < 3; i++) {
      now = at(i);
      await mentionEvents(deps(), put(`@Arden ${i}`, `m${i}`));
    }
    const p1 = await rpc(arden.token, "chat/mentions", { limit: 2, cursor: "w2.0.0" });
    now = at(0) + limits.retentionMs + 1; // only m0 expires
    const p2 = await rpc(arden.token, "chat/mentions", { cursor: p1.result!.cursor });
    expect(texts(p2)).toEqual(["@Arden 2"]);
    expect(p2.result!.truncated).toBe(false);
  });

  test("an empty page after a gap reports it once, then moves on", async () => {
    await mentionEvents(deps(), put("@Arden"));
    const c = (await rpc(arden.token, "chat/mentions")).result!.cursor;
    now += limits.retentionMs + 1;
    const r1 = (await rpc(arden.token, "chat/mentions", { cursor: c })).result!;
    expect(r1.truncated).toBe(true);
    const r2 = (await rpc(arden.token, "chat/mentions", { cursor: r1.cursor })).result!;
    expect(r2.truncated).toBe(false);
    await mentionEvents(deps(), put("@Arden again", "l2"));
    expect(texts(await rpc(arden.token, "chat/mentions", { cursor: r2.cursor }))).toEqual([
      "@Arden again",
    ]);
  });

  test("rows written in the same millisecond page one by one, none lost", async () => {
    const people = [0, 1, 2].map((i) => ({
      id: `s${i}`,
      from: "owner",
      text: `@Arden ${i}`,
      at: now,
    }));
    await mentionEvents(deps(), { op: "put", thread: "owner", lines: people });
    let c: unknown = "w2.0.0";
    const got: string[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await rpc(arden.token, "chat/mentions", { limit: 1, cursor: c });
      got.push(...texts(r));
      c = r.result!.cursor;
    }
    expect(got).toEqual(["@Arden 0", "@Arden 1", "@Arden 2"]);
  });

  test("events/poll pages by the same stable cursor", async () => {
    const boot = (await rpc(arden.token, "events/poll", { name: "chat.mention", cursor: null }))
      .result!;
    for (let i = 0; i < 3; i++) {
      now = at(i);
      await mentionEvents(deps(), put(`@Arden ${i}`, `m${i}`));
    }
    const first = (
      await rpc(arden.token, "events/poll", {
        name: "chat.mention",
        cursor: boot.cursor,
        maxEvents: 1,
      })
    ).result!;
    now = at(0) + limits.retentionMs + 1;
    const next = (
      await rpc(arden.token, "events/poll", { name: "chat.mention", cursor: first.cursor })
    ).result!;
    expect((next.events as { data: { id: string } }[]).map((e) => e.data.id)).toEqual(["m1", "m2"]);
    expect(next.truncated).toBe(true);
  });

  test("a token that never polls and is never named again still loses its expired rows", async () => {
    await mentionEvents(deps(), put("@Bo one", "b1"));
    await mentionEvents(deps(), put("@Bo two", "b2"));
    now += limits.retentionMs + 1;
    // Only Arden is named from now on; Bo is idle.
    await mentionEvents(deps(), put("@Arden", "a1"));
    expect(rows().map((m) => m.line_id)).toEqual(["a1"]);
  });

  test("the cleanup per write is bounded", async () => {
    limits = { ...limits, purgeBatch: 1 };
    for (let i = 0; i < 3; i++) await mentionEvents(deps(), put("@Bo", `b${i}`));
    now += limits.retentionMs + 1;
    await mentionEvents(deps(), put("@Arden", "a1"));
    expect(rows().map((m) => m.line_id)).toEqual(["b1", "b2", "a1"]);
    await mentionEvents(deps(), put("@Arden", "a2"));
    expect(rows().map((m) => m.line_id)).toEqual(["b2", "a1", "a2"]);
  });

  test("the per-token cap keeps the newest rows; a cursor on a dropped row is a gap", async () => {
    limits = { ...limits, maxPerToken: 3 };
    await mentionEvents(deps(), put("@Arden 0", "m0"));
    const c = (await rpc(arden.token, "chat/mentions")).result!.cursor;
    for (let i = 1; i < 6; i++) {
      now += 1000;
      await mentionEvents(deps(), put(`@Arden ${i}`, `m${i}`));
    }
    expect(rows().map((m) => m.line_id)).toEqual(["m3", "m4", "m5"]);
    const r = await rpc(arden.token, "chat/mentions", { cursor: c });
    expect(texts(r)).toEqual(["@Arden 3", "@Arden 4", "@Arden 5"]);
    expect(r.result!.truncated).toBe(true);
    // Another token's rows are not counted against Arden's cap.
    await mentionEvents(deps(), put("@Bo", "b0"));
    expect(rows().filter((m) => m.token_id === bo.id)).toHaveLength(1);
  });
});
