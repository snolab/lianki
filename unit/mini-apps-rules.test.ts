/**
 * Mini apps' pure rules (docs/mini-apps.md): slugs, manifests, the HTML
 * checks, capabilities, grant states, the CSP, origins, the ticket, and the
 * order in which the SDK and the CSP go into the file.
 */
import { describe, expect, test } from "bun:test";
import {
  CAPABILITY_IDS,
  capabilityOf,
  isCapability,
  isMethod,
} from "../lib/mini-apps/capabilities";
import { checkHtml, isSlug, parseManifest, DEFAULT_ICON } from "../lib/mini-apps/manifest";
import { decisionOf, grantState, grantsOf, isChoice } from "../lib/mini-apps/grants";
import {
  checkExternalRefs,
  miniAppCsp,
  miniAppCspMeta,
  parseSources,
  sandboxFlags,
} from "../lib/mini-apps/csp";
import {
  appOrigin,
  isMiniHost,
  miniHostPath,
  ownOriginAllowed,
  pageOrigin,
  siteOf,
} from "../lib/mini-apps/origin";
import { secretUsable, signTicket, verifyTicket, type Ticket } from "../lib/mini-apps/ticket";
import { prepareHtml } from "../lib/mini-apps/html";
import { CONFIG } from "../lib/config";
import { siblingRequestRefused } from "../lib/security/same-site-guard";

describe("slugs", () => {
  test("lowercase ASCII words joined by single hyphens, at most 40, not reserved", () => {
    for (const ok of ["calc", "a", "word-quiz", "x2", "a".repeat(40)])
      expect(isSlug(ok)).toBe(true);
    for (const bad of [
      "",
      "Calc",
      "-calc",
      "calc-",
      "a--b",
      "a_b",
      "a b",
      "日本",
      "a".repeat(41),
      "sdk",
      "presets",
      "api",
      7,
      null,
    ])
      expect(isSlug(bad)).toBe(false);
  });
});

describe("manifest", () => {
  test("a full manifest is kept; defaults fill icon, version, permissions", () => {
    const r = parseManifest({
      slug: "calc",
      name: "  Calculator‮ ",
      icon: "🧮",
      version: "1.2.3",
      permissions: ["storage", "chat:write", "storage"],
    });
    expect(r).toEqual({
      ok: true,
      manifest: {
        slug: "calc",
        name: "Calculator",
        icon: "🧮",
        version: "1.2.3",
        permissions: ["storage", "chat:write"],
      },
    });
    const d = parseManifest({ slug: "x", name: "X" });
    expect(d.ok && d.manifest).toEqual({
      slug: "x",
      name: "X",
      icon: DEFAULT_ICON,
      version: "0.1.0",
      permissions: [],
    });
  });

  test("every bad field has its own error", () => {
    const base = { slug: "calc", name: "C" };
    const err = (m: unknown) => {
      const r = parseManifest(m);
      return r.ok ? null : r.error;
    };
    expect(err(null)).toBe("manifest-required");
    expect(err([])).toBe("manifest-required");
    expect(err({ ...base, slug: "Bad" })).toBe("bad-slug");
    expect(err({ ...base, name: "" })).toBe("bad-name");
    expect(err({ ...base, name: "x".repeat(61) })).toBe("bad-name");
    expect(err({ ...base, icon: "123456789" })).toBe("bad-icon");
    expect(err({ ...base, version: "1.2" })).toBe("bad-version");
    expect(err({ ...base, version: 1 })).toBe("bad-version");
    expect(err({ ...base, permissions: "storage" })).toBe("bad-permissions");
    expect(err({ ...base, permissions: Array(17).fill("storage") })).toBe("bad-permissions");
    expect(err({ ...base, permissions: ["eval"] })).toBe("unknown-permission");
  });

  test("the file: an HTML document within the cap", () => {
    expect(checkHtml("<!doctype html><p>hi", 100)).toEqual({ ok: true, bytes: 20 });
    expect(checkHtml("<div>ü</div>", 100)).toEqual({ ok: true, bytes: 13 });
    expect(checkHtml("", 100)).toEqual({ ok: false, error: "html-required" });
    expect(checkHtml(5, 100)).toEqual({ ok: false, error: "html-required" });
    expect(checkHtml("<div>" + "x".repeat(200), 100)).toEqual({
      ok: false,
      error: "too-big",
      max: 100,
    });
    expect(checkHtml("just text", 100)).toEqual({ ok: false, error: "not-html" });
    expect(checkHtml("<div>\u0000</div>", 100)).toEqual({ ok: false, error: "not-html" });
  });
});

describe("capabilities and grants", () => {
  test("each method maps to exactly one capability", () => {
    expect(CAPABILITY_IDS).toContain("storage");
    expect(capabilityOf("storage.set")).toBe("storage");
    expect(capabilityOf("prefs.get")).toBe("prefs:read");
    expect(capabilityOf("prefs.set")).toBe("prefs:write");
    expect(capabilityOf("chat.read")).toBe("chat:read");
    expect(capabilityOf("chat.say")).toBe("chat:write");
    expect(capabilityOf("ui.card")).toBe("chat:ask");
    expect(capabilityOf("eval")).toBeNull();
    expect(capabilityOf(3)).toBeNull();
    expect(isMethod("storage.list")).toBe(true);
    expect(isCapability("chat:ask")).toBe(true);
    expect(isCapability("toString")).toBe(false);
  });

  test("states: undeclared first, then the stored answer, else a prompt", () => {
    const declared = ["storage", "chat:write"];
    expect(grantState(declared, {}, "prefs:read")).toBe("undeclared");
    expect(grantState(declared, {}, "nope")).toBe("undeclared");
    expect(grantState(declared, {}, "storage")).toBe("prompt");
    expect(grantState(declared, { storage: "allow" }, "storage")).toBe("granted");
    expect(grantState(declared, { storage: "once" }, "storage")).toBe("granted");
    expect(grantState(declared, { storage: "deny" }, "storage")).toBe("denied");
    expect(decisionOf("app")).toBe("allow");
    expect(decisionOf("once")).toBe("once");
    expect(decisionOf("deny")).toBe("deny");
    expect(isChoice("app")).toBe(true);
    expect(isChoice("always")).toBe(false);
    expect(
      grantsOf([
        { permission: "storage", decision: "allow" },
        { permission: "eval", decision: "allow" },
        { permission: "chat:read", decision: "maybe" },
      ]),
    ).toEqual({ storage: "allow" });
  });
});

describe("the CSP", () => {
  const scripts = parseSources(CONFIG["miniApps.scriptOrigins"].default);
  const styles = parseSources(CONFIG["miniApps.styleOrigins"].default);
  const fonts = parseSources(CONFIG["miniApps.fontOrigins"].default);

  test("sources: https only, deduplicated, junk dropped", () => {
    expect(scripts).toEqual([
      "https://cdnjs.cloudflare.com",
      "https://cdn.jsdelivr.net/npm/",
      "https://unpkg.com",
      "https://cdn.tailwindcss.com",
      "https://code.jquery.com",
    ]);
    expect(parseSources("http://x.com, https://a.com ,https://a.com, javascript:1, *")).toEqual([
      "https://a.com",
    ]);
  });

  test("header: no network, nothing but the allowlist, frame-ancestors and sandbox", () => {
    const csp = miniAppCsp({
      scripts,
      styles,
      fonts,
      assets: ["https://lianki.com/", "https://m.lianki.com"],
      ancestors: "https://lianki.com",
      sandbox: sandboxFlags(false),
    });
    expect(csp).toStartWith("default-src 'none'; ");
    expect(csp).toContain(
      "script-src 'unsafe-inline' 'unsafe-eval' https://lianki.com/m/ https://m.lianki.com/m/ https://cdnjs.cloudflare.com",
    );
    expect(csp).toContain(
      "style-src 'unsafe-inline' https://lianki.com/m/ https://m.lianki.com/m/ https://fonts.googleapis.com",
    );
    expect(csp).toContain(
      "font-src data: https://lianki.com/m/ https://m.lianki.com/m/ https://fonts.gstatic.com",
    );
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("img-src data: blob:");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("frame-ancestors https://lianki.com");
    expect(csp).toEndWith("sandbox allow-scripts allow-forms");
  });

  test("meta: the same, without what a <meta> cannot carry", () => {
    const meta = miniAppCspMeta({
      scripts,
      styles,
      fonts,
      assets: "http://localhost:3000",
      ancestors: "x",
      sandbox: "y",
    });
    expect(meta).toContain("http://localhost:3000/m/");
    expect(meta).not.toContain("frame-ancestors");
    expect(meta).not.toContain("sandbox");
  });

  test("sandbox: never allow-same-origin unless asked", () => {
    expect(sandboxFlags(false)).toBe("allow-scripts allow-forms");
    expect(sandboxFlags(true)).toBe("allow-scripts allow-forms allow-same-origin");
  });

  test("external refs: allowlisted, and scripts pinned to an exact version", () => {
    const allow = { scripts, styles };
    const ok = `
      <script src="https://unpkg.com/react@18.3.1/umd/react.production.min.js"></script>
      <script src='https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js'></script>
      <script src="https://cdnjs.cloudflare.com/ajax/libs/lodash.js/4.17.21/lodash.min.js"></script>
      <script src="https://code.jquery.com/jquery-3.7.1.min.js"></script>
      <script src="/m/sdk.js"></script><script>inline()</script>
      <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Klee+One">
      <link rel="stylesheet" href="/m/presets/lianki.css"><link rel="icon" href="https://evil.example/x.png">`;
    expect(checkExternalRefs(ok, allow)).toBeNull();
    expect(
      checkExternalRefs('<script src="https://evil.example/a@1.0.0.js"></script>', allow),
    ).toEqual({
      error: "script-source",
      url: "https://evil.example/a@1.0.0.js",
    });
    expect(checkExternalRefs('<script src="https://unpkg.com/react"></script>', allow)?.error).toBe(
      "script-unpinned",
    );
    expect(
      checkExternalRefs('<script src="https://unpkg.com/react@18"></script>', allow)?.error,
    ).toBe("script-unpinned");
    expect(
      checkExternalRefs('<script src="https://cdn.jsdelivr.net/gh/x/y@1.0.0/a.js"></script>', allow)
        ?.error,
    ).toBe("script-source");
    expect(
      checkExternalRefs('<script src="//unpkg.com/react@18.3.1/x.js"></script>', allow)?.error,
    ).toBe("script-source");
    expect(checkExternalRefs('<script src="/m/../api/x"></script>', allow)?.error).toBe(
      "script-source",
    );
    expect(
      checkExternalRefs('<link href="https://evil.example/a.css" rel="stylesheet">', allow),
    ).toEqual({ error: "style-source", url: "https://evil.example/a.css" });
    const exact = { scripts: ["https://cdn.example.com/lib.js"], styles: [] };
    expect(
      checkExternalRefs('<script src="https://cdn.example.com/lib.js"></script>', exact)?.error,
    ).toBe("script-unpinned");
    expect(
      checkExternalRefs('<script src="https://cdn.example.com/other.js"></script>', exact)?.error,
    ).toBe("script-source");
  });
});

describe("origins", () => {
  const id = "0123456789abcdef";
  test("the app origin from the template", () => {
    expect(appOrigin("", id)).toBeNull();
    expect(appOrigin("https://m.lianki.com", "nope")).toBeNull();
    expect(appOrigin("https://m.lianki.com", id)).toBe("https://m.lianki.com");
    expect(appOrigin("https://{app}.liankiapps.com", id)).toBe(`https://${id}.liankiapps.com`);
    expect(appOrigin("http://m.localhost:3000", id)).toBe("http://m.localhost:3000");
    expect(appOrigin("http://m.lianki.com", id)).toBeNull();
    expect(appOrigin("not a url", id)).toBeNull();
  });

  test("own origin only for one app per origin on another site", () => {
    expect(siteOf("a.b.lianki.com:443")).toBe("lianki.com");
    expect(siteOf("m.localhost:3000")).toBe("localhost");
    expect(siteOf("localhost")).toBe("localhost");
    const per = "https://{app}.liankiapps.com";
    expect(ownOriginAllowed(per, appOrigin(per, id), "https://lianki.com")).toBe(true);
    expect(
      ownOriginAllowed("https://m.lianki.com", "https://m.lianki.com", "https://lianki.com"),
    ).toBe(false);
    const sib = "https://{app}.m.lianki.com";
    expect(ownOriginAllowed(sib, appOrigin(sib, id), "https://lianki.com")).toBe(false);
    expect(ownOriginAllowed(per, null, "https://lianki.com")).toBe(false);
  });

  test("a mini host serves only the app route and /m/ files", () => {
    for (const h of ["m.lianki.com", "abc.m.lianki.com", "m.localhost:3000"])
      expect(isMiniHost(h)).toBe(true);
    for (const h of ["lianki.com", "www.lianki.com", "m.lianki.com.evil.com", null])
      expect(isMiniHost(h)).toBe(false);
    expect(miniHostPath("/api/m/calc")).toBe(true);
    expect(miniHostPath("/m/sdk.js")).toBe(true);
    expect(miniHostPath("/m/presets/lianki.css")).toBe(true);
    for (const p of ["/", "/m/calc", "/api/my/mini-apps", "/m/presets/../x", "/api/m/calc/x"])
      expect(miniHostPath(p)).toBe(false);
  });

  test("the page origin from the request headers", () => {
    expect(pageOrigin("lianki.com", "https")).toBe("https://lianki.com");
    expect(pageOrigin("localhost:3000", null)).toBe("http://localhost:3000");
    expect(pageOrigin("localhost:3000", "https")).toBe("https://localhost:3000");
    expect(pageOrigin("evil.com/<x>", null)).toBe("https://lianki.com");
    expect(pageOrigin(null, null)).toBe("https://lianki.com");
  });

  test("a sibling may read an app's file (ticket only) but nothing else of /api", () => {
    const req = (path: string, method = "GET") =>
      new Request(`https://lianki.com${path}`, {
        method,
        headers: { "sec-fetch-site": "same-site", cookie: "lang=en" },
      });
    expect(siblingRequestRefused(req("/api/m/calc"))).toBe(false);
    expect(siblingRequestRefused(req("/api/m/calc", "POST"))).toBe(true);
    expect(siblingRequestRefused(req("/api/my/mini-apps"))).toBe(true);
  });
});

describe("the ticket", () => {
  const secret = "s".repeat(32);
  const t: Ticket = {
    u: "u1",
    a: "0123456789abcdef",
    s: "calc",
    h: "abcd",
    b: "https://lianki.com",
    f: "https://lianki.com",
    e: 2_000,
  };
  test("signed, verified, expired, tampered", async () => {
    expect(secretUsable(secret)).toBe(true);
    expect(secretUsable("short")).toBe(false);
    expect(secretUsable(undefined)).toBe(false);
    const raw = await signTicket(t, secret);
    expect(await verifyTicket(raw, secret, 1_000)).toEqual(t);
    expect(await verifyTicket(raw, secret, 2_000)).toBeNull();
    expect(await verifyTicket(raw, "x".repeat(32), 1_000)).toBeNull();
    const [body, sig] = raw.split(".");
    const forged = btoa(JSON.stringify({ ...t, u: "u2" })).replace(/=+$/, "");
    expect(await verifyTicket(`${forged}.${sig}`, secret, 1_000)).toBeNull();
    expect(await verifyTicket(`${body}.${sig}.x`, secret, 1_000)).toBeNull();
    expect(await verifyTicket(`${body}`, secret, 1_000)).toBeNull();
    expect(await verifyTicket(`${body}.!!!`, secret, 1_000)).toBeNull();
    expect(await verifyTicket(7, secret, 1_000)).toBeNull();
    expect(await verifyTicket("a".repeat(2001), secret, 1_000)).toBeNull();
    const noType = await signTicket({ ...t, u: 5 } as unknown as Ticket, secret);
    expect(await verifyTicket(noType, secret, 1_000)).toBeNull();
  });
});

describe("the file as the frame gets it", () => {
  test("the CSP and the SDK go before anything of the app's", () => {
    const out = prepareHtml("<!DOCTYPE html><script>evil()</script><head></head>", {
      sdkSrc: "https://lianki.com/m/sdk.js",
      cspMeta: `default-src 'none'; x "<>&`,
    });
    expect(out).toBe(
      '<!DOCTYPE html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; x &quot;&lt;&gt;&amp;"><script src="https://lianki.com/m/sdk.js"></script><script>evil()</script><head></head>',
    );
    expect(prepareHtml("<p>hi</p>", { sdkSrc: "/m/sdk.js" })).toBe(
      '<script src="/m/sdk.js"></script><p>hi</p>',
    );
  });
});
