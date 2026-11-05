import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { siblingRequestRefused } from "@/lib/security/same-site-guard";

/** Requests from a sibling *.lianki.com host, which carry the Lax session cookie. */
const sibling = { "sec-fetch-site": "same-site", cookie: "a=b" };
const refused = (path: string, headers: Record<string, string>, method = "POST") =>
  siblingRequestRefused(new Request(`https://lianki.com${path}`, { method, headers }));

describe("requests from a sibling *.lianki.com host", () => {
  test("anything to /api is refused, the GETs that write too", () => {
    expect(refused("/api/token", sibling)).toBe(true);
    expect(refused("/api", sibling)).toBe(true);
    expect(refused("/API/token", sibling, "DELETE")).toBe(true);
    expect(refused("/api/payments/buy-pass", sibling, "PATCH")).toBe(true);
    for (const p of ["/api/fsrs/delete?id=x", "/api/fsrs/review/4/?id=x", "/api/invite"])
      expect(refused(p, sibling, "GET")).toBe(true);
  });

  test("a write to a page path is refused: server actions POST there", () => {
    expect(refused("/en/list", sibling)).toBe(true);
    expect(refused("/apix", sibling)).toBe(true);
  });

  test("reading a page, or following a link, still works", () => {
    expect(refused("/en/list", sibling, "GET")).toBe(false);
    expect(refused("/", sibling, "HEAD")).toBe(false);
    expect(refused("/en", sibling, "OPTIONS")).toBe(false);
  });

  test("without the cookie there is nothing to protect", () => {
    expect(refused("/api/token", { "sec-fetch-site": "same-site" })).toBe(false);
  });
});

describe("everyone else is untouched", () => {
  test("the app's own requests", () => {
    expect(refused("/api/token", { ...sibling, "sec-fetch-site": "same-origin" })).toBe(false);
  });

  test("a typed address, or a link from another site", () => {
    expect(refused("/api/token", { ...sibling, "sec-fetch-site": "none" }, "GET")).toBe(false);
    expect(refused("/api/x", { ...sibling, "sec-fetch-site": "cross-site" }, "GET")).toBe(false);
  });

  test("webhooks, tokens and the CLI: no Fetch Metadata", () => {
    expect(refused("/api/payments/stripe-webhook", {})).toBe(false);
    expect(refused("/api/prefs", { cookie: "a=b" })).toBe(false);
  });
});

test("the Worker checks it before anything else", () => {
  const src = readFileSync("worker.ts", "utf8");
  const fetchAt = src.indexOf("fetch(req: Request, env: LiveEnv, ctx: Ctx)");
  const guardAt = src.indexOf("if (siblingRequestRefused(req))");
  const liveAt = src.indexOf("if (!mayBeLive(");
  expect(fetchAt).toBeGreaterThan(-1);
  expect(guardAt).toBeGreaterThan(fetchAt);
  expect(liveAt).toBeGreaterThan(guardAt);
});
