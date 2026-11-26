import { expect, test } from "bun:test";
import {
  parseDictationPageMessage,
  publicDictationRange,
} from "../packages/debug-chat/src/dictation-wire";
import { parsePageChatHttpInput } from "../lib/page-chat-http-wire";
import { publicPageChatResult } from "../lib/page-chat-http-result";
const bid = "browser_00000001",
  routeId = "window_001";

test("route leases and read selectors cannot carry another account, an implicit browser or unknown authority", () => {
  expect(parsePageChatHttpInput({ op: "route", state: "on", bid, routeId })).toEqual({
    op: "route",
    state: "on",
    bid,
    routeId,
  });
  for (const state of ["beat", "off"] as const) {
    expect(parsePageChatHttpInput({ op: "route", state, bid, routeId })).toBeNull();
    expect(parsePageChatHttpInput({ op: "route", state, bid, routeId, gen: 1 })).toMatchObject({
      state,
      gen: 1,
    });
  }
  for (const bad of [
    { op: "route", state: "on", bid, routeId, gen: 1 },
    { op: "route", state: "on", bid, routeId, account: "other" },
    { op: "route", state: "on", bid: "short", routeId },
    { op: "route", state: "on", bid, routeId: "window_001\n" },
    { op: "read", wait: true, dictation: { routeId, gen: 1 } },
    { op: "read", wait: true, dictation: { bid, routeId, gen: -1 } },
    { op: "read", wait: true, dictation: { bid, routeId, gen: 1, account: "other" } },
    {
      op: "read",
      wait: true,
      dictation: { bid, routeId, gen: 1, afterSeq: Number.MAX_SAFE_INTEGER + 1 },
    },
  ])
    expect(parsePageChatHttpInput(bad)).toBeNull();
  expect(
    parsePageChatHttpInput({
      op: "read",
      afterSeq: 9,
      wait: true,
      dictation: { bid, routeId, gen: 2, afterSeq: 3 },
    }),
  ).toMatchObject({ afterSeq: 9, dictation: { afterSeq: 3 } });
});

test("source messages are bounded final text only, with both route and source generations", () => {
  const final = {
    type: "chat-dictation",
    bid,
    routeId,
    gen: 1,
    sgen: 2,
    finalId: "final_001",
    text: "synthetic text",
    at: 100,
  } as const;
  expect(parseDictationPageMessage(final)).toEqual(final);
  expect(parseDictationPageMessage({ type: "dictation-source", bid, state: "on" })).toMatchObject({
    state: "on",
  });
  expect(parseDictationPageMessage({ type: "dictation-stop", bid })).toEqual({
    type: "dictation-stop",
    bid,
  });
  for (const bad of [
    { ...final, principal: "forged" },
    { ...final, audio: "not allowed" },
    { ...final, sgen: undefined },
    { ...final, text: "x".repeat(4001) },
    { ...final, text: " " },
    { ...final, finalId: "short" },
    { type: "dictation-source", bid, state: "beat" },
    { type: "dictation-stop", bid, origin: "https://other.test" },
  ])
    expect(parseDictationPageMessage(bad)).toBeNull();
});

test("public dictation ranges whitelist fields and reject duplicate, out-of-order or unbounded items", () => {
  const item = { seq: 1, finalId: "final_001", text: "synthetic text", at: 100 };
  const range = { routeId, gen: 1, throughSeq: 1, items: [item] };
  expect(
    publicDictationRange({
      ...range,
      token: "synthetic",
      items: [{ ...item, principal: "not public" }],
    }),
  ).toEqual(range);
  for (const bad of [
    { ...range, throughSeq: 0 },
    { ...range, items: Array(51).fill(item) },
    { ...range, items: [item, item] },
    { ...range, items: [{ ...item, text: "" }] },
    { ...range, throughSeq: 2, items: [item, { ...item, seq: 2 }] },
  ])
    expect(publicDictationRange(bad)).toBeNull();
  expect(
    publicPageChatResult({
      ok: true,
      kind: "route",
      state: "listening",
      gen: 1,
      token: "never public",
    }),
  ).toEqual({ ok: true, kind: "route", state: "listening", gen: 1 });
  expect(publicPageChatResult({ ok: false, error: "no-grant", gen: 2, grant: true })).toEqual({
    ok: false,
    error: "no-grant",
    gen: 2,
  });
});
