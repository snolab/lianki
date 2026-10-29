import { describe, expect, it } from "bun:test";
import { isoDay, longDate, longDateTime } from "@/lib/dates";

describe("dates people read", () => {
  const d = new Date(2026, 10, 5, 18, 11, 15);
  it("writes the month out instead of 11/5/2026", () => {
    expect(longDate(d, "en-US")).toBe("November 5, 2026");
    expect(longDate(d, "zh-CN")).toBe("2026年11月5日");
    expect(longDateTime(d, "en-US")).toContain("November 5, 2026");
    expect(longDateTime(d, "en-US")).not.toContain("11/5");
  });
  it("labels an import with an ISO day", () => {
    expect(isoDay(d)).toBe("2026-11-05");
  });
});
