/**
 * lib/build/intlayer-direct-loader.cjs: browser code's useIntlayer("key")
 * becomes useDictionary(<that dictionary>), so a page ships only the
 * dictionaries it uses, and the browser's lookup table is an empty stub
 * (lib/stubs/intlayer-no-dictionaries.mjs, docs/cold-start.md). The stub is
 * only safe while every client call can be rewritten: the last test holds that.
 */
import { describe, expect, test } from "bun:test";
import path from "node:path";

const loader = require("../lib/build/intlayer-direct-loader.cjs") as {
  (this: { resourcePath: string; rootContext?: string }, source: string): string;
  rewrite: (source: string, resourcePath: string, root: string) => string;
};
const { rewrite } = loader;

const ROOT = "/repo";

describe("the direct-dictionary rewrite", () => {
  test("a literal key becomes a direct import of its dictionary", () => {
    const src = [
      `"use client";`,
      `import { useIntlayer } from "next-intlayer";`,
      `export function A() {`,
      `  const a = useIntlayer("app-shell");`,
      `  const b = useIntlayer('words-page', "ja");`,
      `  const c = useIntlayer("app-shell");`,
      `  return a + b + c;`,
      `}`,
    ].join("\n");
    const out = rewrite(src, `${ROOT}/app/components/A.tsx`, ROOT);
    expect(out.startsWith(`"use client";`)).toBe(true);
    expect(out).not.toContain("useIntlayer");
    expect(out).toContain(`__lkUseDictionary(__lkDict0)`);
    expect(out).toContain(`__lkUseDictionary(__lkDict1, "ja")`);
    expect(out.match(/__lkUseDictionary\(__lkDict0\)/g)).toHaveLength(2);
    expect(out).toContain(`import { useDictionary as __lkUseDictionary } from "next-intlayer";`);
    expect(out).toContain(`import __lkDict0 from "../../.intlayer/dictionary/app-shell.json";`);
    expect(out).toContain(`import __lkDict1 from "../../.intlayer/dictionary/words-page.json";`);
  });

  test("other names imported beside useIntlayer stay", () => {
    const src = `import { useIntlayer, useLocale } from "next-intlayer";\nconst x = useIntlayer("a");`;
    const out = rewrite(src, `${ROOT}/a.tsx`, ROOT);
    expect(out).toContain(`import { useLocale } from "next-intlayer"`);
    expect(out).toContain(`import __lkDict0 from "./.intlayer/dictionary/a.json";`);
  });

  test("a variable key, or no next-intlayer import, leaves the file as it is", () => {
    const variable = `import { useIntlayer } from "next-intlayer";\nconst a = useIntlayer("a");\nconst b = useIntlayer(key);`;
    expect(rewrite(variable, `${ROOT}/a.tsx`, ROOT)).toBe(variable);
    const local = `const useIntlayer = (k) => k;\nuseIntlayer("a");`;
    expect(rewrite(local, `${ROOT}/a.tsx`, ROOT)).toBe(local);
    const server = `import { useIntlayer } from "next-intlayer/server";\nuseIntlayer("a");`;
    expect(rewrite(server, `${ROOT}/a.tsx`, ROOT)).toBe(server);
  });

  test("as a loader it resolves against the project root", () => {
    const src = `import { useIntlayer } from "next-intlayer";\nuseIntlayer("k");`;
    const out = loader.call({ resourcePath: `${ROOT}/lib/x/y.ts`, rootContext: ROOT }, src);
    expect(out).toContain(`"../../.intlayer/dictionary/k.json"`);
    const cwd = loader.call({ resourcePath: path.join(process.cwd(), "z.ts") }, src);
    expect(cwd).toContain(`"./.intlayer/dictionary/k.json"`);
  });
});

describe("every client file can be rewritten", () => {
  test("no useIntlayer call from next-intlayer with a non-literal key", async () => {
    const root = path.join(import.meta.dir, "..");
    const left: string[] = [];
    for (const dir of ["app", "lib", "packages", "src"]) {
      for await (const f of new Bun.Glob(`${dir}/**/*.{ts,tsx}`).scan({ cwd: root })) {
        if (f.includes("node_modules")) continue;
        const s = await Bun.file(path.join(root, f)).text();
        if (!/from\s*["']next-intlayer["']/.test(s) || !s.includes("useIntlayer(")) continue;
        if (rewrite(s, path.join(root, f), root) === s) left.push(f);
      }
    }
    expect(left).toEqual([]);
  });
});
