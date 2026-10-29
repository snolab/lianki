import { describe, expect, test } from "bun:test";
import { extendPro } from "@/lib/membership";

const DAY = 86_400_000;

describe("extendPro", () => {
  const now = new Date("2026-10-29T00:00:00Z");
  test("no Pro, or Pro already over: counts from now", () => {
    expect(extendPro(undefined, 7, now).getTime()).toBe(now.getTime() + 7 * DAY);
    expect(extendPro(new Date(now.getTime() - DAY), 7, now).getTime()).toBe(
      now.getTime() + 7 * DAY,
    );
  });
  test("Pro running: adds on top of its end", () => {
    const end = new Date(now.getTime() + 3 * DAY);
    expect(extendPro(end, 7, now).getTime()).toBe(end.getTime() + 7 * DAY);
  });
});
