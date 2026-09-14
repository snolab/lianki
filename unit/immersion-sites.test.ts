import { describe, expect, it } from "bun:test";
import {
  IMMERSION_DOMAINS,
  IMMERSION_LANGUAGES,
  allImmersionSites,
  orderImmersionLanguages,
  preferredImmersionLanguages,
} from "@/lib/immersion-sites";
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

describe("preferredImmersionLanguages", () => {
  it("keeps the browser's order, drops regions and q-values, and collapses duplicates", () => {
    expect(preferredImmersionLanguages("ja,en-US;q=0.9,en;q=0.8,zh-TW;q=0.7")).toEqual([
      "ja",
      "en",
      "zh",
    ]);
  });

  it("ignores languages the matrix does not cover", () => {
    expect(preferredImmersionLanguages("sw,hi;q=0.9")).toEqual([]);
    expect(preferredImmersionLanguages(null)).toEqual([]);
  });
});

describe("orderImmersionLanguages", () => {
  it("puts preferred languages first and keeps matrix order for the rest", () => {
    expect(orderImmersionLanguages(["fi", "en"]).map((l) => l.code)).toEqual([
      "fi",
      "en",
      ...IMMERSION_LANGUAGES.map((l) => l.code).filter((c) => c !== "fi" && c !== "en"),
    ]);
  });
});
