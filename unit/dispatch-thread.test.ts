// The dispatch thread (lib/dev-eval.ts; docs/owner-paths-audit-2026-11-15.md):
// joined by a `dev` grant, never by an address in code; friend threads unchanged.
import { beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { createTestD1 } from "../lib/d1/testDb";
import { type ChatLogDb, accountsOf, chatLogOp } from "../lib/chat-log";
import {
  DISPATCH_THREAD,
  OWNER_THREAD,
  isDispatchThread,
  isUserId,
  threadFor,
} from "../lib/dev-eval";
import { lineTier } from "../packages/debug-chat/src/rich-text";

const SCHEMA =
  "CREATE TABLE user (id TEXT PRIMARY KEY, email TEXT);\n" +
  "CREATE TABLE account_permission (email TEXT, permission TEXT, revoked_at INTEGER);\n" +
  readFileSync(new URL("../db/migrations/0057_chat_line.sql", import.meta.url), "utf8");

describe("the dispatch thread's name", () => {
  it("is the thread id the hub has always stored, under both names", () => {
    expect(DISPATCH_THREAD).toBe("owner");
    expect(OWNER_THREAD).toBe(DISPATCH_THREAD);
  });

  it("is never a user's own thread", () => {
    expect(isUserId(DISPATCH_THREAD)).toBe(false);
    expect(isUserId("fr1")).toBe(true);
  });

  it("isDispatchThread matches only the dispatch thread", () => {
    expect(isDispatchThread(DISPATCH_THREAD)).toBe(true);
    for (const t of ["fr1", "Owner", "", null, undefined]) expect(isDispatchThread(t)).toBe(false);
  });

  it("the chat package's copy matches: html tier only on the dispatch thread", () => {
    const agent = { from: "agent", ownerGrant: true };
    expect(lineTier({ ...agent, thread: DISPATCH_THREAD })).toBe("html");
    expect(lineTier(agent)).toBe("html");
    expect(lineTier({ ...agent, thread: "fr1" })).toBe("markdown");
  });
});

describe("threadFor", () => {
  it("a dev holder joins the dispatch thread", () => {
    expect(threadFor({ userId: "own1", dispatch: true })).toBe(DISPATCH_THREAD);
  });

  it("without the grant, an account gets its own thread (friends unaffected)", () => {
    expect(threadFor({ userId: "own1", dispatch: false })).toBe("own1");
    expect(threadFor({ userId: "fr1", dispatch: false })).toBe("fr1");
  });

  it("an id that cannot be a thread gets none, and cannot claim the dispatch thread", () => {
    expect(threadFor({ userId: "bad id!", dispatch: false })).toBeNull();
    expect(threadFor({ userId: DISPATCH_THREAD, dispatch: false })).toBeNull();
  });
});

describe("whose lines the dispatch thread's are (chat log)", () => {
  let db: ChatLogDb;
  let raw: ReturnType<ReturnType<typeof createTestD1>["raw"]>;
  beforeEach(() => {
    const d = createTestD1(SCHEMA);
    raw = d.raw();
    raw.exec(`INSERT INTO user VALUES ('own1', 'owner@example.com'), ('fr1', 'f@example.com');
              INSERT INTO account_permission VALUES ('owner@example.com', 'dev', NULL);`);
    db = d as unknown as ChatLogDb;
  });

  it("grant present: the dev holders", async () => {
    expect(await accountsOf(db, DISPATCH_THREAD)).toEqual(["own1"]);
  });

  it("grant revoked: nobody", async () => {
    raw.exec(`UPDATE account_permission SET revoked_at = 1`);
    expect(await accountsOf(db, DISPATCH_THREAD)).toEqual([]);
  });

  it("a friend's thread is that friend's alone, grant or not", async () => {
    expect(await accountsOf(db, "fr1")).toEqual(["fr1"]);
    expect(await accountsOf(db, "nobody")).toEqual([]);
    expect(await accountsOf(db, "bad id!")).toEqual([]);
  });

  it("backfill only on the dispatch thread", async () => {
    const lines = [{ id: "a1", from: "owner", text: "hi", at: 1_800_000_000_000 }];
    const friend = await chatLogOp(db, { op: "backfill", thread: "fr1", lines });
    expect(friend).toEqual({ ok: false, error: "backfill is for the owner's thread" });
    const ok = await chatLogOp(db, { op: "backfill", thread: DISPATCH_THREAD, lines });
    expect(ok.ok).toBe(true);
  });
});
