import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";

const OWNER = { id: "owner-1", email: "owner@example.com", name: "O", image: null };
const lookups: string[] = [];
mock.module("@/auth", () => ({
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

const { devBridgeUser } = await import("../lib/dev-bridge-user");
const { DEV_BRIDGE_HEADER } = await import("../lib/dev-bridge");

const SECRET = "k".repeat(64);
const req = (h?: string) =>
  new Request("https://lianki.com/api/words/tts", {
    headers: h === undefined ? {} : { [DEV_BRIDGE_HEADER]: h },
  });

describe("devBridgeUser", () => {
  const saved = { s: process.env.DEV_BRIDGE_SECRET, o: process.env.OWNER_EMAILS };
  beforeAll(() => {
    process.env.DEV_BRIDGE_SECRET = SECRET;
    process.env.OWNER_EMAILS = `${OWNER.email},second@example.com`;
  });
  afterAll(() => {
    process.env.DEV_BRIDGE_SECRET = saved.s;
    process.env.OWNER_EMAILS = saved.o;
  });

  test("no header: undefined, so the route uses the session", async () => {
    expect(await devBridgeUser(req())).toBeUndefined();
  });

  test("the right secret: the owner, looked up by the first OWNER_EMAILS address", async () => {
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
