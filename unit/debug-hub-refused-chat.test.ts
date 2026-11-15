/**
 * refusedChatId (workers/push/src/debug.ts): a chat frame the page parser
 * refuses (over MAX_CHAT, a bad id) is answered with `chat-rejected` instead of
 * being dropped in silence (owner's phone, 2026-11-15: one 5859-char voice line
 * held 200 lines behind it for hours). Only a chat frame with a usable id
 * yields an id; anything else is null, so no other frame gets a receipt.
 */
import { expect, it } from "bun:test";
import { refusedChatId } from "../workers/push/src/debug";
import { MAX_CHAT } from "../packages/debug-chat/src/wire";

it("a chat frame over MAX_CHAT yields its id", () => {
  const raw = JSON.stringify({ type: "chat", id: "73c17c27-e0d", text: "x".repeat(MAX_CHAT + 1) });
  expect(refusedChatId(raw)).toBe("73c17c27-e0d");
});

it("other frames, bad ids and non-JSON yield null", () => {
  expect(refusedChatId(JSON.stringify({ type: "read", id: "a" }))).toBeNull();
  expect(refusedChatId(JSON.stringify({ type: "chat", id: "" }))).toBeNull();
  expect(refusedChatId(JSON.stringify({ type: "chat", id: "x".repeat(65) }))).toBeNull();
  expect(refusedChatId(JSON.stringify({ type: "chat", id: 7 }))).toBeNull();
  expect(refusedChatId("{not json")).toBeNull();
  expect(refusedChatId("null")).toBeNull();
  expect(refusedChatId(new ArrayBuffer(4))).toBeNull();
  expect(refusedChatId("x".repeat((1 << 20) + 1))).toBeNull();
});
