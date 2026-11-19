import { expect, it } from "bun:test";
import { waitText } from "@/lib/wait-text";

it("minutes under an hour, hours under two days, else days, rounded up", () => {
  expect(waitText(35, "en")).toBe("35 minutes");
  expect(waitText(0.2, "en")).toBe("1 minute");
  expect(waitText(782, "en")).toBe("14 hours");
  expect(waitText(60, "en")).toBe("1 hour");
  expect(waitText(48 * 60, "en")).toBe("2 days");
  expect(waitText(782, "zh")).toMatch(/^14\s?小时$/);
});

it("an unknown locale falls back to English words", () => {
  expect(waitText(90, "not a locale!!")).toBe("2 hours");
});
