import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "bun:test";
import { buildNextDueQuery } from "@/app/fsrs-helpers";
import {
  REVIEW_FILTERS_KEY,
  deviceFilters,
  isMobileAgent,
  mirrorReviewFilters,
  parseFilters,
} from "@/lib/review-filters";

/**
 * Guards the wiring between /preferences and the userscript's card filtering.
 *
 * These went out of sync silently and stayed that way: GET /api/preferences
 * returns `{ mobileExcludePatterns }`, but the userscript kept reading the
 * long-deprecated `mobileExcludeDomains`, so the value was always undefined,
 * the query param was always empty, and no filter a user configured ever
 * reached buildNextDueQuery. Nothing failed — the feature just did nothing.
 *
 * The checks run against the BUILT public/lianki.user.js, since that is the
 * artifact users install.
 */
const BUILT = readFileSync(join(process.cwd(), "public/lianki.user.js"), "utf-8");

/** Pull `buildExcludeDomainsParam` out of the build by brace-matching. */
function extractBuildParam(isMobile: boolean, userPreferences: unknown, own = ""): () => string {
  const start = BUILT.indexOf("const buildExcludeDomainsParam = () =>");
  if (start === -1) throw new Error("buildExcludeDomainsParam not found in the built userscript");
  const open = BUILT.indexOf("{", start);
  let depth = 0;
  let end = -1;
  for (let i = open; i < BUILT.length; i++) {
    if (BUILT[i] === "{") depth++;
    else if (BUILT[i] === "}" && --depth === 0) {
      end = i + 1;
      break;
    }
  }
  if (end === -1) throw new Error("could not brace-match buildExcludeDomainsParam");
  const body = BUILT.slice(start, end);
  return new Function(
    "isMobile",
    "userPreferences",
    "GM_getValue",
    "REVIEW_FILTERS_KEY",
    "deviceFilters",
    `${body}; return buildExcludeDomainsParam;`,
  )(isMobile, userPreferences, () => own, REVIEW_FILTERS_KEY, deviceFilters) as () => string;
}

const pattern = (over: Record<string, unknown> = {}) => ({
  id: crypto.randomUUID(),
  type: "domain",
  pattern: "reddit.com",
  isRegex: false,
  enabled: true,
  createdAt: new Date().toISOString(),
  ...over,
});

/** What the server does with the param: parse it back out of a real URL. */
function serverSideDomains(param: string): string[] {
  const url = new URL(`http://localhost/api/fsrs/next-url?x=1${param}`);
  return url.searchParams.get("excludeDomains")?.split(",").filter(Boolean) ?? [];
}

describe("userscript preference wiring", () => {
  it("reads the field the API actually returns", () => {
    expect(BUILT).toContain("mobileExcludePatterns");
  });

  it("no longer reads the deprecated field the API stopped sending", () => {
    // The regression itself: `userPreferences.mobileExcludeDomains` is always
    // undefined, which silently disabled every filter.
    expect(BUILT).not.toContain("userPreferences.mobileExcludeDomains");
  });

  it("sends enabled domain and url patterns", () => {
    const build = extractBuildParam(true, {
      mobileExcludePatterns: [
        pattern({ type: "domain", pattern: "reddit.com" }),
        pattern({ type: "url", pattern: "example.com/noisy" }),
      ],
    });
    expect(serverSideDomains(build())).toEqual(["reddit.com", "example.com/noisy"]);
  });

  it("skips disabled patterns", () => {
    const build = extractBuildParam(true, {
      mobileExcludePatterns: [
        pattern({ pattern: "kept.com" }),
        pattern({ pattern: "off.com", enabled: false }),
      ],
    });
    expect(serverSideDomains(build())).toEqual(["kept.com"]);
  });

  it("skips patterns the wire format cannot carry, rather than mismatching them", () => {
    // The server escapes what it receives, so a regex would be sent as literal
    // text and match nothing; `title` has no URL to match against at all.
    const build = extractBuildParam(true, {
      mobileExcludePatterns: [
        pattern({ pattern: "kept.com" }),
        pattern({ pattern: "^ad.*\\.com$", isRegex: true }),
        pattern({ type: "title", pattern: "Sponsored" }),
      ],
    });
    expect(serverSideDomains(build())).toEqual(["kept.com"]);
  });

  it("drops a pattern containing a comma, which would split into two entries", () => {
    const build = extractBuildParam(true, {
      mobileExcludePatterns: [pattern({ pattern: "a.com,b.com" }), pattern({ pattern: "ok.com" })],
    });
    expect(serverSideDomains(build())).toEqual(["ok.com"]);
  });

  it("survives the encode/decode round-trip for characters needing escaping", () => {
    const build = extractBuildParam(true, {
      mobileExcludePatterns: [pattern({ type: "url", pattern: "example.com/a b?c=1&d=2" })],
    });
    expect(serverSideDomains(build())).toEqual(["example.com/a b?c=1&d=2"]);
  });

  it("emits nothing when no pattern qualifies", () => {
    expect(extractBuildParam(true, { mobileExcludePatterns: [] })()).toBe("");
    expect(extractBuildParam(true, {})()).toBe("");
  });

  it("produces domains buildNextDueQuery actually excludes on", () => {
    // End of the chain: what the userscript sends must land as a url exclusion.
    const build = extractBuildParam(true, {
      mobileExcludePatterns: [pattern({ pattern: "reddit.com" })],
    });
    const query = buildNextDueQuery(serverSideDomains(build()));
    const notRegex = (query.url as { $not: RegExp }).$not;
    expect(notRegex.test("https://reddit.com/r/x")).toBe(true);
    expect(notRegex.test("https://example.com/x")).toBe(false);
  });
});

describe("review filters stay on the device", () => {
  const server = { mobileExcludePatterns: [pattern({ pattern: "server.com" })] };
  const own = JSON.stringify([pattern({ pattern: "own.com" })]);

  it("tells a phone from a desktop the way the userscript does", () => {
    expect(isMobileAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X)")).toBe(true);
    expect(isMobileAgent("Mozilla/5.0 (Linux; Android 10; K) Mobile")).toBe(true);
    expect(isMobileAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe(false);
  });

  it("legacy: a phone with no local value uses the account's copy", () => {
    expect(serverSideDomains(extractBuildParam(true, server)())).toEqual(["server.com"]);
  });

  it("legacy: a desktop stays empty even with an account copy", () => {
    expect(extractBuildParam(false, server)()).toBe("");
  });

  it("a device's own list wins, on a phone or a desktop", () => {
    expect(serverSideDomains(extractBuildParam(true, server, own)())).toEqual(["own.com"]);
    expect(serverSideDomains(extractBuildParam(false, server, own)())).toEqual(["own.com"]);
  });

  it("an empty own list means no filters, not the account's copy", () => {
    expect(extractBuildParam(true, server, "[]")()).toBe("");
  });

  it("falls back when what is stored is broken", () => {
    expect(parseFilters("{not json")).toBeNull();
    expect(parseFilters('{"a":1}')).toBeNull();
    expect(serverSideDomains(extractBuildParam(true, server, "{not json")())).toEqual([
      "server.com",
    ]);
  });

  it("mirrors only a real list into the userscript's storage", () => {
    const mirrored = (raw: string | null) => {
      const put: string[] = [];
      mirrorReviewFilters({ getItem: () => raw }, (_, v) => put.push(v));
      return put;
    };
    expect(mirrored("[]")).toEqual(["[]"]);
    expect(mirrored(own)).toEqual([own]);
    expect(mirrored(null)).toEqual([]);
    expect(mirrored("{not json")).toEqual([]);
    mirrorReviewFilters(
      {
        getItem: () => {
          throw new Error("denied");
        },
      },
      () => {
        throw new Error("should not write");
      },
    );
  });
});
