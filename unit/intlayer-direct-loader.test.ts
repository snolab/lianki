/**
 * lib/build/intlayer-direct-loader.cjs: every dictionary lookup by key —
 * useIntlayer("key") from next-intlayer and next-intlayer/server, and
 * getIntlayer("key") from intlayer — becomes a direct import of that one
 * dictionary, so code carries only the dictionaries it uses, and the lookup
 * table itself is an empty stub (lib/stubs/intlayer-no-dictionaries.mjs,
 * docs/cold-start.md). The stub is only safe while every lookup can be
 * rewritten: the last test holds that for the whole app.
 */
import { describe, expect, test } from "bun:test";
import path from "node:path";

const loader = require("../lib/build/intlayer-direct-loader.cjs") as {
  (this: { resourcePath: string; rootContext?: string }, source: string): string;
  rewrite: (source: string, resourcePath: string, root: string) => string;
  leftovers: (source: string) => string[];
};
const { rewrite, leftovers } = loader;

const ROOT = "/repo";

describe("the direct-dictionary rewrite", () => {
  test("useIntlayer from next-intlayer becomes useDictionary on that dictionary", () => {
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
    expect(out).toContain(`__lk_useDictionary(__lkDict1, "ja")`);
    expect(out.match(/__lk_useDictionary\(__lkDict0\)/g)).toHaveLength(2);
    expect(out).toContain(`import { useDictionary as __lk_useDictionary } from "next-intlayer";`);
    expect(out).toContain(`import __lkDict0 from "../../.intlayer/dictionary/app-shell.json";`);
    expect(out).toContain(`import __lkDict1 from "../../.intlayer/dictionary/words-page.json";`);
  });

  test("getIntlayer from intlayer becomes getDictionary, other names stay", () => {
    const src = `import { getIntlayer, t } from "intlayer";\nconst x = getIntlayer("nav-home", locale as never);`;
    const out = rewrite(src, `${ROOT}/app/page.tsx`, ROOT);
    expect(out).toContain(`import { t } from "intlayer"`);
    expect(out).toContain(`__lk_getDictionary(__lkDict0, locale as never)`);
    expect(out).toContain(`import { getDictionary as __lk_getDictionary } from "intlayer";`);
    expect(out).toContain(`import __lkDict0 from "../.intlayer/dictionary/nav-home.json";`);
  });

  test("useIntlayer from next-intlayer/server becomes its useDictionary", () => {
    const src = `import { useIntlayer } from "next-intlayer/server";\nconst c = useIntlayer("polyglot-layout");`;
    const out = rewrite(src, `${ROOT}/x.tsx`, ROOT);
    expect(out).toContain(
      `import { useDictionary as __lk_useDictionary } from "next-intlayer/server";`,
    );
    expect(out).toContain(`__lk_useDictionary(__lkDict0)`);
  });

  test("both kinds in one file share the dictionary imports", () => {
    const src = `import { useIntlayer } from "next-intlayer";\nimport { getIntlayer } from "intlayer";\nuseIntlayer("a");\ngetIntlayer("a", "en");\ngetIntlayer("b");`;
    const out = rewrite(src, `${ROOT}/x.tsx`, ROOT);
    expect(out).toContain(`__lk_useDictionary(__lkDict0)`);
    expect(out).toContain(`__lk_getDictionary(__lkDict0, "en")`);
    expect(out).toContain(`__lk_getDictionary(__lkDict1)`);
    expect(out.match(/import __lkDict0 /g)).toHaveLength(1);
  });

  test("a variable key, an unknown module, or a doubled name leaves the file as it is", () => {
    const variable = `import { useIntlayer } from "next-intlayer";\nconst a = useIntlayer("a");\nconst b = useIntlayer(key);`;
    expect(rewrite(variable, `${ROOT}/a.tsx`, ROOT)).toBe(variable);
    expect(leftovers(variable)).toEqual(["useIntlayer from next-intlayer"]);
    const local = `const useIntlayer = (k) => k;\nuseIntlayer("a");`;
    expect(rewrite(local, `${ROOT}/a.tsx`, ROOT)).toBe(local);
    expect(leftovers(local)).toEqual([]);
    const both = `import { useIntlayer } from "next-intlayer";\nimport { useIntlayer as u } from "next-intlayer/server";\nuseIntlayer("a");`;
    expect(rewrite(both, `${ROOT}/a.tsx`, ROOT)).toBe(both);
  });

  test("as a loader it resolves against the project root", () => {
    const src = `import { useIntlayer } from "next-intlayer";\nuseIntlayer("k");`;
    const out = loader.call({ resourcePath: `${ROOT}/lib/x/y.ts`, rootContext: ROOT }, src);
    expect(out).toContain(`"../../.intlayer/dictionary/k.json"`);
    const cwd = loader.call({ resourcePath: path.join(process.cwd(), "z.ts") }, src);
    expect(cwd).toContain(`"./.intlayer/dictionary/k.json"`);
  });
});

describe("every lookup in the app can be rewritten", () => {
  test("no file looks a dictionary up with a non-literal key", async () => {
    const root = path.join(import.meta.dir, "..");
    const left: string[] = [];
    for (const dir of ["app", "lib", "packages", "src"]) {
      for await (const f of new Bun.Glob(`${dir}/**/*.{ts,tsx,mjs}`).scan({ cwd: root })) {
        if (f.includes("node_modules")) continue;
        const s = await Bun.file(path.join(root, f)).text();
        for (const l of leftovers(s)) left.push(`${f}: ${l}`);
      }
    }
    expect(left).toEqual([]);
  });
});
