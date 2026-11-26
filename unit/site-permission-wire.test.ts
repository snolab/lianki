import { describe, expect, it } from "bun:test";
import {
  canonicalExactSiteOrigin,
  parseSitePageReadRequest,
  readSitePageReadRequest,
  parseSitePermissionAuthorityAction,
  parseSitePermissionManagementInput as manage,
  parseSitePermissionConsumeInput as consume,
  readSitePermissionManagementInput as readManage,
  readSitePermissionConsumeInput as readConsume,
  SITE_PERMISSION_MAX_BYTES,
} from "../lib/site-permission-wire";
const origin = "https://example.test";
const selected = () => ({
  op: "consume" as const,
  origin,
  scope: "page.read" as const,
  revision: 3,
  requestId: "selection_123",
  selection: {
    text: "  Chosen passage.  ",
    title: "Synthetic page",
    url: origin + "/article?private=value#selection",
  },
});
const request = (body: BodyInit, headers?: Record<string, string>) =>
  new Request("https://lianki.test", {
    method: "POST",
    body,
    headers,
    duplex: "half",
  } as RequestInit);
function credentialUrl(path = "") {
  const url = new URL("https://example.test" + path);
  url.username = "synthetic-user";
  url.password = "synthetic-password";
  return path ? url.href : url.href.replace(/\/$/, "");
}

describe("exact-site page.read wire schemas", () => {
  it("requires an exact canonical HTTPS origin without normalizing or inferring a domain", () => {
    for (const raw of [
      origin,
      "https://sub.example.test",
      "https://example.test:8443",
      "https://xn--bcher-kva.test",
    ])
      expect(canonicalExactSiteOrigin(raw)).toBe(raw);
    for (const raw of [
      null,
      {},
      [],
      "",
      "http://example.test",
      "HTTPS://example.test",
      "https://EXAMPLE.test",
      origin + "/",
      origin + "/path",
      origin + "?x=1",
      origin + "#x",
      credentialUrl(),
      "https://@example.test",
      "https://*.example.test",
      " https://example.test",
      "https://example.test ",
      "https://example.test:443",
      "https://bücher.test",
      "https://" + "a".repeat(200) + ".test",
      "not a URL",
    ])
      expect(canonicalExactSiteOrigin(raw)).toBeNull();
    expect(canonicalExactSiteOrigin("https://example.test.evil.test")).toBe(
      "https://example.test.evil.test",
    );
  });
  it("keeps management operations distinct from the browser's consume schema", () => {
    expect(manage({ op: "list" })).toEqual({ op: "list" });
    expect(manage({ op: "inspect", origin })).toEqual({ op: "inspect", origin });
    for (const enabled of [true, false])
      expect(manage({ op: "set", origin, scope: "page.read", enabled })).toEqual({
        op: "set",
        origin,
        scope: "page.read",
        enabled,
      });
    expect(manage(selected())).toBeNull();
    for (const value of [
      { op: "list" },
      { op: "inspect", origin },
      { op: "set", origin, scope: "page.read", enabled: true },
    ])
      expect(consume(value)).toBeNull();
    expect(parseSitePermissionAuthorityAction({ op: "inspect", origin })).toEqual({
      op: "inspect",
      origin,
    });
    expect(parseSitePermissionAuthorityAction(selected())).toEqual(consume(selected()));
    expect(parseSitePermissionAuthorityAction({ op: "eval" })).toBeNull();
  });
  it("preserves the selected text but removes page query and fragment identifiers", () => {
    expect(consume(selected())).toEqual({
      ...selected(),
      selection: { ...selected().selection, url: origin + "/article" },
    });
    expect(
      consume({ ...selected(), revision: 0, selection: { text: "x", title: "", url: origin } })
        ?.selection.url,
    ).toBe(origin + "/");
    expect(
      consume({
        ...selected(),
        selection: {
          text: "文".repeat(9000),
          title: "t".repeat(300),
          url: origin + "/" + "p".repeat(2000 - origin.length - 1),
        },
      }),
    ).not.toBeNull();
  });
  it("rejects unknown scopes and authority fields in both contracts", () => {
    for (const scope of [
      "page.execute",
      "account.read",
      "chat",
      "page.*",
      "*",
      null,
      ["page.read"],
    ]) {
      expect(manage({ op: "set", origin, scope, enabled: true })).toBeNull();
      expect(consume({ ...selected(), scope })).toBeNull();
    }
    for (const key of [
      "userId",
      "owner",
      "token",
      "thread",
      "generation",
      "sessionId",
      "enabled",
      "code",
      "authorization",
    ]) {
      expect(manage({ op: "list", [key]: "synthetic" })).toBeNull();
      expect(manage({ op: "inspect", origin, [key]: "synthetic" })).toBeNull();
      expect(consume({ ...selected(), [key]: "synthetic" })).toBeNull();
    }
    expect(
      manage({ op: "set", origin, scope: "page.read", enabled: true, extra: false }),
    ).toBeNull();
    expect(
      consume({ ...selected(), selection: { ...selected().selection, html: "<p>no</p>" } }),
    ).toBeNull();
    expect(manage({ op: "list", [Symbol("extra")]: true })).toBeNull();
  });
  it("rejects similar hosts, subdomains and unsafe or credential-bearing selected page URLs", () => {
    for (const url of [
      "https://sub.example.test/article",
      "https://example.test.evil.test/article",
      "https://example-test/article",
      "https://example.test:8443/article",
      "http://example.test/article",
      "javascript:alert(1)",
      "data:text/plain,x",
      "/relative",
      credentialUrl("/article"),
      "https://@example.test/article",
      "https://",
      "https://evil.test/#https://example.test",
    ])
      expect(consume({ ...selected(), selection: { ...selected().selection, url } })).toBeNull();
  });
  it("bounds every selected field, revision and request identity and rejects missing or non-object inputs", () => {
    for (const revision of [-1, 0.5, NaN, Infinity, "3", Number.MAX_SAFE_INTEGER + 1])
      expect(consume({ ...selected(), revision })).toBeNull();
    for (const requestId of ["", "short", "a".repeat(65), "invalid/path", 123])
      expect(consume({ ...selected(), requestId })).toBeNull();
    for (const [key, value] of [
      ["text", " "],
      ["text", "x".repeat(9001)],
      ["text", null],
      ["title", "x".repeat(301)],
      ["title", null],
      ["url", origin + "/" + "x".repeat(2000)],
      ["url", null],
    ] as const)
      expect(
        consume({ ...selected(), selection: { ...selected().selection, [key]: value } }),
      ).toBeNull();
    for (const key of Object.keys(selected())) {
      const value: Record<string, unknown> = selected();
      delete value[key];
      expect(consume(value)).toBeNull();
    }
    for (const key of ["text", "title", "url"]) {
      const selection: Record<string, unknown> = { ...selected().selection };
      delete selection[key];
      expect(consume({ ...selected(), selection })).toBeNull();
    }
    for (const value of [null, [], false, "set", new Date()]) {
      expect(manage(value)).toBeNull();
      expect(consume(value)).toBeNull();
    }
    expect(manage({ op: "set", origin, scope: "page.read", enabled: "true" })).toBeNull();
    expect(manage({ op: "inspect", origin: origin + "/" })).toBeNull();
    expect(consume({ ...selected(), origin: origin + "/" })).toBeNull();
    expect(consume({ ...selected(), selection: [] })).toBeNull();
    const throws = Object.defineProperty({}, "op", {
      enumerable: true,
      get() {
        throw Error("synthetic");
      },
    });
    expect(manage(throws)).toBeNull();
    expect(consume(throws)).toBeNull();
  });
  it("bounds streamed bytes independently of length metadata and decodes only valid JSON/UTF-8", async () => {
    expect(await readManage(request(JSON.stringify({ op: "list" })))).toEqual({ op: "list" });
    expect(await readConsume(request(JSON.stringify(selected())))).toEqual(consume(selected()));
    expect(await readManage(request(JSON.stringify(selected())))).toBeNull();
    expect(await readConsume(request(JSON.stringify({ op: "list" })))).toBeNull();
    for (const body of ["{", "null", new Uint8Array([255])])
      expect(await readManage(request(body))).toBeNull();
    expect(await readManage(new Request("https://lianki.test", { method: "POST" }))).toBeNull();
    for (const length of ["junk", "-1", String(SITE_PERMISSION_MAX_BYTES + 1)])
      expect(await readManage(request("{}", { "content-length": length }))).toBe("too-large");
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(SITE_PERMISSION_MAX_BYTES + 1));
      },
      cancel() {
        cancelled = true;
      },
    });
    expect(await readConsume(request(body, { "content-length": "0" }))).toBe("too-large");
    expect(cancelled).toBe(true);
    const broken = new ReadableStream<Uint8Array>({
      start(c) {
        c.error(Error("synthetic"));
      },
    });
    expect(await readManage(request(broken))).toBeNull();
  });
});

describe("the public selected-page bridge status contract", () => {
  it("accepts only the exact single-site status shape and the existing consume action", () => {
    expect(parseSitePageReadRequest({ op: "status", origin })).toEqual({ op: "status", origin });
    expect(parseSitePageReadRequest(selected())).toEqual(consume(selected()));
    expect(consume({ op: "status", origin })).toBeNull();
    expect(manage({ op: "status", origin })).toBeNull();
  });
  it("rejects management names, noncanonical origins and extra status authority fields", () => {
    for (const input of [
      { op: "list" },
      { op: "inspect", origin },
      { op: "set", origin, scope: "page.read", enabled: true },
      { op: "status" },
      { op: "status", origin: "http://example.test" },
      { op: "status", origin: origin + "/" },
      { op: "status", origin: "https://*.example.test" },
      { op: "status", origin: "https://user@example.test" },
      { op: "status", origin: origin + "?private=synthetic" },
      { op: "status", origin: origin + "#fragment" },
      null,
      [],
      false,
      "status",
    ])
      expect(parseSitePageReadRequest(input)).toBeNull();
    for (const key of [
      "scope",
      "enabled",
      "userId",
      "token",
      "revision",
      "selection",
      "requestId",
      "thread",
    ])
      expect(parseSitePageReadRequest({ op: "status", origin, [key]: "synthetic" })).toBeNull();
    expect(parseSitePageReadRequest({ op: "status", origin, [Symbol("extra")]: true })).toBeNull();
    const bad = Object.defineProperty({}, "op", {
      enumerable: true,
      get() {
        throw Error("synthetic");
      },
    });
    expect(parseSitePageReadRequest(bad)).toBeNull();
  });
  it("preserves distinct similar origins rather than returning a wildcard or inferred parent", () => {
    for (const site of [origin, "https://sub.example.test", "https://example.test.evil.test"])
      expect(parseSitePageReadRequest({ op: "status", origin: site })).toEqual({
        op: "status",
        origin: site,
      });
  });
  it("uses the bounded body reader and never admits a management request through it", async () => {
    expect(
      await readSitePageReadRequest(request(JSON.stringify({ op: "status", origin }))),
    ).toEqual({ op: "status", origin });
    expect(await readSitePageReadRequest(request(JSON.stringify(selected())))).toEqual(
      consume(selected()),
    );
    for (const input of [
      { op: "list" },
      { op: "inspect", origin },
      { op: "set", origin, scope: "page.read", enabled: true },
    ])
      expect(await readSitePageReadRequest(request(JSON.stringify(input)))).toBeNull();
    expect(
      await readSitePageReadRequest(
        request("{}", { "content-length": String(SITE_PERMISSION_MAX_BYTES + 1) }),
      ),
    ).toBe("too-large");
    expect(await readSitePageReadRequest(request("{"))).toBeNull();
  });
});
