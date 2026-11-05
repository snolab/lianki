import { describe, expect, test } from "bun:test";
import { contactEmail } from "@/lib/contact";

describe("contactEmail", () => {
  test("returns the trimmed address", () => {
    expect(contactEmail(" someone@example.com ")).toBe("someone@example.com");
  });
  test("unset or blank is null, so the contact line hides", () => {
    expect(contactEmail(undefined)).toBeNull();
    expect(contactEmail("  ")).toBeNull();
  });
});
