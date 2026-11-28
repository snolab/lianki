import { test, expect } from "bun:test";
import { DebugHub, type Storage } from "../workers/push/src/debug";
import { b64url } from "../lib/stt-ticket";
import {
  signSiteAction,
  SITE_ACTION_PATH,
  SITE_ACTION_HEADER,
} from "../lib/site-permission-ticket";
import type { SitePermissionAction } from "../lib/site-permission-wire";
const now = 1800000000000;
async function fixture() {
  const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const pub = b64url(new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey)));
  const data = new Map<string, unknown>();
  const storage: Storage = {
    get: async <T>(k: string) => structuredClone(data.get(k)) as T | undefined,
    put: async (k, v) => {
      data.set(k, structuredClone(v));
    },
    delete: async (k) => data.delete(k),
    list: async <T>() => new Map<string, T>(),
    getAlarm: async () => null,
    setAlarm: async () => {},
  };
  const hub = new DebugHub(
    { storage, acceptWebSocket() {}, getWebSockets: () => [] },
    { PARTNER_TICKET_PUB: pub },
    () => now,
  );
  const make = async (action: SitePermissionAction, sub = "account_a") =>
    new Request("https://lianki-push" + SITE_ACTION_PATH, {
      method: "POST",
      headers: { [SITE_ACTION_HEADER]: await signSiteAction(keys.privateKey, sub, action, now) },
      body: JSON.stringify(action),
    });
  const call = async (a: SitePermissionAction, sub?: string) =>
    (await hub.fetch(await make(a, sub))).json() as Promise<any>;
  return { hub, make, call, data };
}
const site = "https://example.test";
test("actual private DO boundary verifies capabilities and authoritatively revokes old revisions", async () => {
  const f = await fixture();
  const granted = await f.call({ op: "set", origin: site, scope: "page.read", enabled: true });
  const action = {
    op: "consume",
    origin: site,
    scope: "page.read",
    revision: granted.grant.revision,
    requestId: "selected_001",
    selection: { text: "Only selected content", title: "Page", url: site + "/a" },
  } as const;
  const pending = await f.make(action);
  const revoke = await f.call({ op: "set", origin: site, scope: "page.read", enabled: false });
  expect(revoke.grant.enabled).toBe(false);
  expect((await (await f.hub.fetch(pending)).json()).error).toBe("denied");
  expect((await f.call({ op: "list" }, "account_b")).grants).toEqual([]);
  expect(JSON.stringify([...f.data])).not.toContain("Only selected content");
});
test("actual private DO rejects replay, altered action and a public hostname", async () => {
  const f = await fixture(),
    a = { op: "list" } as const;
  const req = await f.make(a),
    again = req.clone();
  expect((await f.hub.fetch(req)).status).toBe(200);
  expect((await (await f.hub.fetch(again)).json()).error).toBe("replay");
  const altered = await f.make(a);
  expect(
    (
      await f.hub.fetch(
        new Request(altered.url, {
          method: "POST",
          headers: altered.headers,
          body: JSON.stringify({ op: "set", origin: site, scope: "page.read", enabled: true }),
        }),
      )
    ).status,
  ).toBe(403);
  const publicReq = await f.make(a);
  expect(
    (await f.hub.fetch(new Request("https://lianki.com" + SITE_ACTION_PATH, publicReq))).status,
  ).toBe(403);
  expect(
    (
      await f.hub.fetch(
        new Request("https://lianki-push" + SITE_ACTION_PATH, { method: "POST", body: "{}" }),
      )
    ).status,
  ).toBe(400);
});
