import { describe, expect, test } from "bun:test";
import { DEFAULT_PLAN_SKIN, planSkinFrom } from "../lib/plan-skin";

describe("planSkinFrom", () => {
  test("marble without a parameter", () => {
    expect(DEFAULT_PLAN_SKIN).toBe("marble");
    expect(planSkinFrom("")).toBe("marble");
    expect(planSkinFrom("?lang=en")).toBe("marble");
  });
  test("?card= previews the other materials", () => {
    expect(planSkinFrom("?card=paper")).toBe("paper");
    expect(planSkinFrom("?lang=en&card=wood")).toBe("wood");
    expect(planSkinFrom("?card=marble")).toBe("marble");
  });
  test("an unknown value falls back to marble", () => {
    expect(planSkinFrom("?card=gold")).toBe("marble");
    expect(planSkinFrom("?card=")).toBe("marble");
    expect(planSkinFrom("?card=Paper")).toBe("marble");
  });
});
