import { describe, expect, it } from "bun:test";
import { createAccountUploadLimiter } from "@/lib/inbox/rate";
describe("account upload rate", () => {
  it("one account cannot spend another account limit", () => {
    const allow = createAccountUploadLimiter(() => 1000);
    expect(allow("a", 2)).toBe(true);
    expect(allow("a", 2)).toBe(true);
    expect(allow("a", 2)).toBe(false);
    expect(allow("b", 2)).toBe(true);
    expect(allow("", 2)).toBe(false);
    expect(allow("c", 0)).toBe(false);
  });
  it("opens the window after a minute and honors live limit changes without resetting usage", () => {
    let now = 0;
    const allow = createAccountUploadLimiter(() => now);
    expect(allow("a", 3)).toBe(true);
    expect(allow("a", 1)).toBe(false);
    expect(allow("a", 2)).toBe(true);
    now = 59_999;
    expect(allow("a", 2)).toBe(false);
    now = 60_000;
    expect(allow("a", 1)).toBe(true);
    expect(allow("a", 1)).toBe(false);
    now = 120_000;
    expect(allow("a", 1)).toBe(true);
  });
  it("expires a later account window independently of pruning cadence", () => {
    let now = 0;
    const allow = createAccountUploadLimiter(() => now);
    allow("a", 1);
    now = 30_000;
    expect(allow("b", 1)).toBe(true);
    now = 60_000;
    allow("a", 1);
    now = 90_000;
    expect(allow("b", 1)).toBe(true);
  });
  it("uses the real clock when no clock is supplied", () => {
    expect(createAccountUploadLimiter()("a", 1)).toBe(true);
  });
});
