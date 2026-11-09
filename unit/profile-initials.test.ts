import { describe, expect, test } from "bun:test";
import { avatarHue, avatarInitial } from "@/lib/profile/initials";

describe("avatarInitial", () => {
  test("the first letter, upper-cased", () => {
    expect(avatarInitial("yuki")).toBe("Y");
    expect(avatarInitial("  ann")).toBe("A");
  });
  test("a whole grapheme: CJK, emoji with a modifier", () => {
    expect(avatarInitial("雪")).toBe("雪");
    expect(avatarInitial("👍🏽 ok")).toBe("👍🏽");
  });
  test("empty or missing: ?", () => {
    expect(avatarInitial("")).toBe("?");
    expect(avatarInitial("   ")).toBe("?");
    expect(avatarInitial(null)).toBe("?");
    expect(avatarInitial(undefined)).toBe("?");
  });
});

describe("avatarHue", () => {
  test("stable for the same name, within 0–359", () => {
    expect(avatarHue("yuki")).toBe(avatarHue("yuki"));
    for (const n of ["a", "yuki", "雪", "", null, undefined]) {
      const h = avatarHue(n);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(360);
    }
  });
  test("different names usually differ", () => {
    expect(avatarHue("yuki")).not.toBe(avatarHue("taro"));
  });
});
