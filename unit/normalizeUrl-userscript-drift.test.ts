/**
 * Drift guard: the userscript ships its OWN copy of normalizeUrl (it can't
 * import from lib/ — it's a single-file Tampermonkey bundle). If the two copies
 * diverge, the server and the client disagree on card identity, which silently
 * breaks dedupe and the redirect-detection prompt (see tests/userscript-redirect).
 *
 * This test extracts the userscript's normalizeUrl from the built bundle and
 * asserts it produces byte-identical output to lib/normalizeUrl for a table of
 * representative URLs. Add a URL here whenever you touch either copy.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { normalizeUrl as libNormalizeUrl } from "../lib/normalizeUrl";

/** Extract `function normalizeUrl(href) {...}` from the built userscript by brace-matching. */
function extractUserscriptNormalizeUrl(): (href: string) => string {
  const src = readFileSync(join(process.cwd(), "public/lianki.user.js"), "utf-8");
  const start = src.indexOf("function normalizeUrl(href)");
  if (start === -1) throw new Error("normalizeUrl not found in public/lianki.user.js");
  const open = src.indexOf("{", start);
  let depth = 0;
  let end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) {
      end = i + 1;
      break;
    }
  }
  if (end === -1) throw new Error("Could not brace-match normalizeUrl body");
  const fnSrc = src.slice(start, end);
  return new Function(`${fnSrc}; return normalizeUrl;`)() as (href: string) => string;
}

const CASES = [
  "https://example.com/page",
  "https://www.zhihu.com/question/23857983",
  "https://www.zhihu.com/question/23857983?theme=dark",
  "https://example.com/page?theme=light&keep=1",
  "https://youtu.be/dQw4w9WgXcQ",
  "https://m.youtube.com/watch?v=abc",
  "https://www.youtube.com/watch?v=abc&si=track&pp=xyz",
  "https://www.youtube.com/watch?v=__Cu2nwgAjA&list=PL123&index=3",
  "https://example.com/page?foo=bar&utm_source=tw&fbclid=z&gclid=g&igshid=i",
  "https://example.com/page?z=1&a=2",
  "https://m.example.com/page",
  "https://example.com/page?index=3",
  "not-a-url",
];

describe("normalizeUrl userscript/lib drift guard", () => {
  const userscriptNormalizeUrl = extractUserscriptNormalizeUrl();

  it.each(CASES)("userscript copy matches lib copy for %s", (url) => {
    expect(userscriptNormalizeUrl(url)).toBe(libNormalizeUrl(url));
  });

  it("userscript copy strips theme (the param this guard was added for)", () => {
    expect(userscriptNormalizeUrl("https://www.zhihu.com/question/23857983?theme=dark")).toBe(
      "https://www.zhihu.com/question/23857983",
    );
  });
});
