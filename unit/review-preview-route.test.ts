import { afterEach, beforeEach, expect, test } from "bun:test";
import { useBackend, useNotesCollection } from "./support/testMocks";
import { stubGlobals } from "./support/globals";
import { clearConfigCache, readConfig } from "../lib/config-store";
import type { D1Like } from "../lib/d1/types";

const { fsrsHandler } = await import("../app/fsrs");
const url = "https://example.com/next-page";
let note: { url: string; title: string } | null;
let requests: { url: string; init?: RequestInit }[];
let restore: () => void;
const req = () =>
  new Request(
    "https://lianki.com/api/fsrs/next-preview?excludeUrl=https%3A%2F%2Fexample.com%2Fcurrent&url=https%3A%2F%2F127.0.0.1%2Fignored",
  );

beforeEach(() => {
  useBackend("mongodb");
  note = { url, title: "Next saved page" };
  useNotesCollection({ findOne: async () => note });
  clearConfigCache();
  requests = [];
  restore = stubGlobals({
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      const target =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      requests.push({ url: target, init });
      if (target.startsWith("https://cloudflare-dns.com/")) {
        return Response.json({
          Status: 0,
          Answer: target.includes("type=AAAA") ? [] : [{ type: 1, data: "93.184.216.34" }],
        });
      }
      expect(target).toBe(url);
      return new Response(null, { headers: { "content-type": "text/html" } });
    },
  });
});

afterEach(() => {
  restore();
  clearConfigCache();
  useNotesCollection(null);
});

async function config(values: Record<string, unknown>) {
  await readConfig(
    () =>
      ({
        prepare: () => ({
          all: async () => ({
            results: Object.entries(values).map(([key, value]) => ({
              key,
              value_json: JSON.stringify(value),
            })),
          }),
        }),
      }) as unknown as D1Like,
  );
}

test("checks only the authenticated queue's next card and never a caller-supplied target", async () => {
  const response = await fsrsHandler(req(), "reader@example.test");
  expect(await response.json()).toEqual({ url, title: "Next saved page", previewUrl: url });
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(requests).toHaveLength(3);
  expect(requests.filter((r) => r.init?.method === "HEAD").map((r) => r.url)).toEqual([url]);
  for (const r of requests) {
    expect(new Headers(r.init?.headers).get("authorization")).toBeNull();
    expect(new Headers(r.init?.headers).get("cookie")).toBeNull();
  }
});

test("the config switch disables all outbound checks but keeps the next card", async () => {
  await config({ "review.nextPreview": false });
  expect(await (await fsrsHandler(req(), "disabled@example.test")).json()).toEqual({
    url,
    title: "Next saved page",
    previewUrl: null,
  });
  expect(requests).toHaveLength(0);
});

test("the per-account cap falls back to a link without preventing review", async () => {
  await config({ "review.previewChecksPerMinute": 1 });
  expect((await (await fsrsHandler(req(), "throttled@example.test")).json()).previewUrl).toBe(url);
  const count = requests.length;
  const response = await fsrsHandler(req(), "throttled@example.test");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ url, title: "Next saved page", previewUrl: null });
  expect(requests).toHaveLength(count);
});

test("no due card or no identity makes no outbound request", async () => {
  note = null;
  expect(await (await fsrsHandler(req(), "finished@example.test")).json()).toEqual({
    url: null,
    title: null,
    previewUrl: null,
  });
  expect((await fsrsHandler(req())).status).toBe(401);
  expect(requests).toHaveLength(0);
});
