/**
 * Drift guard: the userscript ships its OWN copy of siteOf (it is a single-file
 * bundle and cannot import lib/). The same-site preference runs on the server
 * and offline in the userscript, and if the two disagree on what a "site" is,
 * the card you get next depends on connectivity — the exact thing the shared
 * rule exists to prevent.
 *
 * This lifts the userscript's siteOf and its suffix table from the built bundle
 * and asserts they agree with lib/next-card.ts on a table of real hosts taken
 * from an actual deck. Add a host here whenever you touch either copy.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "bun:test";
import { siteOf as libSiteOf } from "../lib/next-card";

function block(src: string, decl: string) {
  const start = src.indexOf(decl);
  if (start === -1) throw new Error(`${decl} not found in public/lianki.user.js`);
  // Brace-match for a function; a Set literal ends at its `]);`.
  if (decl.startsWith("TWO_LABEL_SUFFIXES")) {
    // The bundler emits `var`, so match the name and reconstruct the declaration.
    return `var ${src.slice(start, src.indexOf("]);", start) + 3)}`;
  }
  const open = src.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`could not brace-match ${decl}`);
}

function extractUserscriptSiteOf(): (url: string) => string | null {
  const src = readFileSync(join(process.cwd(), "public/lianki.user.js"), "utf-8");
  const fnSrc = `${block(src, "TWO_LABEL_SUFFIXES = new Set(")}\n${block(src, "function siteOf(url)")}`;
  return new Function(`${fnSrc}; return siteOf;`)() as (url: string) => string | null;
}

// Real hosts from a real deck, plus the shapes that trip a naive rule.
const CASES = [
  "https://www.youtube.com/watch?v=1",
  "https://www.zhihu.com/question/1",
  "https://zhuanlan.zhihu.com/p/1",
  "https://docs.google.com/document/d/x",
  "https://console.cloud.google.com/",
  "https://cdn.p.recruit.co.jp/x",
  "https://825dbd8d.comfy-qa.pages.dev/",
  "https://calibre-jr.snomiao.dev/",
  "https://bean.tk.snomiao.com/",
  "https://liuzhongjing.medium.com/x",
  "https://en.wikipedia.org/wiki/X",
  "https://francaisfacile.rfi.fr/",
  "https://blog.csdn.net/x",
  "https://news.ycombinator.com/",
  "https://example.co.uk/",
  "https://sub.example.co.uk/",
  "https://user.github.io/repo/",
  "https://127.0.0.1:3000/",
  "http://localhost:3000/",
  "https://a.test:8443/x",
  "https://[::1]:8080/",
  "not a url",
  "",
];

describe("siteOf: userscript copy matches lib/next-card.ts", () => {
  const usSiteOf = extractUserscriptSiteOf();
  for (const url of CASES) {
    it(`agrees on ${url || "(empty)"}`, () => {
      expect(usSiteOf(url)).toBe(libSiteOf(url));
    });
  }

  it("groups the cases the way a reader would", () => {
    // Not a drift check — pins the intended grouping, so a future edit to the
    // suffix table that breaks one of these fails loudly.
    expect(libSiteOf("https://zhuanlan.zhihu.com/p/1")).toBe("zhihu.com");
    expect(libSiteOf("https://www.zhihu.com/q")).toBe("zhihu.com");
    expect(libSiteOf("https://console.cloud.google.com/")).toBe("google.com");
    expect(libSiteOf("https://cdn.p.recruit.co.jp/x")).toBe("recruit.co.jp");
    expect(libSiteOf("https://825dbd8d.comfy-qa.pages.dev/")).toBe("comfy-qa.pages.dev");
    expect(libSiteOf("https://a.test:8443/x")).toBe("a.test");
  });
});
