/**
 * Automatic polish of the owner's spoken lines (docs/dev-debug-widget.md,
 * "Automatic polish"): the hub itself asks the main Worker's `polishLines`
 * once the tail window has passed, and applies the answer through the same
 * edit / merge path an agent's polish takes, stamped `by: "auto"`.
 */
import { describe, expect, it } from "bun:test";
import {
  AUTO_POLISH_BY,
  AUTO_POLISH_TAIL_MS,
  DebugHub,
  type HubTimer,
  type Socket,
  type Storage,
} from "@/workers/push/src/debug";
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
  all(type: string) {
    return this.sent.filter((m) => m.type === type);
  }
  last(type: string) {
    return this.all(type).at(-1);
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

/** Timers the suite fires by hand: `fire()` runs every pending one. */
function fakeTimer(): HubTimer & { pending: { f: () => void; ms: number }[]; fire(): number } {
  const pending: { f: () => void; ms: number }[] = [];
  return {
    pending,
    set(f, ms) {
      const h = { f, ms };
      pending.push(h);
      return h;
    },
    clear(h) {
      const i = pending.indexOf(h as { f: () => void; ms: number });
      if (i >= 0) pending.splice(i, 1);
    },
    fire() {
      const due = pending.splice(0);
      for (const { f } of due) f();
      return due.length;
    },
  };
}

type Polish = (req: { userId: string; input: Record<string, unknown> }) => unknown;

function setup(
  opts: {
    polish?: Polish;
    flags?: Record<string, unknown>;
    noRpc?: boolean;
    config?: Record<string, unknown>;
  } = {},
) {
  const flags: Record<string, unknown> = {
    "stt.polish": true,
    "voice.auto-polish": true,
    ...opts.flags,
  };
  const calls: { userId: string; input: Record<string, unknown> }[] = [];
  const polishLines: Polish = async (req) => {
    calls.push(structuredClone(req));
    return opts.polish
      ? opts.polish(req)
      : {
          ok: true,
          verdict: {
            v: 1,
            lines: (req.input.lines as { id: string; text: string }[]).map((l) => ({
              id: l.id,
              text: `${l.text}。`,
            })),
          },
        };
  };
  const SESSIONS = {
    live: async () => "live",
    flag: async (k: string) => flags[k] ?? false,
    config: async (k: string) => opts.config?.[k],
    ...(opts.noRpc ? {} : { polishLines }),
  };
  const sockets: FakeSocket[] = [];
  const timer = fakeTimer();
  let t = 1_000_000;
  const storage = fakeStorage();
  const hub = new DebugHub(
    {
      acceptWebSocket: (ws) => sockets.push(ws as FakeSocket),
      getWebSockets: () => sockets,
      storage,
    },
    { SESSIONS: rpcStub(SESSIONS) },
    () => t,
    timer,
  );
  /** The owner's signed-in page: it carries his user id, which the polish is billed to. */
  const owner = async (user = true) => {
    const ws = new FakeSocket();
    sockets.push(ws);
    await hub.connectPage(
      ws,
      new URL("https://lianki.com/api/version/debug?label=%2Fwords%20pwa%20iPhone"),
      {
        userId: "u_owner",
        email: "o@x",
        owner: true,
        ...(user ? { session: "a".repeat(64), sessionUntil: t + 86_400_000 } : {}),
      },
    );
    return ws;
  };
  const agent = async (page: FakeSocket) => {
    const ws = new FakeSocket();
    sockets.push(ws);
    await hub.connectController(
      ws,
      new URL("https://lianki.com/api/version/debug/control?label=agent"),
    );
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
    const pair = (page.last("state") as { pending: { pair: string } }).pending.pair;
    await hub.webSocketMessage(page, JSON.stringify({ type: "allow", pair, scope: "chat" }));
    return ws;
  };
  const msg = (ws: FakeSocket, m: unknown) => hub.webSocketMessage(ws, JSON.stringify(m));
  const voice = (id: string, text: string) => ({ type: "chat", id, text, source: "stt" });
  /** Fire the tail timer and let the polish round trip settle. */
  const settle = async () => {
    const fired = timer.fire();
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
    return fired;
  };
  const stored = () =>
    [...storage.store.entries()]
      .filter(([k]) => k.startsWith("msg:"))
      .map(([, v]) => v as Record<string, unknown>);
  return {
    hub,
    owner,
    agent,
    msg,
    voice,
    settle,
    stored,
    calls,
    flags,
    timer,
    tick: (ms: number) => (t += ms),
  };
}

describe("automatic polish", () => {
  it("idle wake has no tail timer or RPC; a completed polish leaves neither behind", async () => {
    const s = setup();
    const read = async () =>
      (
        await s.hub.fetch(new Request("https://lianki-push/internal/hub-diagnostics"))
      ).json() as Promise<Record<string, unknown>>;
    expect(s.timer.pending).toHaveLength(0);
    expect(await read()).toMatchObject({
      lastActiveAt: null,
      pendingRpc: 0,
      pendingPolishTimer: false,
      polishBusy: false,
    });
    const p = await s.owner();
    await s.msg(p, s.voice("idle-check", "检查空闲状态"));
    await s.settle();
    expect(s.timer.pending).toHaveLength(0);
    expect(await read()).toMatchObject({
      pendingRpc: 0,
      pendingPolishTimer: false,
      polishBusy: false,
    });
  });

  it("a final voice line is polished by the hub after the tail window, through the edit path", async () => {
    const s = setup();
    const p = await s.owner();
    await s.msg(p, s.voice("v1", "现在是流失传输吗"));
    // Nothing until the tail window: the next fragment may still join.
    expect(s.calls).toHaveLength(0);
    expect(s.timer.pending.map((x) => x.ms)).toEqual([AUTO_POLISH_TAIL_MS]);
    expect(await s.settle()).toBe(1);
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]).toMatchObject({
      userId: "u_owner",
      input: { v: 1, lines: [{ id: "v1", text: "现在是流失传输吗" }], context: [] },
    });
    expect(p.last("edited")).toMatchObject({
      id: "v1",
      text: "现在是流失传输吗。",
      raw: "现在是流失传输吗",
      edited: { by: AUTO_POLISH_BY, count: 1 },
    });
    expect(s.stored()[0]).toMatchObject({ text: "现在是流失传输吗。", raw: "现在是流失传输吗" });
  });

  it("a typed line, an agent's line and a friend's line never trigger it", async () => {
    const s = setup();
    const p = await s.owner();
    const c = await s.agent(p);
    await s.msg(p, { type: "chat", id: "t1", text: "typed by hand" });
    await s.msg(c, { type: "say", text: "an agent's reply" });
    expect(s.timer.pending).toHaveLength(0);
    await s.settle();
    expect(s.calls).toHaveLength(0);
    expect(p.all("edited")).toHaveLength(0);
    // A voice line after them: the run is that one line only (the others end it).
    await s.msg(p, s.voice("v1", "hello there"));
    await s.settle();
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]!.input.lines).toEqual([{ id: "v1", text: "hello there" }]);
    expect((s.calls[0]!.input.context as { from: string }[]).map((h) => h.from)).toEqual([
      "owner",
      "agent",
    ]);
    expect(p.all("edited").map((e) => e.id)).toEqual(["v1"]);
  });

  it("fragments inside the tail window go together, and may come back as one merged passage", async () => {
    const s = setup({
      polish: ({ input }) => ({
        ok: true,
        verdict: {
          v: 1,
          lines: (input.lines as { id: string; text: string }[]).map((l) => ({ ...l })),
          merged: "现在是流式传输吗，还是一次性的？",
        },
      }),
    });
    const p = await s.owner();
    await s.msg(p, s.voice("v1", "现在是流失传输吗"));
    s.tick(500);
    await s.msg(p, s.voice("v2", "还是一次性的"));
    // The second line restarted the window: one timer, one call for both.
    expect(s.timer.pending).toHaveLength(1);
    await s.settle();
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]!.input.lines).toEqual([
      { id: "v1", text: "现在是流失传输吗" },
      { id: "v2", text: "还是一次性的" },
    ]);
    expect(p.last("edited")).toMatchObject({
      id: "v1",
      text: "现在是流式传输吗，还是一次性的？",
      raw: "现在是流失传输吗\n还是一次性的",
      passage: { by: AUTO_POLISH_BY, ids: ["v1", "v2"] },
    });
    const v2 = s.stored().find((m) => m.id === "v2");
    expect(v2).toMatchObject({ collapsedInto: "v1" });
  });

  it("a reopened line (stt.mergeReopenSec) drops its polish and is polished once more, at its passage end", async () => {
    const s = setup({ flags: { "stt.merge": true }, config: { "stt.mergeReopenSec": 20 } });
    const p = await s.owner();
    const timing = (start: number, end: number) => ({
      t_speechStart: start,
      t_lastVoice: end,
      t_speechEnd: end + 600,
    });
    await s.msg(p, { ...s.voice("v1", "我想把按钮放到右边"), timing: timing(0, 1000) });
    await s.settle();
    expect(s.calls).toHaveLength(1);
    expect(s.stored()[0]).toMatchObject({
      text: "我想把按钮放到右边。",
      edited: { by: AUTO_POLISH_BY },
    });
    // Eight seconds later he goes on: the same line, read as heard again.
    s.tick(8000);
    await s.msg(p, {
      ...s.voice("v2", "然后改成红色"),
      timing: timing(8600, 9600),
      continues: "v1",
    });
    expect(s.stored()).toHaveLength(1);
    expect(s.stored()[0]).toMatchObject({ id: "v1", text: "我想把按钮放到右边然后改成红色" });
    // Still being spoken: the tail timer asks nothing.
    await s.settle();
    expect(s.calls).toHaveLength(1);
    // The passage end: one polish for the whole line, and only one.
    await s.msg(p, { type: "passage-end" });
    await s.settle();
    await s.msg(p, { type: "passage-end" });
    await s.settle();
    expect(s.calls).toHaveLength(2);
    expect(s.calls[1]!.input.lines).toEqual([{ id: "v1", text: "我想把按钮放到右边然后改成红色" }]);
    expect(s.stored()[0]).toMatchObject({
      text: "我想把按钮放到右边然后改成红色。",
      edited: { by: AUTO_POLISH_BY },
    });
  });

  it("a line already polished (an agent got there first) is left alone, and never polished twice", async () => {
    const s = setup();
    const p = await s.owner();
    const c = await s.agent(p);
    await s.msg(p, s.voice("v1", "hello world"));
    await s.msg(c, { type: "edit", id: "v1", text: "Hello, world." });
    expect(p.last("edited")).toMatchObject({ edited: { by: "agent" } });
    await s.settle();
    expect(s.calls).toHaveLength(0);
    // Its own polish done, a second tail (another line) does not touch it again.
    await s.msg(p, s.voice("v2", "second line"));
    await s.settle();
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]!.input.lines).toEqual([{ id: "v2", text: "second line" }]);
  });

  it("voice.auto-polish exactly false: nothing is asked; unsure (busy) too; stt.polish off refuses the edit", async () => {
    const s = setup({ flags: { "voice.auto-polish": false } });
    const p = await s.owner();
    await s.msg(p, s.voice("v1", "hello world"));
    await s.settle();
    expect(s.calls).toHaveLength(0);
    expect(p.all("edited")).toHaveLength(0);
    s.flags["voice.auto-polish"] = "busy";
    await s.msg(p, s.voice("v2", "hello again"));
    await s.settle();
    expect(s.calls).toHaveLength(0);
    s.flags["voice.auto-polish"] = true;
    s.flags["stt.polish"] = false;
    await s.msg(p, s.voice("v3", "hello once more"));
    await s.settle();
    expect(s.calls).toHaveLength(1);
    expect(p.all("edited")).toHaveLength(0);
    expect(s.stored().find((m) => m.id === "v3")).toMatchObject({ text: "hello once more" });
  });

  it("a line shorter than the minimum, a page without a user id, or an older main Worker: nothing", async () => {
    const s = setup();
    const p = await s.owner();
    await s.msg(p, s.voice("v1", "嗯"));
    await s.settle();
    expect(s.calls).toHaveLength(0);
    const t = setup();
    const q = await t.owner(false);
    await t.msg(q, t.voice("v1", "hello world"));
    await t.settle();
    expect(t.calls).toHaveLength(0);
    const u = setup({ noRpc: true });
    const r = await u.owner();
    await u.msg(r, u.voice("v1", "hello world"));
    expect(u.timer.pending).toHaveLength(0);
  });

  it("a model answer that changes nothing, fails, or arrives after the line changed is dropped", async () => {
    let answer: unknown = { ok: false, error: "no-credits" };
    const s = setup({ polish: () => answer });
    const p = await s.owner();
    await s.msg(p, s.voice("v1", "hello world"));
    await s.settle();
    expect(s.calls).toHaveLength(1);
    expect(p.all("edited")).toHaveLength(0);
    // The same text back: no edit (the hub never stores an "already reads that way").
    answer = { ok: true, verdict: { v: 1, lines: [{ id: "v2", text: "same words" }] } };
    await s.msg(p, s.voice("v2", "same words"));
    await s.settle();
    expect(p.all("edited")).toHaveLength(0);
    // An id the hub did not send is ignored.
    answer = { ok: true, verdict: { v: 1, lines: [{ id: "zz", text: "injected" }] } };
    await s.msg(p, s.voice("v3", "third"));
    await s.settle();
    expect(p.all("edited")).toHaveLength(0);
    expect(s.stored().map((m) => m.text)).toEqual(["hello world", "same words", "third"]);
  });
});

it("PTT keeps realtime and whole-recording originals with model provenance through final polish", async () => {
  const s = setup({
    polish: async () => ({
      ok: true,
      verdict: { v: 1, lines: [{ id: "ptt-dual", text: "Reconciled final wording." }] },
    }),
  });
  const page = await s.owner();
  const recheck = {
    at: 1_000_000,
    engine: "@cf/openai/whisper-large-v3-turbo",
    heard: "Realtime baseline.",
    text: "Whole recording candidate.",
    lang: "en",
  };
  await s.msg(page, {
    type: "chat",
    id: "ptt-dual",
    text: recheck.heard,
    source: "stt",
    stt: { route: "local", engine: "sensevoice" },
    recheck,
    speaker: { decision: "me" },
  });
  expect(s.stored()[0]).toMatchObject({ text: recheck.heard, recheck });
  expect(s.stored()[0]).not.toHaveProperty("speaker");
  expect(s.stored()[0]).not.toHaveProperty("mergeable");
  await s.settle();
  expect(s.calls[0]!.input.lines).toEqual([
    { id: "ptt-dual", text: recheck.heard, stt: { route: "local", engine: "sensevoice" }, recheck },
  ]);
  expect(s.stored()[0]).toMatchObject({
    text: "Reconciled final wording.",
    raw: recheck.heard,
    recheck,
  });
});

it("cloud PTT retains the complete final even when its live prefix was partial and polish is off", async () => {
  const s = setup({ flags: { "voice.auto-polish": false } });
  const page = await s.owner();
  const recheck = {
    at: 1_000_000,
    engine: "@cf/openai/whisper-large-v3-turbo",
    heard: "Only a preview",
    text: "Only a preview, followed by the complete ending.",
    heardPartial: true,
  };
  await s.msg(page, {
    type: "chat",
    id: "ptt-cloud",
    text: recheck.text,
    source: "stt",
    stt: { route: "cloud", engine: recheck.engine },
    recheck,
  });
  await s.settle();
  expect(s.calls).toHaveLength(0);
  expect(s.stored()[0]).toMatchObject({ text: recheck.text, recheck });
});

describe("automatic polish: earlier lines as read-only context", () => {
  /** His earlier lines and a reply, then the line to polish (the 他/她 case). */
  const talk = async (s: ReturnType<typeof setup>) => {
    const p = await s.owner();
    const c = await s.agent(p);
    await s.msg(p, { type: "chat", id: "t1", text: "我老婆想学日语" });
    await s.msg(c, { type: "say", text: "好的，她现在是什么水平？" });
    await s.msg(p, { type: "chat", id: "t2", text: "她刚开始学" });
    await s.msg(p, s.voice("v1", "因为他的 GitHub 不怎么用"));
    await s.settle();
    return p;
  };

  it("the lines before the run go along, oldest first, and only the run's ids are polished", async () => {
    const s = setup();
    const p = await talk(s);
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]!.input.lines).toEqual([{ id: "v1", text: "因为他的 GitHub 不怎么用" }]);
    expect(s.calls[0]!.input.context).toEqual([
      { from: "owner", text: "我老婆想学日语" },
      { from: "agent", text: "好的，她现在是什么水平？" },
      { from: "owner", text: "她刚开始学" },
    ]);
    expect(p.all("edited").map((e) => e.id)).toEqual(["v1"]);
  });

  it("the window holds to voice.autoPolishContextLines and voice.autoPolishContextChars", async () => {
    const lines = setup({ config: { "voice.autoPolishContextLines": 2 } });
    await talk(lines);
    expect((lines.calls[0]!.input.context as { text: string }[]).map((h) => h.text)).toEqual([
      "好的，她现在是什么水平？",
      "她刚开始学",
    ]);
    // 5 + 12 characters: the second-newest would pass a budget of 10, so it ends the window.
    const chars = setup({ config: { "voice.autoPolishContextChars": 10 } });
    await talk(chars);
    expect(chars.calls[0]!.input.context).toEqual([{ from: "owner", text: "她刚开始学" }]);
  });

  it("0 lines sends no context, and the run is polished as before", async () => {
    const s = setup({ config: { "voice.autoPolishContextLines": 0 } });
    const p = await talk(s);
    expect(s.calls[0]!.input.context).toEqual([]);
    expect(p.last("edited")).toMatchObject({ id: "v1", edited: { by: AUTO_POLISH_BY } });
  });
});
