import { describe, expect, test } from "bun:test";
import { DEV_BRIDGE_HEADER, devBridgeMatches } from "../lib/dev-bridge";
import { DEV_BRIDGE_HEADER as PUSH_HEADER } from "../workers/push/src/auth";

const SECRET = "s".repeat(64);

describe("dev bridge", () => {
  test("matches only the configured secret", () => {
    expect(devBridgeMatches(SECRET, SECRET)).toBe(true);
    expect(devBridgeMatches("t".repeat(64), SECRET)).toBe(false);
    expect(devBridgeMatches(SECRET.slice(1), SECRET)).toBe(false);
    expect(devBridgeMatches("", SECRET)).toBe(false);
    expect(devBridgeMatches(null, SECRET)).toBe(false);
  });

  test("shut while the secret is unset or short", () => {
    expect(devBridgeMatches("anything", undefined)).toBe(false);
    expect(devBridgeMatches("", "")).toBe(false);
    expect(devBridgeMatches("short", "short")).toBe(false);
  });

  test("the app and lianki-push agree on the header name", () => {
    expect(DEV_BRIDGE_HEADER).toBe(PUSH_HEADER);
  });
});
