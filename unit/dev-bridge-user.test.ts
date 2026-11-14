import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

const OWNER = { id: "owner-1", email: "owner@example.com", name: "O", image: null };
const lookups: string[] = [];
// mock.module patches @/auth for the whole bun process: keep its other exports
// (auth, hasSessionCookie, …), or every file that runs after this one and
// imports them fails to link ("Export named 'auth' not found").
const realAuth = await import("@/auth");
mock.module("@/auth", () => ({
  ...realAuth,
  getAuth: async () => ({
    $context: Promise.resolve({
      internalAdapter: {
        findUserByEmail: async (email: string) => {
          lookups.push(email);
          return email === OWNER.email ? { user: OWNER } : null;
        },
      },
    }),
  }),
}));

const { clearPermissionCache, grantAll } = await import("./support/grants");
const { devBridgeUser } = await import("../lib/dev-bridge-user");
const { DEV_BRIDGE_HEADER } = await import("../lib/dev-bridge");

const SECRET = "k".repeat(64);
const req = (h?: string) =>
  new Request("https://lianki.com/api/words/tts", {
    headers: h === undefined ? {} : { [DEV_BRIDGE_HEADER]: h },
  });

describe("devBridgeUser", () => {
  const saved = { s: process.env.DEV_BRIDGE_SECRET };
  beforeAll(() => {
    process.env.DEV_BRIDGE_SECRET = SECRET;
  });
  afterAll(() => {
    process.env.DEV_BRIDGE_SECRET = saved.s;
    clearPermissionCache();
  });

  beforeEach(() => grantAll([OWNER.email, "second@example.com"]));

  test("no header: undefined, so the route uses the session", async () => {
    expect(await devBridgeUser(req())).toBeUndefined();
  });

  test("the right secret: the owner, looked up by the oldest `dev` grant", async () => {
    lookups.length = 0;
    expect(await devBridgeUser(req(SECRET))).toEqual(OWNER);
    expect(lookups).toEqual([OWNER.email]);
  });

  test("a wrong secret: null, and no lookup", async () => {
    lookups.length = 0;
    expect(await devBridgeUser(req("wrong"))).toBeNull();
    expect(await devBridgeUser(req(""))).toBeNull();
    expect(lookups).toEqual([]);
  });

  test("shut while DEV_BRIDGE_SECRET is unset", async () => {
    process.env.DEV_BRIDGE_SECRET = "";
    expect(await devBridgeUser(req(SECRET))).toBeNull();
    process.env.DEV_BRIDGE_SECRET = SECRET;
  });
});
