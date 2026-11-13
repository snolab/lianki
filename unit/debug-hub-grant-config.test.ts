/**
 * The owner's eval grant from live config (lib/eval-grant-config.ts,
 * docs/monitoring.md "Remote eval"): its length (`debug.evalGrantHours`) and
 * page scope (`debug.evalGrantPages`), read by the hub at the knock over
 * DebugSessions.config. What must hold: the modal is told what Allow grants;
 * Allow grants exactly that; anything unreadable gives 8 hours and the ticked
 * pages; End still deletes the grant at once.
 */
import { describe, expect, it } from "bun:test";
import { DebugHub, type Socket, type Storage, hashToken } from "@/workers/push/src/debug";
import { EVAL_GRANT_MS } from "@/lib/dev-eval";
import { rpcStub } from "./support/rpc-stub";

class FakeSocket implements Socket {
  sent: Record<string, unknown>[] = [];
  readyState = 1;
  closed?: number;
  private att: unknown = null;
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code?: number) {
    this.readyState = 3;
    this.closed = code;
  }
  serializeAttachment(v: unknown) {
    this.att = structuredClone(v);
  }
  deserializeAttachment() {
    return this.att;
  }
  last(type: string) {
    return this.sent.filter((m) => m.type === type).at(-1);
  }
}

function fakeStorage() {
  const store = new Map<string, unknown>();
  const s: Storage & { store: Map<string, unknown> } = {
    store,
    async getAlarm() {
      return null;
    },
    async setAlarm() {},
    get: async <T>(k: string) => structuredClone(store.get(k)) as T | undefined,
    put: async (k, v) => void store.set(k, structuredClone(v)),
    delete: async (k) => store.delete(k),
    list: async <T>({ prefix }: { prefix: string }) =>
      new Map(
        [...store.keys()]
          .filter((k) => k.startsWith(prefix))
          .sort()
          .map((k) => [k, structuredClone(store.get(k)) as T]),
      ),
  };
  return s;
}

const T0 = 5_000_000;
const DAY = 24 * 60 * 60_000;

type Config = Record<string, unknown> | "throw" | "none";

function setup(config: Config) {
  const sockets: FakeSocket[] = [];
  const storage = fakeStorage();
  const asked: string[] = [];
  const sessions: Record<string, unknown> = { live: async () => "live" };
  if (config !== "none")
    sessions.config = async (key: string) => {
      asked.push(key);
      if (config === "throw") throw new Error("main down");
      return config[key];
    };
  const hub = new DebugHub(
    { acceptWebSocket: () => {}, getWebSockets: () => sockets, storage },
    { SESSIONS: rpcStub(sessions) },
    () => T0,
  );
  const add = () => {
    const ws = new FakeSocket();
    sockets.push(ws);
    return ws;
  };
  const ownerPage = async (tab: string, dev?: string) => {
    const ws = add();
    await hub.connectPage(
      ws,
      new URL(
        `https://lianki.com/api/version/debug?label=/words&tab=${tab}${dev ? `&dev=${dev}` : ""}`,
      ),
      { userId: "owner1", email: "o@x.com", owner: true },
    );
    return ws;
  };
  const friendPage = async () => {
    const ws = add();
    await hub.connectPage(ws, new URL("https://lianki.com/api/version/debug?label=/words"), {
      userId: "f1",
      email: "f1@x.com",
      owner: false,
    });
    return ws;
  };
  const controller = async (q = "") => {
    const ws = add();
    await hub.connectController(
      ws,
      new URL(`https://lianki.com/api/version/debug/control?label=agent${q}`),
    );
    return ws;
  };
  const msg = (ws: FakeSocket, m: unknown) => hub.webSocketMessage(ws, JSON.stringify(m));
  const pending = (p: FakeSocket) =>
    (p.last("state") as { pending: Record<string, unknown> | null }).pending;
  const stored = async (token: string) =>
    storage.store.get(`grant:${await hashToken(token)}`) as
      | { until: number; pages?: string[]; ms?: number; devices?: Record<string, string> }
      | undefined;
  const leave = (ws: FakeSocket) => {
    ws.close(1001);
    hub.webSocketClose(ws, 1001);
  };
  return { hub, asked, ownerPage, friendPage, controller, msg, pending, stored, leave };
}

describe("eval grant length and pages from live config", () => {
  it("30 days on all pages: the modal says so, and Allow grants exactly that", async () => {
    const s = setup({ "debug.evalGrantHours": 720, "debug.evalGrantPages": "all" });
    const phone = await s.ownerPage("phone-tab-1");
    const mac = await s.ownerPage("mac-tab-0001");
    const c = await s.controller();
    expect(s.asked.sort()).toEqual(["debug.evalGrantHours", "debug.evalGrantPages"]);
    const p = s.pending(phone)!;
    expect(p).toMatchObject({ grantMs: 30 * DAY, allPages: true, scope: "eval" });
    // Ticking only this page does not narrow it: the grant covers every page.
    await s.msg(phone, { type: "allow", pair: p.pair, pages: ["phone-tab-1"] });
    const approved = c.last("approved") as { until: number; token: string };
    expect(approved.until).toBe(T0 + 30 * DAY);
    const g = await s.stored(approved.token);
    expect(g).toMatchObject({ until: T0 + 30 * DAY, ms: 30 * DAY });
    expect(g?.pages).toBeUndefined();
    // Both devices' pages get the code, and a page opened later too.
    const later = await s.ownerPage("ipad-tab-0001");
    await s.msg(c, { type: "eval", code: "1" });
    for (const page of [phone, mac, later]) expect(page.last("eval")).toBeTruthy();
    expect(c.last("sent")).toMatchObject({ delivered: 3 });
  });

  it("End deletes the 30-day grant at once", async () => {
    const s = setup({ "debug.evalGrantHours": 720, "debug.evalGrantPages": "all" });
    const phone = await s.ownerPage("phone-tab-1");
    const c = await s.controller();
    await s.msg(phone, { type: "allow", pair: s.pending(phone)!.pair, pages: "all" });
    const { token } = c.last("approved") as { token: string };
    expect(await s.stored(token)).toBeTruthy();
    const session = (phone.last("state") as { sessions: { pair: string }[] }).sessions[0]!;
    await s.msg(phone, { type: "revoke", pair: session.pair });
    expect(await s.stored(token)).toBeUndefined();
    expect(c.closed).toBe(4401);
  });

  it("the defaults when the store says nothing: 8 hours, the pages ticked", async () => {
    const s = setup({});
    const phone = await s.ownerPage("phone-tab-1");
    await s.ownerPage("mac-tab-0001");
    const c = await s.controller();
    const p = s.pending(phone)!;
    expect(p.grantMs).toBe(EVAL_GRANT_MS);
    expect(p.allPages).toBeUndefined();
    await s.msg(phone, { type: "allow", pair: p.pair, pages: ["phone-tab-1"] });
    const { until, token } = c.last("approved") as { until: number; token: string };
    expect(until).toBe(T0 + EVAL_GRANT_MS);
    expect((await s.stored(token))?.pages).toEqual(["phone-tab-1"]);
  });

  it("an unreadable or out-of-range value gives the defaults", async () => {
    for (const config of [
      "throw",
      { "debug.evalGrantHours": 721, "debug.evalGrantPages": "every" },
      { "debug.evalGrantHours": 1.5 },
    ] as Config[]) {
      const s = setup(config);
      const phone = await s.ownerPage("phone-tab-1");
      await s.controller();
      expect(s.pending(phone)).toMatchObject({ grantMs: EVAL_GRANT_MS });
      expect(s.pending(phone)?.allPages).toBeUndefined();
    }
  });

  it("an older main Worker with no config method: no wait, the defaults", async () => {
    const s = setup("none");
    const phone = await s.ownerPage("phone-tab-1");
    const c = await s.controller();
    const p = s.pending(phone)!;
    expect(p.grantMs).toBeUndefined();
    await s.msg(phone, { type: "allow", pair: p.pair, pages: "all" });
    expect((c.last("approved") as { until: number }).until).toBe(T0 + EVAL_GRANT_MS);
  });

  it("a chat request asks nothing about the eval grant", async () => {
    const s = setup({ "debug.evalGrantHours": 720 });
    const phone = await s.ownerPage("phone-tab-1");
    await s.controller("&scope=chat");
    expect(s.asked).toEqual([]);
    expect(s.pending(phone)?.grantMs).toBeUndefined();
  });
});

const PHONE = "phone-device-01";
const MAC = "mac-device-00001";

describe("rejoin: a page that comes back on the same device under a new page id", () => {
  /** "Authorize this page" on the phone's page, then the app restarts (a new tab id). */
  const restart = async () => {
    const s = setup({});
    const phone = await s.ownerPage("phone-tab-1", PHONE);
    const mac = await s.ownerPage("mac-tab-0001", MAC);
    const c = await s.controller();
    await s.msg(phone, { type: "allow", pair: s.pending(phone)!.pair, pages: ["phone-tab-1"] });
    const { token } = c.last("approved") as { token: string };
    expect((await s.stored(token))?.devices).toEqual({ "phone-tab-1": PHONE });
    s.leave(phone);
    return { s, c, mac, token };
  };

  it("takes the gone page's place: the sender reaches it again, no prompt", async () => {
    const { s, c, token } = await restart();
    const again = await s.ownerPage("phone-tab-2", PHONE);
    expect((await s.stored(token))?.pages).toEqual(["phone-tab-2"]);
    expect((await s.stored(token))?.devices).toEqual({ "phone-tab-2": PHONE });
    expect(again.last("state")?.pending).toBeNull();
    await s.msg(c, { type: "eval", code: "1", target: "words" });
    expect(again.last("eval")).toBeTruthy();
    expect(c.last("sent")).toMatchObject({ delivered: 1 });
  });

  it("never from another device, and never while the granted page is still open", async () => {
    const { s, c, mac, token } = await restart();
    const other = await s.ownerPage("ipad-tab-0001", "ipad-device-001");
    expect((await s.stored(token))?.pages).toEqual(["phone-tab-1"]);
    await s.msg(c, { type: "eval", code: "1" });
    expect(other.last("eval")).toBeUndefined();
    expect(mac.last("eval")).toBeUndefined();
    // A second tab on the phone while the granted one is open: not taken either.
    const s2 = setup({});
    const p1 = await s2.ownerPage("phone-tab-1", PHONE);
    const c2 = await s2.controller();
    await s2.msg(p1, { type: "allow", pair: s2.pending(p1)!.pair, pages: ["phone-tab-1"] });
    const t2 = (c2.last("approved") as { token: string }).token;
    await s2.ownerPage("phone-tab-2", PHONE);
    expect((await s2.stored(t2))?.pages).toEqual(["phone-tab-1"]);
  });

  it("a friend's page on that device rejoins nothing", async () => {
    const { s, token } = await restart();
    await s.friendPage();
    expect((await s.stored(token))?.pages).toEqual(["phone-tab-1"]);
  });

  it("an all-pages grant keeps no page list to rejoin", async () => {
    const s = setup({ "debug.evalGrantPages": "all" });
    const phone = await s.ownerPage("phone-tab-1", PHONE);
    const c = await s.controller();
    await s.msg(phone, { type: "allow", pair: s.pending(phone)!.pair, pages: ["phone-tab-1"] });
    const g = await s.stored((c.last("approved") as { token: string }).token);
    expect(g?.pages).toBeUndefined();
    expect(g?.devices).toBeUndefined();
  });
});
