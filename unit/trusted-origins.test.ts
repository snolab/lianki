import { describe, expect, it } from "bun:test";
import { localQaOrigin, PRODUCTION_ORIGINS, trustedOrigins } from "../lib/trusted-origins";

describe("localQaOrigin", () => {
  it("accepts a localhost origin on any port", () => {
    // The whole point: qa:all now picks an ephemeral port, so the allowlist
    // cannot be pinned to 3000.
    expect(localQaOrigin("http://localhost:3000")).toEqual(["http://localhost:3000"]);
    expect(localQaOrigin("http://localhost:41337")).toEqual(["http://localhost:41337"]);
    expect(localQaOrigin("http://127.0.0.1:8788")).toEqual(["http://127.0.0.1:8788"]);
  });

  it("strips any path, keeping just the origin", () => {
    expect(localQaOrigin("http://localhost:3000/api/auth")).toEqual(["http://localhost:3000"]);
  });

  it("refuses anything that is not localhost", () => {
    // BETTER_AUTH_BASE_URL is set in production too. If a non-local value could
    // widen the allowlist, this helper would be a CSRF hole rather than a
    // convenience.
    expect(localQaOrigin("https://lianki.com")).toEqual([]);
    expect(localQaOrigin("https://evil.test")).toEqual([]);
    expect(localQaOrigin("https://localhost.evil.test")).toEqual([]);
    expect(localQaOrigin("https://notlocalhost")).toEqual([]);
  });

  it("refuses non-http schemes", () => {
    expect(localQaOrigin("javascript:alert(1)")).toEqual([]);
    expect(localQaOrigin("file:///etc/passwd")).toEqual([]);
  });

  it("is unbothered by missing or malformed values", () => {
    expect(localQaOrigin(undefined)).toEqual([]);
    expect(localQaOrigin(null)).toEqual([]);
    expect(localQaOrigin("")).toEqual([]);
    expect(localQaOrigin("   ")).toEqual([]);
    expect(localQaOrigin("not a url")).toEqual([]);
  });
});

describe("trustedOrigins", () => {
  it("always includes the deployed origins", () => {
    for (const o of PRODUCTION_ORIGINS) expect(trustedOrigins("")).toContain(o);
  });

  it("adds the QA origin when it is local", () => {
    expect(trustedOrigins("http://localhost:41337")).toContain("http://localhost:41337");
  });

  it("does not duplicate the default port", () => {
    const out = trustedOrigins("http://localhost:3000");
    expect(out.filter((o) => o === "http://localhost:3000")).toHaveLength(1);
  });

  it("cannot be widened by a production base url", () => {
    expect(trustedOrigins("https://evil.test")).toEqual([...PRODUCTION_ORIGINS]);
  });
});
