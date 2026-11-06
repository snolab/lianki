import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "fs";
import { buildNextDueQuery, excludeDomainsRegExp } from "@/app/fsrs-helpers";
import { newCode } from "@/lib/referrals/rules";
import { offSiteHeaders, offSiteWritingGet } from "@/lib/security/route-guard";

/** Follow-up to the 2026-11-05 hardening: CodeQL #17, #18, #33 and review item 25. */
describe("excludeDomains is text, never a pattern", () => {
  test("regex characters match themselves", () => {
    const re = excludeDomainsRegExp(["a+b.com", "x.org/p?q=1"]);
    expect(re.test("https://a+b.com/")).toBe(true);
    expect(re.test("https://aab.com/")).toBe(false);
    expect(re.test("https://x.org/p?q=1")).toBe(true);
    expect(re.test("https://x.org/q=1")).toBe(false);
  });

  test("what used to fail the request or run a slow pattern is harmless", () => {
    for (const bad of ["(", "[a", "*.example.com", "\\", "(a+)+$"]) {
      const re = excludeDomainsRegExp([bad]);
      expect(re.test("https://example.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!")).toBe(false);
      expect(re.test(`https://example.com/${bad}`)).toBe(true);
    }
  });

  test("several entries are alternatives, and the due query uses this", () => {
    const re = excludeDomainsRegExp(["a.com", "b.com"]);
    expect(re.test("https://a.com/")).toBe(true);
    expect(re.test("https://b.com/")).toBe(true);
    expect(re.test("https://c.com/")).toBe(false);
    expect(buildNextDueQuery(["a+b.com"]).url.$not.source).toBe(
      excludeDomainsRegExp(["a+b.com"]).source,
    );
    expect(readFileSync("app/fsrs.ts", "utf8")).toContain("$not: excludeDomainsRegExp(");
  });
});

describe("codes are unbiased", () => {
  afterEach(() => {
    // bun restores spies per test only on request.
    (crypto.getRandomValues as unknown as { mockRestore?: () => void }).mockRestore?.();
  });

  test("the bytes that would favour the first letters are thrown away", () => {
    // 256 % 31 = 8: 248..255 would wrap to the first 8 letters. Then 0 gives "2".
    const batches = [[248, 255, 0, 247], [0]];
    spyOn(crypto, "getRandomValues").mockImplementation(((a: Uint8Array) => {
      a.fill(0);
      a.set((batches.shift() ?? []).slice(0, a.length));
      return a;
    }) as never);
    const code = newCode(4);
    expect(code).toHaveLength(4);
    // 0 → "2"; 247 → index 247 % 31 = 30, the alphabet's last letter "Z".
    expect(code.startsWith("2Z")).toBe(true);
  });

  test("still the right length and alphabet", () => {
    for (const n of [1, 8, 32]) {
      const c = newCode(n);
      expect(c).toHaveLength(n);
      expect(c).toMatch(/^[2-9A-HJKMNP-Z]+$/);
    }
  });
});

describe("the rule for GETs that write", () => {
  const h = (site?: string, mode?: string) =>
    new Headers({
      ...(site ? { "sec-fetch-site": site } : {}),
      ...(mode ? { "sec-fetch-mode": mode } : {}),
    });

  test("on headers and on a request it answers alike", () => {
    for (const [site, mode, off] of [
      ["cross-site", "navigate", true],
      ["same-site", "cors", true],
      ["same-origin", "cors", false],
      ["same-origin", "navigate", false],
      ["none", "navigate", false],
      ["cross-site", "cors", false],
    ] as const) {
      expect(offSiteHeaders(h(site, mode))).toBe(off);
      expect(
        offSiteWritingGet(new Request("https://lianki.com/x", { headers: h(site, mode) })),
      ).toBe(off);
    }
    expect(offSiteHeaders(h())).toBe(false);
  });

  test("the routes that write on GET ask it before writing", () => {
    const invite = readFileSync("app/api/invite/route.ts", "utf8");
    expect(invite.indexOf("offSiteHeaders(await headers())")).toBeGreaterThan(-1);
    expect(invite.indexOf("offSiteHeaders(await headers())")).toBeLessThan(
      invite.indexOf("inviteSummary(getD1()"),
    );
    expect(readFileSync("lib/read/reader-route.ts", "utf8")).toContain(
      "!material.contentHash && !offSiteHeaders(reqHeaders)",
    );
    const read = readFileSync("app/api/read/[id]/route.ts", "utf8");
    expect(read).toContain("const saving = !offSiteHeaders(await headers())");
    expect(read).toContain("!material.contentHash && saving");
  });

  test("an invite link is its own route, so it is untouched", () => {
    expect(readFileSync("app/i/[code]/route.ts", "utf8")).not.toContain("offSite");
  });
});
