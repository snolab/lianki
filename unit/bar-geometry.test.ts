import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { BAR_LINE, barGeometry } from "../packages/debug-chat/src/bar-geometry";

describe("chat bar geometry (concentric mic)", () => {
  test("the bar draws its radius, border and padding inline, from the variables", () => {
    const s = barGeometry(true) as Record<string, string>;
    expect(s.borderRadius).toBe("var(--lk-bar-r)");
    expect(s.borderWidth).toBe("var(--lk-bar-b)");
    expect(s.padding).toBe("var(--lk-bar-pad)");
    expect(s["--lk-bar-r"]).toBe(
      "calc(var(--lk-bar-b) + var(--lk-bar-pad) + var(--lk-bar-line) / 2)",
    );
  });
  test("the input's one-line height is the line box (a class the app already has)", () => {
    const src = readFileSync("packages/debug-chat/src/DebugChat.tsx", "utf8");
    expect(src).toContain(`h-[${BAR_LINE}]`);
    expect(src).toContain(`min-h-[${BAR_LINE}]`);
  });
});
