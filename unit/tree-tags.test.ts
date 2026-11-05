import { describe, expect, test } from "bun:test";
import { checkFields, MAX_TAGS, normalizeTags } from "@/lib/tree/tags";
import { isDay } from "@/lib/tree/tz";

describe("tag conventions", () => {
  test("tags: trimmed, lower-cased, unique, capped", () => {
    expect(normalizeTags([" Plan", "plan", "", 3, "x".repeat(41), "todo"])).toEqual([
      "plan",
      "todo",
    ]);
    expect(normalizeTags("plan")).toEqual([]);
    expect(normalizeTags(Array.from({ length: 30 }, (_, i) => `t${i}`))).toHaveLength(MAX_TAGS);
  });

  test("fields: known keys checked per tag, unknown kept, size capped", () => {
    expect(checkFields(null, [])).toEqual({});
    expect(checkFields([], [])).toBeNull();
    expect(checkFields("x", [])).toBeNull();
    expect(
      checkFields({ days: ["MO", "XX"], minutesPerDay: 20, listId: 7, extra: true }, ["habit"]),
    ).toEqual({ minutesPerDay: 20, extra: true });
    expect(checkFields({ days: ["MO", "FR"] }, ["habit"])).toEqual({ days: ["MO", "FR"] });
    expect(checkFields({ due: "tomorrow" }, ["todo"])).toEqual({});
    expect(checkFields({ body: "x".repeat(9000) }, ["note"])).toBeNull();
  });

  test("days", () => {
    expect(isDay("2026-10-31")).toBe(true);
    expect(isDay("2026-13-45")).toBe(false);
    expect(isDay("31/10/2026")).toBe(false);
  });
});
