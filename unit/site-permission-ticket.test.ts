import { test, expect } from "bun:test";
import { signSiteAction, verifySiteAction, SITE_ACTION_AUD } from "../lib/site-permission-ticket";
import { b64url, fromB64url } from "../lib/stt-ticket";
import type { SiteReadAction } from "../lib/site-permission-wire";
const now = 1800000000000;
const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const action: SiteReadAction = {
  op: "consume",
  origin: "https://example.test",
  scope: "page.read",
  revision: 2,
  requestId: "request_0001",
  selection: { text: "Selected page text", title: "Example", url: "https://example.test/notes" },
};
test("site action ticket binds principal, exact origin, scope, revision and body with a separate audience", async () => {
  const t = await signSiteAction(keys.privateKey, "account_a", action, now);
  const c = await verifySiteAction(t, keys.publicKey, action, now);
  expect(c?.aud).toBe(SITE_ACTION_AUD);
  expect(c?.sub).toBe("account_a");
  expect(c?.mode).toBe("page.read");
  expect(c?.exp).toBe(c!.iat + 60);
  expect(
    await verifySiteAction(
      t,
      keys.publicKey,
      {
        ...action,
        origin: "https://other.example.test",
        selection: { ...action.selection, url: "https://other.example.test/notes" },
      },
      now,
    ),
  ).toBeNull();
  expect(await verifySiteAction(t, keys.publicKey, { ...action, revision: 3 }, now)).toBeNull();
  expect(
    await verifySiteAction(
      t,
      keys.publicKey,
      { ...action, selection: { ...action.selection, text: "Changed" } },
      now,
    ),
  ).toBeNull();
  expect(
    await verifySiteAction(
      t,
      keys.publicKey,
      { op: "set", origin: action.origin, scope: "page.read", enabled: true },
      now,
    ),
  ).toBeNull();
  expect(await verifySiteAction(t, keys.publicKey, action, now + 60000)).toBeNull();
  expect(await verifySiteAction(t, keys.publicKey, action, now - 6000)).toBeNull();
});
test("management cannot be repurposed as a read and damaged or mismatched tickets fail closed", async () => {
  const a = { op: "list" } as const;
  const t = await signSiteAction(keys.privateKey, "account_a", a, now);
  expect((await verifySiteAction(t, keys.publicKey, a, now))?.mode).toBe("manage");
  expect(await verifySiteAction(t, keys.publicKey, action, now)).toBeNull();
  expect(await verifySiteAction(t + ".x", keys.publicKey, a, now)).toBeNull();
  expect(await verifySiteAction("x".repeat(1601), keys.publicKey, a, now)).toBeNull();
  expect(await verifySiteAction("??.??", keys.publicKey, a, now)).toBeNull();
  const other = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  expect(await verifySiteAction(t, other.publicKey, a, now)).toBeNull();
  const [body] = t.split(".");
  const claims = JSON.parse(new TextDecoder().decode(fromB64url(body)));
  for (const change of [
    { aud: "lianki-page-chat-http" },
    { jti: "short" },
    { sub: "" },
    { exp: claims.exp + 1 },
    { origin: "https://example.test" },
    { revision: 1 },
    { mode: "page.read" },
    { digest: "bad" },
    { iat: 1.5 },
  ]) {
    const altered = b64url(new TextEncoder().encode(JSON.stringify({ ...claims, ...change })));
    const signed =
      altered +
      "." +
      b64url(
        new Uint8Array(
          await crypto.subtle.sign("Ed25519", keys.privateKey, new TextEncoder().encode(altered)),
        ),
      );
    expect(await verifySiteAction(signed, keys.publicKey, a, now)).toBeNull();
  }
});
test("invalid actions cannot be signed or digested into capabilities", async () => {
  await expect(signSiteAction(keys.privateKey, "", action, now)).rejects.toThrow();
  await expect(
    signSiteAction(keys.privateKey, "account_a", { ...action, scope: "eval" } as never, now),
  ).rejects.toThrow();
});
