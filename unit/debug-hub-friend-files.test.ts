/**
 * A user's (friend's) line with files in their own thread: the hub keeps only
 * the refs the main Worker says are that thread's account's own
 * (DebugSessions.threadFiles; lib/inbox/thread-files.ts). Another account's id,
 * an unknown one, no answer or an older main Worker: the line goes, without them.
 */
import { describe, expect, it } from "bun:test";
import { DebugHub, type HubTimer, type Socket, type Storage } from "@/workers/push/src/debug";
import { rpcStub } from "./support/rpc-stub";

class FakeSocket implements Socket {
  sent: Record<string, unknown>[] = [];
  readyState = 1;
  private att: unknown = null;
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
  }
  serializeAttachment(v: unknown) {
    this.att = structuredClone(v);
  }
  deserializeAttachment() {
    return this.att;
  }
}

function fakeStorage(): Storage & { store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  return {
    store,
    getAlarm: async () => null,
    setAlarm: async () => {},
    get: async <T>(k: string) => structuredClone(store.get(k)) as T | undefined,
    put: async (k, v) => void store.set(k, structuredClone(v)),
    delete: async (k) => store.delete(k),
    list: async <T>({
      prefix,
      reverse,
      limit,
    }: {
      prefix: string;
      reverse?: boolean;
      limit?: number;
    }) => {
      let keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
      if (reverse) keys.reverse();
      if (limit !== undefined) keys = keys.slice(0, limit);
      return new Map(keys.map((k) => [k, structuredClone(store.get(k)) as T]));
    },
  };
}

const timer: HubTimer = { set: () => ({}), clear: () => {} };
const MINE = "a".repeat(20);
const THEIRS = "b".repeat(20);
/** What D1 holds: id → its owner and row. */
const ROWS: Record<string, { owner: string; name: string; type: string; size: number }> = {
  [MINE]: { owner: "uF", name: "photo.png", type: "image/png", size: 1234 },
  [THEIRS]: { owner: "uOther", name: "secret.png", type: "image/png", size: 99 },
};

function setup(threadFiles?: (req: { userId: string; ids: string[] }) => Promise<unknown>) {
  const asked: { userId: string; ids: string[] }[] = [];
  const SESSIONS = {
    live: async () => "live",
    flag: async () => false,
    config: async () => undefined,
    ...(threadFiles
      ? {
          threadFiles: async (req: { userId: string; ids: string[] }) => {
            asked.push(req);
            return threadFiles(req);
          },
        }
      : {}),
  };
  const sockets: FakeSocket[] = [];
  const storage = fakeStorage();
  const hub = new DebugHub(
    {
      acceptWebSocket: (ws) => sockets.push(ws as FakeSocket),
      getWebSockets: () => sockets,
      storage,
    },
    { SESSIONS: rpcStub(SESSIONS) },
    () => 1_000_000,
    timer,
  );
  const friend = async () => {
    const ws = new FakeSocket();
    sockets.push(ws);
    await hub.connectPage(ws, new URL("https://lianki.com/api/version/debug?label=%2Fwords"), {
      userId: "uF",
      email: "f@example.com",
      owner: false,
    });
    return ws;
  };
  const posted = () =>
    [...storage.store.entries()]
      .filter(([k]) => k.startsWith("t:uF:msg:"))
      .map(
        ([, v]) =>
          v as { id: string; thread: string; attachments?: { id: string; name: string }[] },
      );
  const say = (ws: FakeSocket, attachments: unknown[]) =>
    hub.webSocketMessage(ws, JSON.stringify({ type: "chat", id: "l1", text: "look", attachments }));
  return { friend, posted, say, asked };
}

const ref = (id: string, name = "claimed.png") => ({ id, name, type: "image/png", size: 1 });
/** The main Worker's real rule, over ROWS: the account's own ids only, as stored. */
const own = async ({ userId, ids }: { userId: string; ids: string[] }) => ({
  ok: true,
  files: ids
    .filter((id) => ROWS[id]?.owner === userId)
    .map((id) => ({ id, name: ROWS[id]!.name, type: ROWS[id]!.type, size: ROWS[id]!.size })),
});

describe("a user's files on their own thread", () => {
  it("keeps the account's own file, as stored, and drops another account's id", async () => {
    const s = setup(own);
    const ws = await s.friend();
    await s.say(ws, [ref(MINE), ref(THEIRS)]);
    expect(s.asked).toEqual([{ userId: "uF", ids: [MINE, THEIRS] }]);
    const [line] = s.posted();
    expect(line!.thread).toBe("uF");
    expect(line!.attachments).toEqual([
      { id: MINE, name: "photo.png", type: "image/png", size: 1234 } as never,
    ]);
  });

  it("only another account's id: the line goes without files", async () => {
    const s = setup(own);
    await s.say(await s.friend(), [ref(THEIRS)]);
    const [line] = s.posted();
    expect(line!.id).toBe("l1");
    expect(line!.attachments).toBeUndefined();
  });

  it("fails closed: an error, a refusal or an older main Worker keeps no files", async () => {
    for (const rpc of [
      async () => {
        throw new Error("down");
      },
      async () => ({ ok: false, error: "busy" }),
      undefined,
    ]) {
      const s = setup(rpc);
      await s.say(await s.friend(), [ref(MINE)]);
      const [line] = s.posted();
      expect(line!.id).toBe("l1");
      expect(line!.attachments).toBeUndefined();
    }
  });

  it("a line without files never asks", async () => {
    const s = setup(own);
    await s.say(await s.friend(), []);
    expect(s.asked).toEqual([]);
    expect(s.posted()).toHaveLength(1);
  });
});
