import { describe, expect, it } from "bun:test";
import { IMMERSION_DOMAINS, IMMERSION_LANGUAGES, allImmersionSites } from "@/lib/immersion-sites";
import { siteOf } from "@/lib/next-card";

describe("immersion matrix", () => {
  it("has a unique key per domain", () => {
    const keys = IMMERSION_DOMAINS.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("fills every language for every domain — an empty cell is a missing recommendation", () => {
    for (const domain of IMMERSION_DOMAINS) {
      for (const { code } of IMMERSION_LANGUAGES) {
        expect(domain.sites[code]?.primary?.url, `${domain.key}/${code}`).toBeTruthy();
      }
    }
  });

  it("only links https URLs the userscript can group by site", () => {
    for (const site of allImmersionSites()) {
      const url = new URL(site.url);
      expect(url.protocol, site.url).toBe("https:");
      expect(siteOf(site.url), site.url).toBeTruthy();
    }
  });

  it("never lists the same URL as both primary and alt in a cell", () => {
    for (const domain of IMMERSION_DOMAINS) {
      for (const { code } of IMMERSION_LANGUAGES) {
        const { primary, alt } = domain.sites[code];
        if (alt) expect(alt.url, `${domain.key}/${code}`).not.toBe(primary.url);
      }
    }
  });
});
