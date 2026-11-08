/**
 * The pre-push gate's affected-only selection (scripts/gate/affected-lib.ts,
 * docs/shipping.md "Only what changed"): the static graph, its fallbacks, and
 * the qa path → suite map in scripts/qa/suites.mjs. An in-memory repo stands in
 * for the checkout.
 */
import { describe, expect, test } from "bun:test";
import {
  IMPORTS_ONLY,
  QA_FULL,
  UNIT_FULL,
  affectedBy,
  aliasesFrom,
  buildGraph,
  makeRepo,
  matchesAny,
  parseJsonc,
  pathLiterals,
  planQa,
  planUnit,
  resolveDeps,
  type QaSuite,
} from "../scripts/gate/affected-lib";
import { SUITES } from "../scripts/qa/suites.mjs";

const PATHS = {
  "@/*": ["./*"],
  "@lianki/core": ["./packages/core/src/index.ts"],
  "@lianki/core/*": ["./packages/core/src/*.ts"],
};

/** files: path → source (non-code files may be ""). */
function world(files: Record<string, string>) {
  const repo = makeRepo(Object.keys(files), aliasesFrom(PATHS));
  const lits = new Map<string, string[]>();
  for (const [f, src] of Object.entries(files)) {
    if (/\.(?:ts|tsx|mjs|js)$/.test(f)) lits.set(f, pathLiterals(src));
  }
  const graph = buildGraph(repo, lits);
  return { repo, graph, affected: (changed: string[]) => affectedBy(graph, changed) };
}

describe("parseJsonc", () => {
  test("strips comments but not comment-like text inside strings, and trailing commas", () => {
    const v = parseJsonc(`{
      // a line comment
      "paths": { "@/*": ["./*"], /* block */ "a": "x // y", },
      "q": "say \\"hi\\"",
    }`);
    expect(v).toEqual({ paths: { "@/*": ["./*"], a: "x // y" }, q: 'say "hi"' });
  });
  test("an unterminated block comment ends the text", () => {
    expect(parseJsonc(`{"a": 1} /* never closed`)).toEqual({ a: 1 });
  });
});

describe("pathLiterals", () => {
  test("keeps quoted paths and file names, drops prose and bare packages", () => {
    const lits = pathLiterals(`
      import x from "@/lib/x";
      import React from "react";
      const t = "don't do this/that";
      readFileSync("worker.ts");
      const msg = 'hello';
      // it's a "quoted comment"
    `);
    expect(lits).toContain("@/lib/x");
    expect(lits).toContain("worker.ts");
    expect(lits).not.toContain("react");
    expect(lits).not.toContain("hello");
    expect(lits.some((l) => l.includes(" "))).toBe(false);
  });
  test("records intlayer keys used and declared", () => {
    const lits = pathLiterals(
      `useIntlayer("app-shell"); getIntlayer('words-list'); ({ key: "x-y" })`,
    );
    expect(lits).toEqual(
      expect.arrayContaining([
        "intlayer-use:app-shell",
        "intlayer-use:words-list",
        "intlayer-key:x-y",
      ]),
    );
  });
  test(`"${IMPORTS_ONLY}" keeps only import specifiers`, () => {
    const lits = pathLiterals(`// ${IMPORTS_ONLY}
      import { a } from "./a.mjs";
      const b = await import("./b");
      const SUITES = [{ args: ["scripts/qa/qa-words.mjs"] }];`);
    expect(lits.sort()).toEqual(["./a.mjs", "./b"]);
  });
});

describe("resolveDeps", () => {
  const { repo } = world({
    "lib/x.ts": "",
    "lib/y/index.ts": "",
    "lib/z.tsx": "",
    "lib/data.json": "",
    "packages/core/src/index.ts": "",
    "packages/core/src/watchStats.ts": "",
    "app/fsrs.ts": "",
    "app/api/a/route.ts": "",
    "app/api/b/route.ts": "",
    "scripts/qa/p.page.tsx": "",
    "scripts/qa/p.ts": "",
    "unit/a.test.ts": "",
  });
  const files = (from: string, lits: string[]) => resolveDeps(repo, from, lits).files.sort();

  test("aliases, relative paths, index files, extensions and .js → .ts", () => {
    expect(files("app/fsrs.ts", ["@/lib/x", "../lib/y", "@/lib/z.js", "@/lib/data.json"])).toEqual([
      "lib/data.json",
      "lib/x.ts",
      "lib/y/index.ts",
      "lib/z.tsx",
    ]);
    expect(files("lib/x.ts", ["@lianki/core", "@lianki/core/watchStats"])).toEqual([
      "packages/core/src/index.ts",
      "packages/core/src/watchStats.ts",
    ]);
  });
  test("root-relative and same-directory literals; never itself, never outside the repo", () => {
    expect(files("unit/a.test.ts", ["app/fsrs.ts", "../../etc/passwd", "/abs/x.ts"])).toEqual([
      "app/fsrs.ts",
    ]);
    expect(files("scripts/qa/p.ts", ["p.page.tsx", "p.ts", "lib/x?raw"])).toEqual([
      "lib/x.ts",
      "scripts/qa/p.page.tsx",
    ]);
  });
  test("directories, globs and template prefixes count in unit/** only", () => {
    const lits = ["app/api", "{scripts,tests}/**/*.mjs", "**/*", "app/${x}/route.ts", "${y}"];
    const u = resolveDeps(repo, "unit/a.test.ts", lits);
    expect(u.dirs.sort()).toEqual(["app", "app/api"]);
    expect(u.globs).toEqual(["{scripts,tests}/**/*.mjs"]);
    expect(resolveDeps(repo, "lib/x.ts", lits)).toEqual({ files: [], dirs: [], globs: [] });
  });
});

describe("affectedBy", () => {
  const w = world({
    "lib/core.ts": "export const a = 1;",
    "lib/words/order.ts": `import { a } from "@/lib/core";`,
    "app/(app)/words/page.tsx": `import "@/lib/words/order"; useIntlayer("words-page");`,
    "app/(app)/words/words-page.content.ts": `export default { key: "words-page" };`,
    "lib/other.ts": "",
    "unit/order.test.ts": `import "../lib/words/order";`,
    "unit/scan.test.ts": `readdirSync("db/migrations"); new Glob("scripts/**/*.mjs");`,
    "unit/other.test.ts": `import "@/lib/other";`,
    "db/migrations/0001.sql": "",
    "scripts/qa/x.mjs": "",
  });

  test("walks importers transitively and remembers the changed file that reached each", () => {
    const a = w.affected(["lib/core.ts"]);
    expect([...a.keys()].sort()).toEqual([
      "app/(app)/words/page.tsx",
      "lib/core.ts",
      "lib/words/order.ts",
      "unit/order.test.ts",
    ]);
    expect(a.get("unit/order.test.ts")).toBe("lib/core.ts");
  });
  test("an intlayer content file reaches the components that use its key", () => {
    expect(
      w.affected(["app/(app)/words/words-page.content.ts"]).has("app/(app)/words/page.tsx"),
    ).toBe(true);
  });
  test("a unit test that walks a directory or globs sees changes under it", () => {
    expect(w.affected(["db/migrations/0002.sql"]).has("unit/scan.test.ts")).toBe(true);
    expect(w.affected(["scripts/qa/x.mjs"]).has("unit/scan.test.ts")).toBe(true);
    expect(w.affected(["lib/other.ts"]).has("unit/scan.test.ts")).toBe(false);
  });
});

describe("planUnit", () => {
  const w = world({
    "lib/a.ts": "",
    "lib/b.ts": "",
    "unit/a.test.ts": `import "@/lib/a";`,
    "unit/b.test.ts": `import "@/lib/b";`,
  });
  const tests = ["unit/a.test.ts", "unit/b.test.ts"];

  test("runs only the tests that reach the change", () => {
    expect(planUnit(["lib/a.ts"], w.affected(["lib/a.ts"]), tests)).toEqual({
      mode: "some",
      tests: [["unit/a.test.ts", "lib/a.ts"]],
      total: 2,
    });
    expect(planUnit(["README.md"], w.affected(["README.md"]), tests)).toEqual({
      mode: "some",
      tests: [],
      total: 2,
    });
  });
  test.each([
    "package.json",
    "bun.lock",
    "bunfig.toml",
    "tsconfig.json",
    "unit/support/testMocks.ts",
    "scripts/gate/affected-lib.ts",
    "lib/d1/index.ts",
    "auth.ts",
  ])("%s changed → the full suite with coverage", (f) => {
    const p = planUnit([f], w.affected([f]), tests);
    expect(p.mode).toBe("full");
    if (p.mode === "full") expect(p.reason).toContain(f);
  });
  test("no graph → the full suite", () => {
    expect(planUnit(["lib/a.ts"], null, tests)).toEqual({
      mode: "full",
      reason: "the import graph could not be built",
    });
  });
});

describe("planQa", () => {
  const suites: QaSuite[] = [
    { id: "words", name: "W", args: ["scripts/qa/qa-words.mjs"], paths: ["app/(app)/words/**"] },
    { id: "pw", name: "P", args: ["playwright", "test", "tests/u.spec.ts"], paths: ["src/**"] },
    { id: "bare", name: "B", args: ["scripts/qa/bare.ts"] },
  ];
  const w = world({
    "lib/words/order.ts": "",
    "lib/unused.ts": "",
    "app/(app)/words/page.tsx": `import "@/lib/words/order";`,
    "scripts/qa/qa-words.mjs": `import "./helper.mjs";`,
    "scripts/qa/helper.mjs": "",
    "scripts/qa/bare.ts": "",
    "tests/u.spec.ts": `readFileSync("lianki.user.js");`,
    "lianki.user.js": "",
    "unit/w.test.ts": `import "@/app/(app)/words/page";`,
  });

  test("a library change reaches its route tree through the graph", () => {
    expect(planQa(["lib/words/order.ts"], w.affected(["lib/words/order.ts"]), suites)).toEqual({
      mode: "some",
      suites: [["words", "app/(app)/words/page.tsx (app/(app)/words/**) ← lib/words/order.ts"]],
      total: 3,
    });
  });
  test("a suite's own entry, or a file it imports or reads, selects it", () => {
    const helper = planQa(["scripts/qa/helper.mjs"], w.affected(["scripts/qa/helper.mjs"]), suites);
    expect(helper.mode === "some" && helper.suites.map(([id]) => id)).toEqual(["words"]);
    const built = planQa(["lianki.user.js"], w.affected(["lianki.user.js"]), suites);
    expect(built.mode === "some" && built.suites).toEqual([
      ["pw", "tests/u.spec.ts ← lianki.user.js"],
    ]);
  });
  test("no suite matches → none run", () => {
    expect(planQa(["lib/unused.ts"], w.affected(["lib/unused.ts"]), suites)).toEqual({
      mode: "some",
      suites: [],
      total: 3,
    });
  });
  test.each(["db/migrations/0099_x.sql", "wrangler.jsonc", "scripts/qa/qa-all.mjs", "bun.lock"])(
    "%s changed → full qa:all",
    (f) => expect(planQa([f], w.affected([f]), suites).mode).toBe("full"),
  );
  test("no graph → full qa:all", () => {
    expect(planQa(["lib/a.ts"], null, suites).mode).toBe("full");
  });
});

describe("the real suite list (scripts/qa/suites.mjs)", () => {
  test("each suite has a unique id and a paths list", () => {
    const ids = SUITES.map((s) => s.id);
    expect(new Set(ids).size).toBe(SUITES.length);
    for (const s of SUITES) {
      expect(s.id).toMatch(/^[a-z][a-z-]*$/);
      expect(Array.isArray(s.paths)).toBe(true);
    }
  });
  test("route trees map to their suites", () => {
    const pick = (f: string) => SUITES.filter((s) => matchesAny(f, s.paths ?? [])).map((s) => s.id);
    expect(pick("app/(app)/words/page.tsx")).toEqual(["words"]);
    expect(pick("app/(app)/reader/[id]/page.tsx")).toEqual(["read-epub"]);
    expect(pick("packages/debug-chat/src/DebugChat.tsx")).toEqual(["partner-frame"]);
    expect(pick("src/lianki.user.ts")).toEqual(["userscript-guest", "userscript-redirect", "sync"]);
    expect(pick("app/components/AppShell.tsx")).toEqual(["ui", "sign-out"]);
    expect(pick("docs/shipping.md")).toEqual([]);
  });
  test("the full-run lists hold the toolchain and qa:all's own machinery", () => {
    expect(matchesAny("lib/d1/index.ts", UNIT_FULL)).toBe("lib/d1/**");
    expect(matchesAny("scripts/qa/suites.mjs", QA_FULL)).toBe("scripts/qa/suites.mjs");
    expect(matchesAny("lib/words/order.ts", QA_FULL)).toBeNull();
  });
});
