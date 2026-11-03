// The commit/push split (owner, 2026-11-03): pre-commit runs only staged-file
// checks and the generation steps whose inputs are staged; whole-repo lint,
// typecheck and the unit suite run in pre-push, before qa:all.
import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import lintStaged, { lintCommands, lintable, toRel } from "../.lintstagedrc.mjs";
import { planPreCommit } from "../scripts/pre-commit-plan";

const ROOT = join(import.meta.dir, "..");
const hook = (name: string) =>
  readFileSync(join(ROOT, ".husky", name), "utf-8")
    .split("\n")
    .filter((l) => l.trim() && !l.trim().startsWith("#"));

describe("planPreCommit", () => {
  it("does nothing for an ordinary commit", () => {
    expect(planPreCommit(["lib/dates.ts", "docs/repo-map.md"])).toEqual({
      stateTree: false,
      buildUserscript: false,
      blogCorpus: false,
    });
    expect(planPreCommit([])).toEqual({
      stateTree: false,
      buildUserscript: false,
      blogCorpus: false,
    });
  });

  it("regenerates the state-tree copy when the outline or the copy is staged", () => {
    expect(planPreCommit(["docs/state-tree.md"]).stateTree).toBe(true);
    expect(planPreCommit(["lib/state-tree.generated.ts"]).stateTree).toBe(true);
    expect(planPreCommit(["docs/state-tree.md.bak"]).stateTree).toBe(false);
  });

  it("builds the userscript only when its TS source is staged", () => {
    expect(planPreCommit(["src/lianki.user.ts"]).buildUserscript).toBe(true);
    expect(planPreCommit(["src/lianki.user.ts.orig"]).buildUserscript).toBe(false);
    // public/lianki.user.js alone needs no build; pre-commit.ts still checks its @version.
    expect(planPreCommit(["public/lianki.user.js"]).buildUserscript).toBe(false);
  });

  it("rebundles the blog when a post or the corpus is staged", () => {
    expect(planPreCommit(["blog/en/some-post.md"]).blogCorpus).toBe(true);
    expect(planPreCommit(["lib/blog.corpus.json"]).blogCorpus).toBe(true);
    expect(planPreCommit(["blog/en/cover.png"]).blogCorpus).toBe(false);
    expect(planPreCommit(["docs/blog.md"]).blogCorpus).toBe(false);
  });
});

describe(".lintstagedrc.mjs", () => {
  const cwd = "/repo";

  it("makes staged paths repo-relative, on POSIX and Windows", () => {
    expect(toRel("/repo/lib/a.ts", cwd)).toBe("lib/a.ts");
    expect(toRel("/repo/lib/a.ts", "/repo/")).toBe("lib/a.ts");
    expect(toRel("C:\\repo\\packages\\x.ts", "C:\\repo")).toBe("packages/x.ts");
    expect(toRel("/elsewhere/a.ts", cwd)).toBe("/elsewhere/a.ts");
  });

  it("lints the same files as `bun run lint`: JS/TS outside packages/", () => {
    const files = [
      "/repo/lib/a.ts",
      "/repo/app/b.tsx",
      "/repo/scripts/c.mjs",
      "/repo/packages/ext/d.ts",
      "/repo/docs/e.md",
    ];
    expect(lintable(files, cwd)).toEqual([
      "/repo/lib/a.ts",
      "/repo/app/b.tsx",
      "/repo/scripts/c.mjs",
    ]);
  });

  it("runs oxlint --fix then oxfmt on them, quoted", () => {
    expect(lintCommands(["/repo/lib/a b.ts", "/repo/packages/x.ts"], cwd)).toEqual([
      'oxlint --fix "/repo/lib/a b.ts"',
      'oxfmt --no-error-on-unmatched-pattern "/repo/lib/a b.ts"',
    ]);
  });

  it("runs nothing when every staged file is under packages/", () => {
    expect(lintCommands(["/repo/packages/x.ts"], cwd)).toEqual([]);
  });

  it("scans every staged file for secrets", () => {
    expect(lintStaged["**/*"]).toBe("secretlint");
    const js = lintStaged["*.{ts,tsx,js,jsx,mjs,cjs}"];
    expect(js([join(process.cwd(), "lib/a.ts")])).toHaveLength(2);
  });
});

describe("git hooks", () => {
  it("pre-commit runs only the staged-file steps", () => {
    expect(hook("pre-commit")).toEqual(["bunx lint-staged", "bun scripts/pre-commit.ts"]);
  });

  it("pre-push runs lint, typecheck and the unit suite with coverage before qa:all", () => {
    const lines = hook("pre-push");
    const at = (cmd: string) => lines.findIndex((l) => l.trim() === cmd);
    const order = [
      "bun run lint",
      "bun run typecheck",
      "bun run test:unit -- --coverage",
      "bun run qa:all",
    ].map(at);
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // The Windows skip exits before qa:all only — after the unit suite.
    const windows = lines.findIndex((l) => l.includes("MINGW*"));
    expect(windows).toBeGreaterThan(order[2]);
    expect(windows).toBeLessThan(order[3]);
  });
});
