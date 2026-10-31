import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DebugHub, type Socket, type Storage } from "@/workers/push/src/debug";
import {
  CLIPS_GONE_MS,
  CLIPS_HIDDEN_MS,
  HANDOFF_PARAM,
  type ClipsState,
  activeSink,
  handoffHref,
  matchesSession,
  ownerOrigins,
  parseClipsControl,
  parseClipsPageMessage,
  takeHandoff,
} from "@/packages/debug-chat/src/clips";
import {
  clipPosted,
  clipsAction,
  clipsConnectQuery,
  clipsDeparted,
  clipsDevice,
  clipsExpired,
  clipsLive,
  clipsRestored,
  holdWakeLock,
  onClipsState,
  postSessionClip,
  setClipsSender,
} from "@/packages/debug-chat/src/clips-store";
import { postClip, sideClip } from "@/packages/debug-chat/src/mic";
import {
  CLIPS_ORIGIN,
  type SinkKeys,
  clipsOrigins,
  handleClips,
  sinkKeys,
} from "@/scripts/dev/clip-sink";

// Voice-clip recording as a window session held by the hub
// (packages/debug-chat/src/clips.ts; owner, 2026-10-31): never in an
// origin's storage, carried across origins by a one-time handoff, ended by
// a closed window (2 min) but not by a sleeping screen, never deleting a clip.

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
  clips() {
    return this.sent.filter((m) => m.type === "clips").at(-1) as ClipsState | undefined;
  }
}

function fakeStorage(
  store = new Map<string, unknown>(),
): Storage & { store: Map<string, unknown> } {
  let alarm: number | null = null;
  return {
    store,
    getAlarm: async () => alarm,
    setAlarm: async (at: number) => void (alarm = at),
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
}

const SID_A = "sessionAAAAAAAAAAAAA";
const SID_B = "sessionBBBBBBBBBBBBB";
const DEV_PHONE = "devicePHONEPHONEPHONE";
const DEV_MAC = "deviceMACMACMACMACMAC";
const SINK = "https://mac.example.ts.net/lianki-widget";
const KEYS: SinkKeys = { read: "r".repeat(43), write: "w".repeat(43) };
const DEV_ORIGIN = "https://mac.example.ts.net:8443";

function setup() {
  const sockets: FakeSocket[] = [];
  let t = 1_000_000;
  const storage = fakeStorage();
  const hub = new DebugHub(
    { acceptWebSocket: () => {}, getWebSockets: () => sockets, storage },
    undefined,
    () => t,
  );
  const page = async (
    q: { ws?: string; dev?: string; hand?: string; cont?: string } = {},
    label = "/words pwa Android",
    origin = "https://lianki.com",
  ) => {
    const ws = new FakeSocket();
    sockets.push(ws);
    const p = new URLSearchParams({ label, ...q });
    await hub.connectPage(ws, new URL(`${origin}/api/version/debug?${p}`));
    return ws;
  };
  const msg = (ws: FakeSocket, m: unknown) => hub.webSocketMessage(ws, JSON.stringify(m));
  const leave = async (ws: FakeSocket) => {
    ws.readyState = 3;
    await hub.webSocketClose(ws, 1001);
  };
  /** An owner-approved agent (the 30-day chat grant). */
  const agent = async (on: FakeSocket) => {
    const c = new FakeSocket();
    sockets.push(c);
    await hub.connectController(
      c,
      new URL("https://lianki.com/api/version/debug/control?label=agent"),
    );
    const pending = (
      on.sent.filter((m) => m.type === "state").at(-1) as { pending: { pair: string } }
    ).pending;
    await msg(on, { type: "allow", pair: pending.pair, scope: "chat" });
    return c;
  };
  const last = (ws: FakeSocket, type: string) => ws.sent.filter((m) => m.type === type).at(-1);
  /** The sink the agent set up earlier (`clips on --sink`), which a tap reuses. */
  storage.store.set("clipsink", {
    url: SINK,
    key: KEYS.write,
    origins: [CLIPS_ORIGIN, DEV_ORIGIN],
    at: 0,
  });
  return {
    hub,
    storage,
    page,
    msg,
    leave,
    agent,
    last,
    tick: (ms: number) => (t += ms),
    now: () => t,
  };
}

describe("clips rules (clips.ts)", () => {
  it("hands off only to the session's exact owner origins, in the query", () => {
    const tok = "t".repeat(32);
    const here = "https://lianki.com/words";
    const origins = [CLIPS_ORIGIN, DEV_ORIGIN];
    expect(handoffHref(`${DEV_ORIGIN}/words?x=1`, here, tok, origins)).toBe(
      `${DEV_ORIGIN}/words?x=1&${HANDOFF_PARAM}=${tok}`,
    );
    expect(handoffHref("/en/words", here, tok, origins)).toBeNull(); // same origin: sessionStorage carries it
    expect(handoffHref("https://example.com/", here, tok, origins)).toBeNull();
    // Another person's tailnet host, another port of the owner's, localhost: never the token.
    expect(handoffHref("https://someone.other.ts.net/", here, tok, origins)).toBeNull();
    expect(handoffHref("https://mac.example.ts.net/", here, tok, origins)).toBeNull();
    expect(handoffHref("http://localhost:3000/", here, tok, origins)).toBeNull();
    expect(handoffHref("https://lianki.com/", `${DEV_ORIGIN}/`, undefined, origins)).toBeNull();
    // Without a list: lianki.com only.
    expect(handoffHref(`${DEV_ORIGIN}/`, here, tok)).toBeNull();
    expect(
      ownerOrigins([DEV_ORIGIN, "https://x.ts.net/path", "*.ts.net", "http://plain.example", 7]),
    ).toEqual([CLIPS_ORIGIN, DEV_ORIGIN]);
  });

  it("takes the token out of the address", () => {
    const tok = "a".repeat(24);
    expect(takeHandoff(`https://lianki.com/words?list=x&${HANDOFF_PARAM}=${tok}#top`)).toEqual({
      token: tok,
      clean: "https://lianki.com/words?list=x#top",
    });
    expect(takeHandoff(`https://lianki.com/?${HANDOFF_PARAM}=bad`)?.token).toBe("");
    expect(takeHandoff("https://lianki.com/")).toBeNull();
  });

  it("parses page and agent messages, and refuses what is not one", () => {
    // A page never names the sink: only the agent's setup does.
    expect(parseClipsPageMessage({ type: "clips-on", minutes: 30.4, sink: SINK })).toEqual({
      type: "clips-on",
      minutes: 30,
    });
    expect(parseClipsControl({ type: "clips", op: "on", match: "x", sink: SINK }).ok).toBe(false);
    expect(
      parseClipsControl({ type: "clips", op: "on", match: "x", sink: SINK, sinkKey: "short" }).ok,
    ).toBe(false);
    expect(
      parseClipsControl({
        type: "clips",
        op: "on",
        match: "x",
        sink: SINK,
        sinkKey: KEYS.write,
        origins: [DEV_ORIGIN, "https://evil.ts.net/x"],
      }),
    ).toEqual({
      ok: true,
      value: {
        type: "clips",
        op: "on",
        match: "x",
        sink: SINK,
        sinkKey: KEYS.write,
        origins: [CLIPS_ORIGIN, DEV_ORIGIN],
      },
    });
    expect(parseClipsPageMessage({ type: "clips-vis", state: "asleep" })).toBeNull();
    expect(parseClipsControl({ type: "clips", op: "on" }).ok).toBe(false);
    expect(parseClipsControl({ type: "clips", op: "on", match: "x", minutes: 0 }).ok).toBe(false);
    expect(parseClipsControl({ type: "clips", op: "off" })).toEqual({
      ok: true,
      value: { type: "clips", op: "off" },
    });
    expect(
      matchesSession("android", { sid: "s", device: "d", labels: ["/words pwa Android"] }),
    ).toBe(true);
    expect(matchesSession("devi", { sid: "s", device: "device1", labels: [] })).toBe(true);
    expect(matchesSession("iphone", { sid: "s", device: "d", labels: ["/words Android"] })).toBe(
      false,
    );
  });

  it("the sink is the session's only: no origin key, and nothing while off", () => {
    expect(activeSink({ on: true, sink: SINK })).toBe(SINK);
    expect(activeSink({ on: false, sink: SINK })).toBeUndefined();
    expect(activeSink({ on: true })).toBeUndefined();
    expect(activeSink(null)).toBeUndefined();
  });
});

describe("the hub holds the window session (debug.ts)", () => {
  it("is off until turned on; the agent turns it on by a label match, with the sink", async () => {
    const s = setup();
    const p = await s.page({ ws: SID_A, dev: DEV_PHONE });
    expect(p.clips()).toMatchObject({ type: "clips", sid: SID_A, device: DEV_PHONE, on: false });
    expect([...s.storage.store.keys()].some((k) => k.startsWith("clips:"))).toBe(false);
    const c = await s.agent(p);
    const other = "https://other.example.ts.net/w";
    await s.msg(c, {
      type: "clips",
      op: "on",
      match: "android",
      sink: other,
      sinkKey: KEYS.write,
      origins: [DEV_ORIGIN],
    });
    expect(p.clips()).toMatchObject({
      on: true,
      sid: SID_A,
      sink: other,
      sinkKey: KEYS.write,
      origins: [CLIPS_ORIGIN, DEV_ORIGIN],
    });
    // The setup is kept for a later tap.
    expect(s.storage.store.get("clipsink")).toMatchObject({ url: other, key: KEYS.write });
    expect(p.clips()?.handoff).toMatch(/^[A-Za-z0-9_-]{20,64}$/);
    expect(p.clips()?.until).toBeUndefined(); // no auto-stop unless asked
    expect(s.last(c, "clips-done")).toMatchObject({ op: "on", sessions: [SID_A] });
    await s.msg(c, { type: "clips", op: "list" });
    expect(s.last(c, "clips-list")).toMatchObject({
      sessions: [{ sid: SID_A, device: DEV_PHONE, on: true, pages: ["/words pwa Android"] }],
    });
  });

  it("refuses an agent on with no open page matching, or with nowhere to keep clips", async () => {
    const s = setup();
    s.storage.store.delete("clipsink");
    const p = await s.page({ ws: SID_A, dev: DEV_PHONE });
    expect(p.clips()?.canStart).toBe(false);
    const c = await s.agent(p);
    await s.msg(c, { type: "clips", op: "on", match: "iphone", sink: SINK, sinkKey: KEYS.write });
    expect(String(s.last(c, "error")?.error)).toContain("no open owner page");
    await s.msg(c, { type: "clips", op: "on", match: "android" });
    expect(String(s.last(c, "error")?.error)).toContain("--sink");
    expect(p.clips()?.on).toBe(false);
    // Nor can a tap, with no sink set up.
    await s.msg(p, { type: "clips-on" });
    expect(p.clips()?.on).toBe(false);
  });

  it("follows the window to another origin with the one-time token, which then lapses", async () => {
    const s = setup();
    const p = await s.page({ ws: SID_A, dev: DEV_PHONE });
    await s.msg(p, { type: "clips-on" });
    const token = p.clips()?.handoff as string;
    // The page navigates to the dev origin: it closes, the new one arrives with the token.
    await s.msg(p, { type: "clips-vis", state: "leaving" });
    await s.leave(p);
    const dev = await s.page(
      { ws: SID_B, dev: DEV_MAC, hand: token },
      "/words Android",
      "https://taku.onca-tint.ts.net:8443",
    );
    expect(dev.clips()).toMatchObject({
      on: true,
      sid: SID_A,
      device: DEV_PHONE,
      sink: SINK,
      sinkKey: KEYS.write,
    });
    expect(dev.clips()?.handoff).not.toBe(token); // rotated
    // The old token is spent: another window with it starts its own, unrecorded session.
    const other = await s.page({ ws: "sessionCCCCCCCCCCCCC", dev: DEV_MAC, hand: token });
    expect(other.clips()).toMatchObject({ on: false, sid: "sessionCCCCCCCCCCCCC" });
  });

  it("a closed window ends after CLIPS_GONE_MS; a sleeping screen keeps it for hours and resumes", async () => {
    const s = setup();
    const p = await s.page({ ws: SID_A, dev: DEV_PHONE });
    await s.msg(p, { type: "clips-on" });
    await s.msg(p, { type: "clips-vis", state: "leaving" });
    await s.leave(p);
    s.tick(CLIPS_GONE_MS + 1);
    await s.hub.clipsSweep();
    expect(s.storage.store.has(`clips:${SID_A}`)).toBe(false);

    const q = await s.page({ ws: SID_B, dev: DEV_PHONE });
    await s.msg(q, { type: "clips-on" });
    await s.msg(q, { type: "clips-vis", state: "hidden" }); // screen off: the socket drops later
    await s.leave(q);
    s.tick(CLIPS_GONE_MS * 10);
    await s.hub.clipsSweep();
    expect(s.storage.store.has(`clips:${SID_B}`)).toBe(true);
    // The screen is back on: the same document reconnects and records again, with no tap.
    const back = await s.page({ ws: SID_B, dev: DEV_PHONE, cont: "1" });
    expect(back.clips()).toMatchObject({ on: true, sid: SID_B, paused: CLIPS_GONE_MS * 10 });
    await s.msg(back, { type: "clips-vis", state: "hidden" });
    await s.leave(back);
    s.tick(CLIPS_HIDDEN_MS + 1);
    await s.hub.clipsSweep();
    expect(s.storage.store.has(`clips:${SID_B}`)).toBe(false);
  });

  it("a tab closed while hidden, restored later, asks for a tap instead of resuming", async () => {
    const s = setup();
    const p = await s.page({ ws: SID_A, dev: DEV_PHONE });
    await s.msg(p, { type: "clips-on" });
    await s.msg(p, { type: "clips-vis", state: "hidden" });
    await s.leave(p); // closed while hidden: no "leaving" could be sent
    s.tick(CLIPS_GONE_MS * 30);
    // A new document with the same window id (tab restore), or one back from the bfcache: no cont.
    const restored = await s.page({ ws: SID_A, dev: DEV_PHONE });
    expect(restored.clips()).toMatchObject({ on: false, resumable: [{ sid: SID_A }] });
    expect(restored.clips()?.sinkKey).toBeUndefined();
    await s.msg(restored, { type: "clips-adopt", sid: SID_A });
    expect(restored.clips()).toMatchObject({ on: true, sid: SID_A });
  });

  it("a quick reload or navigation (not hidden) rejoins by itself", async () => {
    const s = setup();
    const p = await s.page({ ws: SID_A, dev: DEV_PHONE });
    await s.msg(p, { type: "clips-on" });
    await s.msg(p, { type: "clips-vis", state: "leaving" });
    await s.leave(p);
    s.tick(5_000);
    const again = await s.page({ ws: SID_A, dev: DEV_PHONE });
    expect(again.clips()).toMatchObject({ on: true, sid: SID_A });
  });

  it("an address typed by hand: this device continues; another device is only offered it", async () => {
    const s = setup();
    const p = await s.page({ ws: SID_A, dev: DEV_PHONE });
    await s.msg(p, { type: "clips-on" });
    await s.msg(p, { type: "clips-vis", state: "leaving" });
    const mac = await s.page({ ws: "sessionMMMMMMMMMMMMM", dev: DEV_MAC }, "/ Macintosh");
    expect(mac.clips()).toMatchObject({ on: false, resumable: [{ sid: SID_A }] });
    const same = await s.page({ ws: SID_B, dev: DEV_PHONE });
    expect(same.clips()).toMatchObject({ on: true, sid: SID_A });
    // Once it has a page again, a tap elsewhere cannot take it.
    await s.msg(mac, { type: "clips-adopt", sid: SID_A });
    expect(mac.clips()?.on).toBe(false);
  });

  it("Continue: a tap takes over a session that lost its page", async () => {
    const s = setup();
    const p = await s.page({ ws: SID_A, dev: DEV_PHONE });
    await s.msg(p, { type: "clips-on" });
    await s.msg(p, { type: "clips-vis", state: "leaving" });
    await s.leave(p);
    const mac = await s.page({ ws: "sessionMMMMMMMMMMMMM", dev: DEV_MAC });
    await s.msg(mac, { type: "clips-adopt", sid: SID_A });
    expect(mac.clips()).toMatchObject({ on: true, sid: SID_A, device: DEV_PHONE });
  });

  it("auto-stop only when asked: the hub stops it at the time, and Stop is one tap", async () => {
    const s = setup();
    const p = await s.page({ ws: SID_A, dev: DEV_PHONE });
    await s.msg(p, { type: "clips-on", minutes: 60 });
    expect(p.clips()).toMatchObject({ on: true, left: 60 * 60_000 });
    s.tick(60 * 60_000);
    await s.hub.alarm();
    expect(p.clips()?.on).toBe(false);
    expect(s.storage.store.has(`clips:${SID_A}`)).toBe(false);
    await s.msg(p, { type: "clips-on" });
    await s.msg(p, { type: "clips-off" });
    expect(p.clips()?.on).toBe(false);
  });

  it("a tap with nowhere to keep clips does not turn it on", async () => {
    const s = setup();
    s.storage.store.delete("clipsink");
    const p = await s.page({ ws: SID_A, dev: DEV_PHONE });
    await s.msg(p, { type: "clips-on" });
    expect(p.clips()?.on).toBe(false);
  });

  it("never reaches a friend's page", async () => {
    const s = setup();
    const ws = new FakeSocket();
    await s.hub.connectPage(
      ws,
      new URL(`https://lianki.com/api/version/debug?label=x&ws=${SID_A}&dev=${DEV_PHONE}`),
      { userId: "f1", email: "f@x.com", owner: false },
    );
    expect(ws.clips()).toBeUndefined();
  });
});

describe("the page's stores (clips-store.ts)", () => {
  it("knocks with its window and device ids, and takes a handoff out of the address", () => {
    let replaced = "";
    const tok = "h".repeat(24);
    const q = clipsConnectQuery(
      { href: `https://lianki.com/words?${HANDOFF_PARAM}=${tok}` },
      (u) => {
        replaced = u;
      },
    );
    const p = new URLSearchParams(q.slice(1));
    expect(p.get("ws")).toBe(clipsLive().getState().sid);
    expect(p.get("dev")).toBe(clipsDevice().getState().device);
    expect(p.get("hand")).toBe(tok);
    expect(replaced).toBe("https://lianki.com/words");
  });

  it("takes the session and device the hub names; a fresh recording counts from 0", () => {
    onClipsState(
      { type: "clips", sid: SID_A, device: DEV_PHONE, on: true, since: 1, left: 1000 },
      5000,
    );
    expect(clipsLive().getState()).toMatchObject({ sid: SID_A, deadline: 6000, saved: 0 });
    expect(clipsDevice().getState().device).toBe(DEV_PHONE);
    clipPosted({ ok: true }, SINK);
    clipPosted({ ok: true }, SINK);
    expect(clipsLive().getState()).toMatchObject({ saved: 2, failing: false });
    // The deadline passes on this page: it stops here at once.
    expect(clipsExpired(6000)).toBe(true);
    expect(clipsLive().getState().hub?.on).toBe(false);
  });

  it("a failed post shows on the badge and is logged without the audio or the words", () => {
    onClipsState({ type: "clips", sid: SID_A, device: DEV_PHONE, on: true, since: 2 });
    const logs: Record<string, unknown>[] = [];
    clipPosted({ ok: false, status: 502, error: "sink 502" }, SINK, (e) => logs.push(e));
    expect(clipsLive().getState()).toMatchObject({ failing: true, failed: 1 });
    expect(logs).toEqual([
      { ev: "clip-post-failed", host: "mac.example.ts.net", status: 502, error: "sink 502" },
    ]);
    clipPosted({ ok: true }, SINK);
    expect(clipsLive().getState().failing).toBe(false);
  });

  it("holds a screen wake lock only while recording, and asks again when visible", async () => {
    const doc = new EventTarget() as EventTarget & { visibilityState: string };
    doc.visibilityState = "visible";
    const released: number[] = [];
    const listeners: (() => void)[] = [];
    let asked = 0;
    const nav = {
      wakeLock: {
        request: async () => {
          asked++;
          const id = asked;
          return {
            release: async () => void released.push(id),
            addEventListener: (_t: "release", f: () => void) => void listeners.push(f),
          };
        },
      },
    };
    onClipsState({ type: "clips", sid: SID_A, device: DEV_PHONE, on: true, since: 3 });
    const stop = holdWakeLock(nav, doc as never);
    await Promise.resolve();
    await Promise.resolve();
    expect([asked, clipsLive().getState().wake]).toEqual([1, "held"]);
    // The system drops it as the page hides; back on screen, it is asked again.
    doc.visibilityState = "hidden";
    listeners[0]();
    doc.visibilityState = "visible";
    doc.dispatchEvent(new Event("visibilitychange"));
    await Promise.resolve();
    await Promise.resolve();
    expect(asked).toBe(2);
    onClipsState({ type: "clips", sid: SID_A, device: DEV_PHONE, on: false });
    expect(released).toEqual([2]);
    expect(clipsLive().getState().wake).toBe("off");
    stop();
    const none = holdWakeLock({}, doc as never);
    onClipsState({ type: "clips", sid: SID_A, device: DEV_PHONE, on: true, since: 4 });
    expect(clipsLive().getState().wake).toBe("unsupported");
    none();
  });
});

describe("the page's taps and the sink a tap offers", () => {
  it("a tap goes through DebugEval's socket, and is refused with none", () => {
    const sent: unknown[] = [];
    setClipsSender((m) => {
      sent.push(m);
      return true;
    });
    expect(clipsAction({ type: "clips-off" })).toBe(true);
    setClipsSender(null);
    expect(clipsAction({ type: "clips-off" })).toBe(false);
    expect(sent).toEqual([{ type: "clips-off" }]);
  });

  it("Stop stops here at once, with the hub unreachable, and stays stopped", async () => {
    onClipsState({
      type: "clips",
      sid: SID_A,
      device: DEV_PHONE,
      on: true,
      since: 100,
      sink: SINK,
      sinkKey: KEYS.write,
    });
    let posts = 0;
    const post = async (key: string | undefined) => {
      posts++;
      expect(key).toBe(KEYS.write);
      return { ok: true as const };
    };
    await postSessionClip(SINK, post);
    expect(posts).toBe(1);
    // The socket is down: the tap cannot reach the hub, but recording is off here now.
    setClipsSender(null);
    expect(clipsAction({ type: "clips-off" })).toBe(false);
    expect(clipsLive().getState()).toMatchObject({ stopPending: true, stoppedSince: 100 });
    expect(clipsLive().getState().hub?.on).toBe(false);
    await postSessionClip(SINK, post); // an utterance after Stop: not posted
    expect(posts).toBe(1);
    // Reconnect: the Stop is sent again at once.
    const sent: unknown[] = [];
    setClipsSender((m) => {
      sent.push(m);
      return true;
    });
    expect(sent).toEqual([{ type: "clips-off" }]);
    // The hub, not yet told, still says this recording is on: it stays off and is told again.
    onClipsState({
      type: "clips",
      sid: SID_A,
      device: DEV_PHONE,
      on: true,
      since: 100,
      sink: SINK,
    });
    expect(clipsLive().getState().hub?.on).toBe(false);
    expect(sent).toEqual([{ type: "clips-off" }, { type: "clips-off" }]);
    await postSessionClip(SINK, post);
    expect(posts).toBe(1);
    // The hub confirms: done. A new recording (a new tap, or the agent) is on again.
    onClipsState({ type: "clips", sid: SID_A, device: DEV_PHONE, on: false });
    expect(clipsLive().getState().stopPending).toBe(false);
    onClipsState({
      type: "clips",
      sid: SID_A,
      device: DEV_PHONE,
      on: true,
      since: 200,
      sink: SINK,
    });
    expect(clipsLive().getState().hub?.on).toBe(true);
    setClipsSender(null);
  });

  it("the same document coming back says so (cont=1); one that went through pagehide does not", () => {
    onClipsState({ type: "clips", sid: SID_A, device: DEV_PHONE, on: true, since: 300 });
    const q1 = new URLSearchParams(clipsConnectQuery({ href: "https://lianki.com/" }, () => {}));
    expect(q1.get("cont")).toBe("1");
    clipsDeparted();
    clipsRestored(); // back from the bfcache: nothing is posted until the hub says again
    expect(clipsLive().getState().hub?.on).toBe(false);
    onClipsState({ type: "clips", sid: SID_A, device: DEV_PHONE, on: true, since: 300 });
    const q2 = new URLSearchParams(clipsConnectQuery({ href: "https://lianki.com/" }, () => {}));
    expect(q2.get("cont")).toBeNull();
  });

  it("a wake lock that is refused says so; one granted after Stop is let go", async () => {
    const doc = new EventTarget() as EventTarget & { visibilityState: string };
    doc.visibilityState = "visible";
    const tick = async () => {
      for (let i = 0; i < 4; i++) await Promise.resolve();
    };
    onClipsState({ type: "clips", sid: SID_A, device: DEV_PHONE, on: true, since: 10 });
    const stop1 = holdWakeLock(
      { wakeLock: { request: () => Promise.reject(new Error("NotAllowedError")) } },
      doc as never,
    );
    await tick();
    expect(clipsLive().getState().wake).toBe("failed");
    stop1();
    // Granted only after recording was stopped: released at once (a refusal to release is no error).
    let grant!: (l: { release(): Promise<void> }) => void;
    let released = 0;
    const stop2 = holdWakeLock(
      { wakeLock: { request: () => new Promise((r) => (grant = r)) } },
      doc as never,
    );
    onClipsState({ type: "clips", sid: SID_A, device: DEV_PHONE, on: false });
    grant({
      release: () => {
        released++;
        return Promise.reject(new Error("already released"));
      },
    });
    await tick();
    expect(released).toBe(1);
    stop2();
  });
});

describe("the clip upload is a side path (mic.ts sideClip)", () => {
  /** The shape of MicButton's upload: the STT answer, then the clip. */
  const upload = async (stt: () => Promise<string>, post: () => Promise<unknown>) => {
    const text = await stt();
    sideClip(post);
    return text;
  };

  it("the transcript is back before the clip's POST even starts, and a slow sink adds nothing", async () => {
    const order: string[] = [];
    let release!: () => void;
    const hung = new Promise<void>((r) => (release = r));
    const t0 = performance.now();
    const text = await upload(
      async () => "你好",
      () => {
        order.push("post");
        return hung; // a sink that never answers
      },
    );
    order.push("text");
    const ms = performance.now() - t0;
    expect(text).toBe("你好");
    expect(order).toEqual(["text"]); // not even started yet
    expect(ms).toBeLessThan(20);
    await new Promise((r) => setTimeout(r, 5));
    expect(order).toEqual(["text", "post"]);
    release();
  });

  it("measured: 20 utterances with a 200 ms sink take no longer than with no sink", async () => {
    const stt = () => new Promise<string>((r) => setTimeout(() => r("x"), 2));
    const slowSink = () => new Promise<void>((r) => setTimeout(r, 200));
    const run = async (post?: () => Promise<unknown>) => {
      const t0 = performance.now();
      for (let i = 0; i < 20; i++) await (post ? upload(stt, post) : stt());
      return performance.now() - t0;
    };
    const without = await run();
    const withSink = await run(slowSink);
    // 20 × 200 ms would be 4 s if the sink were on the path.
    expect(withSink).toBeLessThan(without + 100);
  });

  it("postClip never rejects: it resolves to what the sink said", async () => {
    const wav = new Uint8Array(8);
    const meta = { at: 0, durationMs: 1, label: "" };
    const ok = await postClip(SINK, wav, meta, (async () =>
      Response.json({ name: "c1" })) as unknown as typeof fetch);
    expect(ok).toEqual({ ok: true, name: "c1" });
    const bad = await postClip(
      SINK,
      wav,
      meta,
      (async () => new Response("", { status: 403 })) as unknown as typeof fetch,
    );
    expect(bad).toEqual({ ok: false, status: 403, error: "sink 403" });
    const down = await postClip(SINK, wav, meta, (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch);
    expect(down).toEqual({ ok: false, error: "Failed to fetch" });
  });
});

describe("the sink takes the owner's origins (clip-sink.ts)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const post = (dir: string, origin: string, allowed: string[], key = KEYS.write) => {
    const form = new FormData();
    form.append("audio", new Blob([new Uint8Array([1, 2])], { type: "audio/wav" }), "a.wav");
    form.append(
      "meta",
      JSON.stringify({ mime: "audio/wav", durationMs: 1, label: "", transcript: "" }),
    );
    return handleClips(
      new Request("http://localhost/clips", {
        method: "POST",
        body: form,
        headers: { origin, authorization: `Bearer ${key}` },
      }),
      dir,
      () => new Date("2026-10-31T09:00:00Z"),
      allowed,
      KEYS,
    );
  };
  const get = (dir: string, path: string, headers: Record<string, string> = {}) =>
    handleClips(
      new Request(`http://localhost${path}`, { headers }),
      dir,
      undefined,
      [CLIPS_ORIGIN],
      KEYS,
    );

  it("reading needs the read key, writing the write key: an allowed origin alone is not enough", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clips-"));
    dirs.push(dir);
    // Another account's page on lianki.com, or a client with no Origin, has no key.
    expect((await post(dir, CLIPS_ORIGIN, [CLIPS_ORIGIN], ""))!.status).toBe(401);
    expect((await post(dir, CLIPS_ORIGIN, [CLIPS_ORIGIN], KEYS.read))!.status).toBe(401);
    expect((await post(dir, CLIPS_ORIGIN, [CLIPS_ORIGIN]))!.status).toBe(200);
    expect((await get(dir, "/clips/index.json"))!.status).toBe(401);
    expect((await get(dir, "/clips/index.json", { origin: CLIPS_ORIGIN }))!.status).toBe(401);
    expect(
      (await get(dir, "/clips/index.json", { authorization: `Bearer ${KEYS.write}` }))!.status,
    ).toBe(401);
    const ok = (await get(dir, "/clips/index.json", { authorization: `Bearer ${KEYS.read}` }))!;
    expect(ok.status).toBe(200);
    const { clips } = (await ok.json()) as { clips: { file: string }[] };
    expect((await get(dir, `/clips/${clips[0].file}`))!.status).toBe(401);
    expect(
      (await get(dir, `/clips/${clips[0].file}`, { authorization: `Bearer ${KEYS.read}` }))!.status,
    ).toBe(200);
  });

  it("makes its keys once, 0600, and reads them back", () => {
    const dir = mkdtempSync(join(tmpdir(), "keys-"));
    dirs.push(dir);
    const file = join(dir, "k.json");
    const a = sinkKeys(file);
    expect(a.read).not.toBe(a.write);
    expect(sinkKeys(file)).toEqual(a);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("lianki.com by default; listed exact https origins too; nothing else", async () => {
    expect(clipsOrigins({})).toEqual([CLIPS_ORIGIN]);
    const allowed = clipsOrigins({
      LIANKI_DEV_ORIGINS: "https://taku.onca-tint.ts.net:8443",
      LIANKI_CLIPS_ORIGINS:
        "https://taku.onca-tint.ts.net, http://plain.example, https://x.ts.net/path, *",
    });
    expect(allowed).toEqual([
      CLIPS_ORIGIN,
      "https://taku.onca-tint.ts.net:8443",
      "https://taku.onca-tint.ts.net",
    ]);
    const dir = mkdtempSync(join(tmpdir(), "clips-"));
    dirs.push(dir);
    const r = (await post(dir, "https://taku.onca-tint.ts.net:8443", allowed))!;
    expect(r.status).toBe(200);
    expect(r.headers.get("access-control-allow-origin")).toBe("https://taku.onca-tint.ts.net:8443");
    expect((await post(dir, "https://evil.ts.net", allowed))!.status).toBe(403);
  });

  it("never deletes a clip: there is no route for it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clips-"));
    dirs.push(dir);
    await post(dir, CLIPS_ORIGIN, [CLIPS_ORIGIN]);
    const before = readdirSync(dir).sort();
    const name = before.find((f) => f.endsWith(".wav"))!;
    const del = await handleClips(
      new Request(`http://localhost/clips/${name}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${KEYS.read}` },
      }),
      dir,
      undefined,
      [CLIPS_ORIGIN],
      KEYS,
    );
    expect(del!.status).toBe(405);
    expect(readdirSync(dir).sort()).toEqual(before);
  });
});
