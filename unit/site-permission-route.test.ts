import { test, expect } from "bun:test";
import {
  manageSitePermissions,
  consumeSitePageRead,
  type SitePermissionRouteDeps,
} from "../lib/site-permission-route";
import {
  verifySiteAction,
  SITE_ACTION_HEADER,
  siteReadAccountBinding,
} from "../lib/site-permission-ticket";
import { SitePermissionAuthority } from "../lib/site-permission-authority";
import { parseSitePermissionAction } from "../lib/site-permission-wire";
const now = 1800000000000;
const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const defaultBinding = await siteReadAccountBinding(
  keys.privateKey,
  "account_a",
  "https://example.test",
);
function harness() {
  const state = new Map<string, unknown>();
  let account = "account_a";
  let signedIn = true,
    on = true,
    limited = false,
    missing = false,
    throwing = false;
  const authority = new SitePermissionAuthority(
    {
      get: async <T>(k: string) => structuredClone(state.get(k)) as T | undefined,
      put: async (k, v) => {
        state.set(k, structuredClone(v));
      },
    },
    { now: () => now },
  );
  const deps: SitePermissionRouteDeps = {
    user: async () => (signedIn ? { id: account } : null),
    key: async () => (missing ? null : keys.privateKey),
    now: () => now,
    allow: async () => !limited,
    chatOn: async () => on,
    push: () => ({
      fetch: async (req) => {
        if (throwing) throw Error("synthetic network failure");
        const action = parseSitePermissionAction(await req.json());
        if (!action) return Response.json({ ok: false, error: "invalid" }, { status: 400 });
        const claims = await verifySiteAction(
          req.headers.get(SITE_ACTION_HEADER) ?? "",
          keys.publicKey,
          action,
          now,
        );
        if (!claims) return Response.json({ ok: false, error: "invalid" }, { status: 403 });
        const result = await authority.execute(claims.sub, action, claims);
        return Response.json({ ...result, privateCapability: "never-return-this-field" });
      },
    }),
  };
  return {
    deps,
    state,
    set: (v: {
      signedIn?: boolean;
      account?: string;
      on?: boolean;
      limited?: boolean;
      missing?: boolean;
      throwing?: boolean;
    }) => {
      if (v.signedIn !== undefined) signedIn = v.signedIn;
      if (v.account !== undefined) account = v.account;
      if (v.on !== undefined) on = v.on;
      if (v.limited !== undefined) limited = v.limited;
      if (v.missing !== undefined) missing = v.missing;
      if (v.throwing !== undefined) throwing = v.throwing;
    },
  };
}
const request = (body: unknown, extra: Record<string, string> = {}, path = "site-permissions") =>
  new Request("https://lianki.com/api/chat/" + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-lianki-site-account": defaultBinding,
      origin: "https://lianki.com",
      "sec-fetch-site": "same-origin",
      ...extra,
    },
    body: JSON.stringify(body),
  });
const origin = "https://example.test";
const consume = (revision: number) => ({
  op: "consume",
  origin,
  scope: "page.read",
  revision,
  requestId: "request_read_001",
  selection: { text: "Chosen text", title: "Page", url: origin + "/article?private=removed#part" },
});
test("only first-party cookie management can enable an exact site; read and revoke use the same authoritative state", async () => {
  const h = harness();
  let response = await consumeSitePageRead(
    request(consume(0), { "x-lianki-userscript": "1" }, "site-page-read"),
    h.deps,
  );
  expect((await response.json()).error).toBe("denied");
  response = await manageSitePermissions(
    request({ op: "set", origin, scope: "page.read", enabled: true }),
    h.deps,
  );
  const grant = await response.json();
  expect(grant.grant.enabled).toBe(true);
  expect(grant.privateCapability).toBeUndefined();
  response = await consumeSitePageRead(
    request(consume(grant.grant.revision), { "x-lianki-userscript": "1" }, "site-page-read"),
    h.deps,
  );
  const read = await response.json();
  expect(read.kind).toBe("selection");
  expect(read.selection.url).toBe(origin + "/article");
  expect(read.privateCapability).toBeUndefined();
  await manageSitePermissions(
    request({ op: "set", origin, scope: "page.read", enabled: false }),
    h.deps,
  );
  response = await consumeSitePageRead(
    request(consume(grant.grant.revision), { "x-lianki-userscript": "1" }, "site-page-read"),
    h.deps,
  );
  expect((await response.json()).error).toBe("denied");
  expect(JSON.stringify([...h.state])).not.toContain("Chosen text");
});
test("cross-site, GM-marked management, bearer, forged authority and unknown capability fields cannot grant themselves access", async () => {
  const h = harness(),
    set = { op: "set", origin, scope: "page.read", enabled: true };
  expect(
    (
      await manageSitePermissions(
        request(set, {
          origin: "https://evil.test",
          "sec-fetch-site": "cross-site",
          "x-lianki-userscript": "1",
        }),
        h.deps,
      )
    ).status,
  ).toBe(403);
  expect(
    (await manageSitePermissions(request(set, { authorization: "Bearer synthetic" }), h.deps))
      .status,
  ).toBe(403);
  expect((await manageSitePermissions(request({ ...set, sub: "other" }), h.deps)).status).toBe(400);
  expect(
    (
      await consumeSitePageRead(
        request(set, { "x-lianki-userscript": "1" }, "site-page-read"),
        h.deps,
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await consumeSitePageRead(
        request({ ...consume(0), scope: "eval" }, { "x-lianki-userscript": "1" }, "site-page-read"),
        h.deps,
      )
    ).status,
  ).toBe(400);
  expect(h.state.size).toBe(0);
});
test("signed-out, off, rate-limited and unavailable states fail closed while revocation remains possible with chat off", async () => {
  const h = harness();
  h.set({ signedIn: false });
  expect((await manageSitePermissions(request({ op: "list" }), h.deps)).status).toBe(401);
  h.set({ signedIn: true, on: false });
  expect(
    (await consumeSitePageRead(request(consume(0), { "x-lianki-userscript": "1" }), h.deps)).status,
  ).toBe(403);
  expect(
    (
      await manageSitePermissions(
        request({ op: "set", origin, scope: "page.read", enabled: false }),
        h.deps,
      )
    ).status,
  ).toBe(200);
  h.set({ limited: true });
  expect((await manageSitePermissions(request({ op: "list" }), h.deps)).status).toBe(429);
  h.set({ limited: false, missing: true });
  expect((await manageSitePermissions(request({ op: "list" }), h.deps)).status).toBe(503);
  h.set({ missing: false, throwing: true });
  expect((await manageSitePermissions(request({ op: "list" }), h.deps)).status).toBe(503);
});

test("status exposes only a single exact-site grant and an opaque account binding; switched account cannot reuse it", async () => {
  const h = harness();
  const query = () =>
    request({ op: "status", origin }, { "x-lianki-userscript": "1" }, "site-page-read");
  const a = await (await consumeSitePageRead(query(), h.deps)).json();
  expect(a.grant.enabled).toBe(false);
  expect(a.accountBinding).toBe(defaultBinding);
  expect(a.sub).toBeUndefined();
  expect(a.grants).toBeUndefined();
  h.set({ account: "account_b" });
  await manageSitePermissions(
    request({ op: "set", origin, scope: "page.read", enabled: true }),
    h.deps,
  );
  const b = await (await consumeSitePageRead(query(), h.deps)).json();
  expect(b.accountBinding).not.toBe(a.accountBinding);
  const response = await consumeSitePageRead(
    request(
      consume(b.grant.revision),
      { "x-lianki-userscript": "1", "x-lianki-site-account": a.accountBinding },
      "site-page-read",
    ),
    h.deps,
  );
  expect(response.status).toBe(409);
  expect((await response.json()).error).toBe("denied");
  expect((await consumeSitePageRead(request({ op: "status", origin }), h.deps)).status).toBe(403);
});
