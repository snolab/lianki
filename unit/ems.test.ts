import { describe, expect, it, setSystemTime, afterEach } from "bun:test";
import { dueMs } from "../app/ems";

describe("dueMs", () => {
  // Restore the real clock so a frozen time cannot leak into later files.
  afterEach(() => {
    setSystemTime();
  });

  it("returns a positive duration for future dates", () => {
    setSystemTime(new Date(0));
    const future = new Date(60_000); // 1 minute in the future
    const result = dueMs(future);
    expect(result).not.toMatch(/^-/);
    expect(result).toMatch(/\d/);
  });

  it("returns a negative duration for past dates", () => {
    setSystemTime(new Date(120_000));
    const past = new Date(0); // 2 minutes in the past
    const result = dueMs(past);
    expect(result).toMatch(/^-/);
  });

  it("returns '0s' for exactly now", () => {
    setSystemTime(new Date(1000));
    const now = new Date(1000);
    const result = dueMs(now);
    expect(result).toBe("0s");
  });
});
