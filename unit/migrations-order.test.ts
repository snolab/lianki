import { describe, expect, it } from "bun:test";
import { readdirSync } from "fs";
import { join } from "path";

/**
 * `wrangler d1 migrations apply` applies only migrations numbered after the
 * last one applied: a second file with a number already used (two branches
 * both picking 0039) is skipped for good — "No migrations to apply!" — while
 * the code that needs it deploys (2026-11-05, 0039_ai_credits.sql). Every
 * number must be unique.
 */
describe("D1 migrations", () => {
  it("every number is used once", () => {
    const files = readdirSync(join(process.cwd(), "db/migrations")).filter((f) =>
      f.endsWith(".sql"),
    );
    const nums = files.map((f) => f.slice(0, f.indexOf("_")));
    const dup = nums.filter((n, i) => nums.indexOf(n) !== i);
    expect(dup).toEqual([]);
  });
});
