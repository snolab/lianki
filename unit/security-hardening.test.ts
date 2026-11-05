import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { createTestD1 } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import { contactSlackText, CONTACT_PER_IP } from "@/lib/contact";
import { escapeHtml, escapeSlack, safeHref, scriptJson } from "@/lib/security/escape";
import {
  cappedJsonError,
  crossSiteNavigation,
  readJsonCapped,
  routeLimit,
  tooMany,
} from "@/lib/security/route-guard";
import type { ThrottleDb } from "@/lib/security/throttle";
import { isMutatingGet, openable } from "@/app/fsrs";
import { probeReachability } from "@/lib/probe";
import { createGiftCode, redeemGiftCode } from "@/lib/referrals/store";
import { fulfilCheckout } from "@/lib/payments/fulfil";

/**
 * The 2026-11-05 hardening pass (docs/security-measures.md, "Route limits"
 * and "Legacy pages"): escaping, body caps, D1 limits, CSRF on the GETs that
 * write, the probe's redirects, and Pro days that two grants at once both add.
 */
const db = () => createTestD1(testSchema()) as unknown as ThrottleDb;

describe("escaping", () => {
  test("HTML text and attributes", () => {
    expect(escapeHtml(`<img src=x onerror="a('b')">&`)).toBe(
      "&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;",
    );
    expect(escapeHtml(null)).toBe("");
  });

  test("a value in an inline script can't close it", () => {
    const out = scriptJson("</script><script>x()</script> ");
    expect(out).not.toContain("</script");
    expect(out).not.toContain(" ");
    expect(JSON.parse(out)).toBe("</script><script>x()</script> ");
  });

  test("links: http(s) only", () => {
    expect(safeHref("javascript:alert(1)")).toBe("#");
    expect(safeHref('x"><script>')).toBe("#");
    expect(safeHref("data:text/html,hi")).toBe("#");
    expect(safeHref("https://example.com/a?b=1&c=2")).toBe("https://example.com/a?b=1&amp;c=2");
  });

  test("Slack: no links, mentions or channel references from user text", () => {
    expect(escapeSlack("<!channel> <https://evil.example|bank> & <@U123>")).toBe(
      "&lt;!channel&gt; &lt;https://evil.example|bank&gt; &amp; &lt;@U123&gt;",
    );
    const text = contactSlackText({
      name: "<!here>",
      email: "a@b.c",
      message: "<https://x.example|click>",
    });
    expect(text).not.toContain("<!here>");
    expect(text).not.toContain("<https://");
    expect(text).toContain("Phone: N/A");
  });
});

describe("readJsonCapped", () => {
  const post = (body: string, headers: Record<string, string> = {}) =>
    new Request("https://lianki.com/x", { method: "POST", body, headers });

  test("parses a body under the cap", async () => {
    expect(await readJsonCapped(post('{"a":1}'), 100)).toEqual({ ok: true, value: { a: 1 } });
  });

  test("413 by Content-Length, before reading", async () => {
    const r = post("{}", { "content-length": "1000000" });
    expect(await readJsonCapped(r, 100)).toEqual({ ok: false, status: 413 });
  });

  test("413 by the stream when the length is not declared", async () => {
    const big = JSON.stringify({ a: "x".repeat(500) });
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(big));
        c.close();
      },
    });
    const r = new Request("https://lianki.com/x", {
      method: "POST",
      body: stream,
      // @ts-expect-error -- Bun / undici need this for a stream body
      duplex: "half",
    });
    expect(await readJsonCapped(r, 100)).toEqual({ ok: false, status: 413 });
  });

  test("400 for a body that is not JSON", async () => {
    expect(await readJsonCapped(post("nope"), 100)).toEqual({ ok: false, status: 400 });
  });
});

describe("D1 route limits", () => {
  test("allows max hits in a window, then 429 with Retry-After", async () => {
    const d = db();
    const limit = { max: 3, windowMs: 60_000 };
    for (let i = 0; i < 3; i++) expect((await routeLimit("k", limit, d)).allowed).toBe(true);
    expect((await routeLimit("k", limit, d)).allowed).toBe(false);
    const res = await tooMany("k", limit, d);
    expect(res?.status).toBe(429);
    expect(Number(res?.headers.get("retry-after"))).toBeGreaterThan(0);
    // Another key has its own count.
    expect(await tooMany("other", limit, d)).toBeNull();
  });

  test("without D1 (local Mongo dev) the memory counter stands in", async () => {
    const limit = { max: 1, windowMs: 60_000 };
    const key = `mem-${Math.random()}`;
    expect((await routeLimit(key, limit, null)).allowed).toBe(true);
    expect((await routeLimit(key, limit, null)).allowed).toBe(false);
  });

  test("the cap errors say which", async () => {
    const big = cappedJsonError(413);
    expect(big.status).toBe(413);
    expect(await big.json()).toEqual({ error: "Request body too large" });
    expect(cappedJsonError(400).status).toBe(400);
  });

  test("the contact form's per-IP limit is small", () => {
    expect(CONTACT_PER_IP.max).toBeLessThanOrEqual(10);
  });

  test("every route that was unthrottled now counts in D1", () => {
    for (const f of [
      "app/api/contact/route.ts",
      "app/api/gift-codes/redeem/route.ts",
      "app/api/roadmap/generate/route.ts",
      "app/api/import/youtube/route.ts",
      "app/api/words/telemetry/route.ts",
    ])
      expect(readFileSync(f, "utf8")).toMatch(/tooMany\(/);
    for (const f of [
      "lib/read/gloss-server.ts",
      "lib/read/polish-server.ts",
      "lib/read/translate-server.ts",
    ]) {
      const src = readFileSync(f, "utf8");
      expect(src).toMatch(/routeLimit\(/);
      expect(src).not.toMatch(/checkRateLimit\(/);
    }
  });

  test("the AI routes count in D1, with no address in the key", () => {
    for (const f of [
      "app/api/ai-sentences/generate/route.ts",
      "app/api/ai-sentences/new-word/route.ts",
      "app/api/polyglot/translate/route.ts",
      "app/api/polyglot/tts/route.ts",
      "app/api/self-intro/translate/route.ts",
      "app/api/self-intro/tts/route.ts",
      "app/api/translate/route.ts",
      "app/api/tts/route.ts",
    ]) {
      const src = readFileSync(f, "utf8");
      expect(src).toMatch(/routeLimit\(await accountKey\(/);
      expect(src).not.toMatch(/checkRateLimit\(|personKey\(/);
    }
  });

  test("bodies are read with a cap", () => {
    for (const f of [
      "app/api/contact/route.ts",
      "app/api/read/route.ts",
      "app/api/words/telemetry/route.ts",
      "app/api/roadmap/generate/route.ts",
      "app/api/import/youtube/route.ts",
    ])
      expect(readFileSync(f, "utf8")).toMatch(/readJsonCapped\(/);
  });
});

describe("GETs that write: no cross-site navigation", () => {
  const req = (h: Record<string, string>) => new Request("https://lianki.com/x", { headers: h });

  test("a link or redirect from another site is refused", () => {
    expect(
      crossSiteNavigation(req({ "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" })),
    ).toBe(true);
    expect(
      crossSiteNavigation(req({ "sec-fetch-site": "same-site", "sec-fetch-mode": "navigate" })),
    ).toBe(true);
  });

  test("same-origin fetches, typed addresses and non-browser clients pass", () => {
    expect(
      crossSiteNavigation(req({ "sec-fetch-site": "same-origin", "sec-fetch-mode": "navigate" })),
    ).toBe(false);
    expect(
      crossSiteNavigation(req({ "sec-fetch-site": "none", "sec-fetch-mode": "navigate" })),
    ).toBe(false);
    expect(
      crossSiteNavigation(req({ "sec-fetch-site": "cross-site", "sec-fetch-mode": "cors" })),
    ).toBe(false);
    expect(crossSiteNavigation(req({}))).toBe(false);
  });

  test("the legacy pages never window.open a script url", () => {
    expect(openable("javascript:alert(1)")).toBe("about:blank");
    expect(openable(" JavaScript:x")).toBe("about:blank");
    expect(openable("data:text/html,x")).toBe("about:blank");
    expect(openable("https://example.com/")).toBe("https://example.com/");
    expect(openable("lianki://ai-vocab/en/x/1")).toBe("lianki://ai-vocab/en/x/1");
  });

  test("which GETs write", () => {
    expect(isMutatingGet("/api/fsrs/review/good/")).toBe(true);
    expect(isMutatingGet("/api/fsrs/delete")).toBe(true);
    expect(isMutatingGet("/api/fsrs/repeat/")).toBe(true);
    expect(isMutatingGet("/api/fsrs/due")).toBe(false);
    expect(isMutatingGet("/api/fsrs/next")).toBe(false);
    expect(isMutatingGet("/api/fsrs/options")).toBe(false);
  });

  test("the legacy HTML pages escape what they interpolate", () => {
    const src = readFileSync("app/fsrs.ts", "utf8");
    expect(src).not.toMatch(/href="\$\{note\.url\}"/);
    expect(src).not.toMatch(/<script>[^`]*\$\{JSON\.stringify/);
    // The error answer is plain text now, not HTML with the message in it.
    expect(src).not.toContain("<a href='/'>Home</a>");
  });
});

describe("probe redirects", () => {
  test("each hop is checked: a redirect to a private host is not followed", async () => {
    const seen: string[] = [];
    const r = await probeReachability("https://example.test/", {
      fetchImpl: async (u) => {
        seen.push(u);
        return new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/x" },
        });
      },
    });
    expect(seen).toEqual(["https://example.test/"]);
    expect(r).toMatchObject({ reachable: true, status: 302 });
  });

  test("public hops are followed by hand, at most a few", async () => {
    let n = 0;
    const r = await probeReachability("https://example.test/0", {
      fetchImpl: async (_u, init) => {
        expect(init?.redirect).toBe("manual");
        n++;
        return new Response(null, { status: 301, headers: { location: `/${n}` } });
      },
    });
    expect(n).toBeLessThanOrEqual(6);
    expect(r.reachable).toBe(true);
  });
});

describe("Pro days: two grants at once both count", () => {
  const NOW = new Date("2026-11-01T00:00:00Z");
  const DAY = 86_400_000;

  test("two gift codes redeemed at the same moment", async () => {
    const d1 = createTestD1(testSchema());
    d1.raw()
      .prepare("INSERT INTO user (id, email, createdAt, updatedAt) VALUES ('u', 'u@x.com', ?, ?)")
      .run(NOW.toISOString(), NOW.toISOString());
    const a = await createGiftCode(d1, "o@x.com", { days: 7, maxUses: 5, note: "" }, NOW);
    const b = await createGiftCode(d1, "o@x.com", { days: 30, maxUses: 5, note: "" }, NOW);
    const [ra, rb] = await Promise.all([
      redeemGiftCode(d1, "u", a, NOW),
      redeemGiftCode(d1, "u", b, NOW),
    ]);
    expect(ra.status).toBe("redeemed");
    expect(rb.status).toBe("redeemed");
    const row = d1.raw().prepare("SELECT proEndsAt FROM user WHERE id = 'u'").get() as {
      proEndsAt: string;
    };
    expect(row.proEndsAt).toBe(new Date(NOW.getTime() + 37 * DAY).toISOString());
  });

  test("two payments fulfilled at the same moment", async () => {
    const d1 = createTestD1(testSchema());
    d1.raw()
      .prepare("INSERT INTO user (id, email, createdAt, updatedAt) VALUES ('u1', 'a@b.c', ?, ?)")
      .run(NOW.toISOString(), NOW.toISOString());
    const session = (id: string) => ({
      id,
      payment_status: "paid",
      amount_total: 600,
      currency: "jpy",
      client_reference_id: "u1",
      metadata: { userId: "u1", passId: "pro-1m" },
    });
    const [r1, r2] = await Promise.all([
      fulfilCheckout(d1, session("cs_a"), NOW),
      fulfilCheckout(d1, session("cs_b"), NOW),
    ]);
    expect(r1.status).toBe("applied");
    expect(r2.status).toBe("applied");
    const end = new Date(NOW.getTime() + 62 * DAY).toISOString();
    const row = d1.raw().prepare("SELECT proEndsAt FROM user WHERE id = 'u1'").get() as {
      proEndsAt: string;
    };
    expect(row.proEndsAt).toBe(end);
    // Each payment row records the end it set.
    const rows = d1.raw().prepare("SELECT proEndsAt FROM payment ORDER BY proEndsAt").all() as {
      proEndsAt: string;
    }[];
    expect(rows.map((r) => r.proEndsAt)).toEqual([
      new Date(NOW.getTime() + 31 * DAY).toISOString(),
      end,
    ]);
  });
});
