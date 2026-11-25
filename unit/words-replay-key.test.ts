import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

describe("/words R replay shortcut", () => {
  it("binds KeyR in WordsClient to replay the current word with force=true", () => {
    const src = readFileSync(join(root, "app/(app)/words/WordsClient.tsx"), "utf8");
    expect(src).toMatch(/e\.code === "KeyR"[\s\S]{0,120}speech\.once\(partsOf\(it\), true\)/);
  });

  it("documents R replay in helpKeys across all 16 locales", () => {
    const src = readFileSync(join(root, "app/(app)/words/page.content.ts"), "utf8");
    const block = /helpKeys:\s*t\(\{([\s\S]*?)\n\s*\}\)/.exec(src)?.[1] ?? "";
    const locales = block.match(/^\s+[a-z]{2}:/gm) ?? [];
    expect(locales).toHaveLength(16);
    for (const line of block.trim().split("\n")) {
      expect(line).toContain("· R ");
    }
  });
});
