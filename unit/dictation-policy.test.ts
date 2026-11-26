import { expect, test } from "bun:test";
import {
  dictationPolicy,
  DICTATION_POLICY_DEFAULTS,
} from "../packages/debug-chat/src/dictation-policy";

test("live queue, expiry and heartbeat limits are honored without retaining a mutable config object", () => {
  const live = {
    beatMs: 1500,
    leaseMs: 120000,
    pendingMs: 180000,
    maxQueued: 10,
    maxRoutes: 4,
    maxReceipts: 200,
    requestsPerMinute: 90,
  };
  const parsed = dictationPolicy(live);
  expect(parsed).toEqual(live);
  live.maxQueued = 45;
  expect(parsed.maxQueued).toBe(10);
  expect(parsed.beatMs).toBeLessThan(parsed.leaseMs);
});

test("missing, malformed and out-of-bounds config fails back atomically to bounded defaults", () => {
  const valid = { ...DICTATION_POLICY_DEFAULTS, maxQueued: 5 };
  for (const invalid of [
    undefined,
    null,
    true,
    "wrong",
    {},
    [],
    { ...valid, beatMs: 0 },
    { ...valid, beatMs: 20001 },
    { ...valid, leaseMs: 59999 },
    { ...valid, pendingMs: 600001 },
    { ...valid, maxQueued: 51 },
    { ...valid, maxQueued: 1.5 },
    { ...valid, maxRoutes: -1 },
    { ...valid, maxReceipts: 49 },
    { ...valid, requestsPerMinute: "90" },
    { ...valid, requestsPerMinute: Infinity },
  ])
    expect(dictationPolicy(invalid)).toEqual(DICTATION_POLICY_DEFAULTS);
  const fallback = dictationPolicy(null);
  fallback.maxQueued = 1;
  expect(dictationPolicy(null).maxQueued).toBe(50);
});
