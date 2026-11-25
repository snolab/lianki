/**
 * Deleting a chat line (lib/chat-redact.ts; docs/chat-history.md, "Deleting a
 * line"): what is left of the line, Li's window, the D1 copy and its audit
 * row, the session API's gates, and the owner's CLI. The hub's part is in
 * unit/debug-hub.test.ts ("DebugHub redact").
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { createTestD1 } from "../lib/d1/testDb";
import { type ChatLogDb, chatLogOp } from "../lib/chat-log";
import {
  REDACTED_TEXT,
  lineTexts,
  redactMessage,
  redactWindow,
  windowHolds,
} from "../lib/chat-redact";
import { redactLine } from "../lib/chat-redact-api";
import { advanceWindow, editEntry } from "../lib/partner-window";
import { parseArgs, redactArgs } from "../scripts/dev/lianki-dev-cli";
import type { ChatMessage } from "../packages/debug-chat/src/wire";

const SECRET = "https://lianki.com/x?token=lk_SECRET123";

describe("redactMessage: only who and when are left", () => {
  it("drops text, raw, edits, parts, attachments, audio, context and screen", () => {
    const m = {
      id: "4d87d0ca",
      from: "owner",
      label: "/words iPhone",
      text: `${SECRET} polished`,
      raw: SECRET,
      at: 5,
      seq: 9,
      thread: "owner",
      source: "stt",
      edited: { at: 6, by: "auto", count: 1 },
      parts: [{ id: "a", text: SECRET, at: 5 }],
      premerge: { text: SECRET },
      attachments: [{ id: "f1", name: "a.png", type: "image/png", size: 1 }],
      audio: { src: "https://x/a.mp3", kind: "file" },
      context: { text: SECRET, url: "https://lianki.com/read/x" },
      scene: { path: "/x", title: "t", screen: SECRET },
      ask: { askId: "k", questions: [] },
      ownerGrant: true,
      mergeable: true,
    } as unknown as ChatMessage;
    const out = redactMessage(m, 7);
    expect(out).toEqual({
      id: "4d87d0ca",
      from: "owner",
      label: "/words iPhone",
      text: REDACTED_TEXT,
      at: 5,
      seq: 9,
      thread: "owner",
      redacted: { at: 7 },
    });
    expect(JSON.stringify(out)).not.toContain("SECRET");
    expect(lineTexts(m)).toEqual(expect.arrayContaining([SECRET, `${SECRET} polished`]));
  });
});

describe("redactWindow: Li's frozen window keeps no copy", () => {
  const b = { maxLines: 40, maxChars: 8000, keepPct: 50 };
  it("the line, its edit entry and an attributed copy read the placeholder", () => {
    let w = advanceWindow(
      undefined,
      [
        { id: "a", role: "user", text: "hello" },
        { id: "s", role: "user", text: SECRET },
        { id: "r", role: "assistant", text: "ok" },
      ],
      b,
    );
    // A polish after it entered: an edit entry quoting it.
    w = advanceWindow(
      w,
      [
        { id: "a", role: "user", text: "hello" },
        { id: "s", role: "user", text: `${SECRET}!` },
        { id: "r", role: "assistant", text: "ok" },
      ],
      b,
    );
    expect(w.items.some((i) => i.text === editEntry(SECRET, `${SECRET}!`))).toBe(true);
    const out = redactWindow(w, "s", [SECRET, `${SECRET}!`]);
    expect(windowHolds(out, [SECRET])).toBe(false);
    expect(JSON.stringify(out)).not.toContain("SECRET123");
    expect(out.items.map((i) => i.text)).toEqual(["hello", REDACTED_TEXT, "ok", REDACTED_TEXT]);
    expect(out.seen.s).toBe(REDACTED_TEXT);
    // The next call does not take it in again (it reads the placeholder now).
    const next = advanceWindow(
      out,
      [
        { id: "a", role: "user", text: "hello" },
        { id: "s", role: "user", text: REDACTED_TEXT },
        { id: "r", role: "assistant", text: "ok" },
      ],
      b,
    );
    expect(next.items).toEqual(out.items);
  });
});

describe("chatLogOp redact: the D1 copy, in every account, and one audit row", () => {
  const SCHEMA =
    "CREATE TABLE user (id TEXT PRIMARY KEY, email TEXT);\n" +
    "CREATE TABLE account_permission (email TEXT, permission TEXT, revoked_at INTEGER);\n" +
    readFileSync(new URL("../db/migrations/0057_chat_line.sql", import.meta.url), "utf8") +
    "\n" +
    readFileSync(new URL("../db/migrations/0040_security_audit.sql", import.meta.url), "utf8");
  let db: ChatLogDb;
  let raw: ReturnType<ReturnType<typeof createTestD1>["raw"]>;
  beforeEach(() => {
    const d = createTestD1(SCHEMA);
    raw = d.raw();
    raw.exec(`INSERT INTO user VALUES ('own1', 'o@example.com'), ('own2', 'p@example.com'), ('fr1', 'f@example.com');
              INSERT INTO account_permission VALUES ('o@example.com', 'dev', NULL), ('p@example.com', 'dev', NULL);`);
    db = d as unknown as ChatLogDb;
  });
  const put = (thread: string, id: string, text: string) =>
    chatLogOp(db, {
      op: "put",
      thread,
      lines: [
        {
          id,
          from: thread === "owner" ? "owner" : "friend",
          lane: null,
          text,
          at: 1,
          ask: false,
          answer: null,
        },
      ],
    });

  it("clears the text in each dev account's copy; the audit names who and which, never the words", async () => {
    await put("owner", "4d87d0ca", SECRET);
    await put("owner", "keep", "other line");
    const out = await chatLogOp(
      db,
      {
        op: "redact",
        thread: "owner",
        ids: ["4d87d0ca", "4d87d0ca.merged"],
        actor: "own1",
        via: "page",
      },
      { now: () => 42 },
    );
    expect(out).toMatchObject({ ok: true });
    const rows = raw.prepare("SELECT user_id, id, text FROM chat_line ORDER BY user_id, id").all();
    expect(rows).toEqual([
      { user_id: "own1", id: "4d87d0ca", text: REDACTED_TEXT },
      { user_id: "own1", id: "keep", text: "other line" },
      { user_id: "own2", id: "4d87d0ca", text: REDACTED_TEXT },
      { user_id: "own2", id: "keep", text: "other line" },
    ]);
    const audit = raw
      .prepare("SELECT at_ms, kind, actor, subject, detail FROM security_audit")
      .all();
    expect(audit).toEqual([
      {
        at_ms: 42,
        kind: "chat.redact",
        actor: "own1",
        subject: "4d87d0ca",
        detail: "page thread=owner",
      },
    ]);
    expect(JSON.stringify(audit)).not.toContain("SECRET");
  });

  it("a user's own thread touches only that account", async () => {
    await put("fr1", "x1", SECRET);
    await put("owner", "x1", "owner's line with the same id");
    await chatLogOp(db, { op: "redact", thread: "fr1", ids: ["x1"], actor: "fr1", via: "api" });
    const rows = raw
      .prepare("SELECT user_id, text FROM chat_line WHERE id = 'x1' ORDER BY user_id")
      .all();
    expect(rows).toEqual([
      { user_id: "fr1", text: REDACTED_TEXT },
      { user_id: "own1", text: "owner's line with the same id" },
      { user_id: "own2", text: "owner's line with the same id" },
    ]);
  });

  it("refuses a request without who, or with bad ids", async () => {
    expect(
      await chatLogOp(db, { op: "redact", thread: "owner", ids: ["a"], via: "page" }),
    ).toMatchObject({ ok: false });
    expect(
      await chatLogOp(db, {
        op: "redact",
        thread: "owner",
        ids: ["a b"],
        actor: "own1",
        via: "page",
      }),
    ).toMatchObject({ ok: false });
    expect(
      await chatLogOp(db, { op: "redact", thread: "owner", ids: [], actor: "own1", via: "page" }),
    ).toMatchObject({ ok: false });
  });
});

describe("POST /api/chat/redact: his session, same origin, his own thread", () => {
  const post = (headers: Record<string, string> = {}, body: unknown = { id: "4d87d0ca" }) =>
    new Request("https://lianki.com/api/chat/redact", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://lianki.com",
        "sec-fetch-site": "same-origin",
        ...headers,
      },
      body: JSON.stringify(body),
    });
  const hub = (status = 200) => {
    const calls: { url: string; body: unknown }[] = [];
    return {
      calls,
      push: () => ({
        fetch: async (url: string, init?: RequestInit) => {
          calls.push({ url, body: JSON.parse(String(init?.body)) });
          return Response.json(status === 200 ? { ok: true, ids: ["4d87d0ca"] } : { error: "x" }, {
            status,
          });
        },
      }),
    };
  };

  it("the owner's session deletes in the owner thread, as himself", async () => {
    const h = hub();
    const res = await redactLine(post(), {
      who: async () => ({ id: "own1", dev: true }),
      push: h.push,
    });
    expect(res.status).toBe(200);
    expect(h.calls).toEqual([
      {
        url: "https://lianki-push/internal/chat-redact",
        body: { thread: "owner", id: "4d87d0ca", actor: "own1" },
      },
    ]);
  });

  it("another account reaches only its own thread: the owner's line is not found there", async () => {
    const h = hub(404);
    const res = await redactLine(post(), {
      who: async () => ({ id: "fr1", dev: false }),
      push: h.push,
    });
    expect(res.status).toBe(404);
    expect(h.calls[0]!.body).toEqual({ thread: "fr1", id: "4d87d0ca", actor: "fr1" });
  });

  it("refused for any Bearer token (a lane's, MCP's), even with a session", async () => {
    const h = hub();
    for (const auth of [`Bearer lk_${"0".repeat(64)}`, "Bearer anything"]) {
      const res = await redactLine(post({ authorization: auth }), {
        who: async () => ({ id: "own1", dev: true }),
        push: h.push,
      });
      expect(res.status).toBe(403);
    }
    expect(h.calls).toEqual([]);
  });

  it("refused cross-site, without a session, or for a bad id", async () => {
    const h = hub();
    const me = { who: async () => ({ id: "own1", dev: true }), push: h.push };
    expect((await redactLine(post({ origin: "https://evil.example" }), me)).status).toBe(403);
    expect((await redactLine(post({ "sec-fetch-site": "cross-site" }), me)).status).toBe(403);
    expect((await redactLine(post({ "content-type": "text/plain" }), me)).status).toBe(403);
    expect((await redactLine(post(), { who: async () => null, push: h.push })).status).toBe(404);
    expect((await redactLine(post({}, { id: "a b" }), me)).status).toBe(400);
    expect(h.calls).toEqual([]);
  });
});

describe("POST /api/chat/redact: odd bodies and a failing hub", () => {
  const me = (res: Response) => ({
    who: async () => ({ id: "own1", dev: true }),
    push: () => ({ fetch: async () => res }),
  });
  const req = (body: string) =>
    new Request("https://lianki.com/api/chat/redact", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://lianki.com" },
      body,
    });
  it("not JSON: 400; the hub down: 502; the hub's answer not JSON: still done", async () => {
    expect((await redactLine(req("{"), me(Response.json({})))).status).toBe(400);
    expect(
      (await redactLine(req('{"id":"m1"}'), me(new Response("x", { status: 500 })))).status,
    ).toBe(502);
    const ok = await redactLine(req('{"id":"m1"}'), me(new Response("not json")));
    expect(await ok.json()).toEqual({ ok: true, ids: ["m1"] });
    expect(
      (
        await redactLine(req('{"id":"m1"}'), {
          who: async () => ({ id: "own1", dev: true }),
          push: () => null,
        })
      ).status,
    ).toBe(503);
  });
});

describe("lianki-dev redact: the owner's command, never a lane's", () => {
  it("gives the confirm link on his signed-in page", () => {
    const g = parseArgs(["redact", "--id", "4d87d0ca"], {});
    if (g instanceof Error) throw g;
    expect(redactArgs(g.rest, g.global)).toEqual({
      id: "4d87d0ca",
      url: "https://lianki.com/chat/history?redact=4d87d0ca",
      open: true,
    });
  });
  it("refuses a lane, and a bad id", () => {
    const g = parseArgs(["redact", "--id", "4d87d0ca"], { LIANKI_LANE: "codex" });
    if (g instanceof Error) throw g;
    expect(redactArgs(g.rest, g.global)).toBeInstanceOf(Error);
    const h = parseArgs(["redact", "--id", "a/b"], {});
    if (h instanceof Error) throw h;
    expect(redactArgs(h.rest, h.global)).toBeInstanceOf(Error);
  });
});
