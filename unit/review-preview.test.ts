import { describe, expect, test } from "bun:test";
import { headersAllowPreview, previewPolicy } from "../lib/review-preview";
import { preparedPreviews } from "../lib/review-preview-state";
import { nextCardFrom } from "../lib/review-ui";

const parent = "https://lianki.com";
const page = "https://example.com/article";
const resolve = async () => ({ ok: true as const });
const html = (headers: Record<string, string> = {}, status = 200) =>
  new Response(null, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", ...headers },
  });

describe("framing headers", () => {
  for (const [name, headers, allowed] of [
    ["no policy", {}, true],
    ["XFO deny", { "x-frame-options": "DENY" }, false],
    ["XFO cross origin", { "x-frame-options": "SAMEORIGIN" }, false],
    ["XFO malformed", { "x-frame-options": "SAMEORIGIN, DENY" }, false],
    ["CSP none", { "content-security-policy": "frame-ancestors 'none'" }, false],
    ["CSP self", { "content-security-policy": "frame-ancestors 'self'" }, false],
    [
      "CSP other parent",
      { "content-security-policy": "frame-ancestors https://other.example" },
      false,
    ],
    [
      "CSP explicit parent",
      { "content-security-policy": "default-src 'none'; frame-ancestors https://lianki.com" },
      true,
    ],
    ["CSP wildcard", { "content-security-policy": "frame-ancestors *" }, true],
    ["CSP https scheme", { "content-security-policy": "frame-ancestors https:" }, true],
    [
      "CSP overrides XFO",
      {
        "content-security-policy": "frame-ancestors https://lianki.com",
        "x-frame-options": "DENY",
      },
      true,
    ],
    [
      "all enforced policies apply",
      { "content-security-policy": "frame-ancestors *, frame-ancestors 'none'" },
      false,
    ],
    [
      "report-only cannot override XFO",
      { "content-security-policy-report-only": "frame-ancestors *", "x-frame-options": "DENY" },
      false,
    ],
    [
      "default-src does not imply frame-ancestors",
      { "content-security-policy": "default-src 'none'" },
      true,
    ],
    [
      "unknown source expression is conservative",
      { "content-security-policy": "frame-ancestors https://*.example" },
      false,
    ],
  ] as const) {
    test(name, () => expect(headersAllowPreview(new Headers(headers), page, parent)).toBe(allowed));
  }
  test("self origin is compared with the page", () => {
    expect(
      headersAllowPreview(
        new Headers({ "x-frame-options": "sameorigin" }),
        page,
        "https://example.com",
      ),
    ).toBe(true);
    expect(
      headersAllowPreview(
        new Headers({ "content-security-policy": "frame-ancestors 'self'" }),
        page,
        "https://example.com",
      ),
    ).toBe(true);
  });
});

describe("credential-free, bounded next-page header checks", () => {
  test("only HEAD with no account authority, and preserves the final URL", async () => {
    const calls: [string, RequestInit | undefined][] = [];
    const result = await previewPolicy(page, parent, {
      timeoutMs: 1000,
      resolve,
      fetchImpl: async (url, init) => {
        calls.push([url, init]);
        return html();
      },
    });
    expect(result).toEqual({ allowed: true, url: page });
    expect(calls).toHaveLength(1);
    expect(calls[0]![1]).toMatchObject({ method: "HEAD", credentials: "omit", redirect: "manual" });
    expect(new Headers(calls[0]![1]?.headers).get("authorization")).toBeNull();
    expect(new Headers(calls[0]![1]?.headers).get("cookie")).toBeNull();
  });
  test("unsafe targets never reach DNS or fetch", async () => {
    let attempts = 0;
    const never = async (): Promise<never> => {
      attempts++;
      throw new Error("must not be called");
    };
    for (const target of [
      "bad",
      "javascript:alert(1)",
      "http://example.com",
      "https://127.0.0.1",
      "https://2130706433",
      "https://[::1]",
      "https://metadata.google.internal",
      "https://test.local",
      "https://box.ts.net",
      "https://lianki.com",
      "https://u:p@example.com",
      "https://example.com:8080",
    ]) {
      expect(
        await previewPolicy(target, parent, { timeoutMs: 1000, resolve: never, fetchImpl: never }),
      ).toEqual({ allowed: false });
    }
    expect(attempts).toBe(0);
  });
  test("a non-public DNS answer prevents the request", async () => {
    let requests = 0;
    expect(
      await previewPolicy(page, parent, {
        timeoutMs: 1000,
        resolve: async () => ({ ok: false }),
        fetchImpl: async () => {
          requests++;
          return html();
        },
      }),
    ).toEqual({ allowed: false });
    expect(requests).toBe(0);
  });
  test("redirect hosts are rechecked and private redirects are not followed", async () => {
    const hosts: string[] = [];
    const urls: string[] = [];
    const result = await previewPolicy(page, parent, {
      timeoutMs: 1000,
      resolve: async (host) => {
        hosts.push(host);
        return { ok: true };
      },
      fetchImpl: async (url) => {
        urls.push(url);
        return urls.length === 1
          ? html({ location: "https://next.example/article" }, 302)
          : html({ location: "https://169.254.169.254/metadata" }, 302);
      },
    });
    expect(result).toEqual({ allowed: false });
    expect(hosts).toEqual(["example.com", "next.example"]);
    expect(urls).toHaveLength(2);
  });
  test("finite redirects and HEAD refusal fall back without a GET", async () => {
    let requests = 0;
    expect(
      await previewPolicy(page, parent, {
        timeoutMs: 1000,
        resolve,
        fetchImpl: async () => {
          requests++;
          return html({ location: page }, 302);
        },
      }),
    ).toEqual({ allowed: false });
    expect(requests).toBe(6);
    for (const response of [
      html({}, 405),
      html({ "content-type": "application/pdf" }),
      html({ "x-frame-options": "DENY" }),
    ]) {
      expect(
        await previewPolicy(page, parent, {
          timeoutMs: 1000,
          resolve,
          fetchImpl: async (_url, init) => {
            expect(init?.method).toBe("HEAD");
            return response;
          },
        }),
      ).toEqual({ allowed: false });
    }
  });
  test("timeout aborts the header request", async () => {
    const result = await previewPolicy(page, parent, {
      timeoutMs: 10,
      resolve,
      fetchImpl: (_url, init) =>
        new Promise((_ok, reject) =>
          init!.signal!.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          }),
        ),
    });
    expect(result).toEqual({ allowed: false });
  });
});

test("retain the warmed next frame when graded; keep at most current plus one next", () => {
  const card = (url: string) => ({ url, title: url, previewUrl: url });
  const b = card("https://example.com/b");
  const c = card("https://example.com/c");
  const initial = preparedPreviews([], "https://example.com/a", b);
  expect(initial.map((p) => p.url)).toEqual([b.url]);
  const promoted = preparedPreviews(initial, b.url, c);
  expect(promoted[0]).toBe(initial[0]);
  expect(promoted.map((p) => p.url)).toEqual([b.url, c.url]);
  expect(preparedPreviews(promoted, c.url, null).map((p) => p.url)).toEqual([c.url]);
  expect(
    preparedPreviews(promoted, "https://example.com/unrelated", { ...b, previewUrl: null }),
  ).toEqual([]);
  expect(preparedPreviews(initial, b.url, b)).toHaveLength(1);
});

test("untrusted preview URLs cannot become an iframe source", () => {
  expect(nextCardFrom({ url: page, previewUrl: "javascript:alert(1)" })).toEqual({
    url: page,
    title: null,
    previewUrl: null,
  });
  expect(nextCardFrom({ url: page, previewUrl: page })).toEqual({
    url: page,
    title: null,
    previewUrl: page,
  });
});
