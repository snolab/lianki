import { test, expect } from "bun:test";
import { publicPageChatResult } from "../lib/page-chat-http-result";
test("history response drops all metadata and preserves replay deletion/coverage only", () => {
  const range = {
    type: "history",
    thread: "site",
    messages: [{ id: "line", from: "friend", text: "hello", seq: 2, at: 1, token: "private" }],
    removed: [{ id: "old", seq: 1, secret: "private" }],
    skipped: [{ from: 1, to: 1, secret: "private" }],
    afterSeq: 0,
    throughSeq: 2,
    headSeq: 2,
    prunedThroughSeq: 0,
  };
  const result = publicPageChatResult({
    ok: true,
    kind: "history",
    range,
    pending: "pending_id",
    warning: "limit",
    token: "private",
  });
  expect(JSON.stringify(result)).not.toContain("private");
  expect(result).toMatchObject({
    pending: "pending_id",
    warning: "limit",
    range: { removed: [{ id: "old", seq: 1 }], skipped: [{ from: 1, to: 1 }] },
  });
  for (const value of [
    null,
    "x",
    { ok: false, error: "private" },
    { ok: true, kind: "hello", principal: "x" },
    { ok: true, kind: "history", range: { ...range, messages: [null] } },
    { ok: true, kind: "history", range: { ...range, removed: [{ id: "bad", seq: -1 }] } },
    { ok: true, kind: "history", range: { ...range, skipped: [{ from: 2, to: 1 }] } },
  ])
    expect(publicPageChatResult(value)).toBeNull();
});
