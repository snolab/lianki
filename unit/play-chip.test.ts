// The ▶ chip on a chat line with audio (packages/debug-chat/src/PlayChip.tsx;
// docs/li-sound-hub.md, "Playing audio from an agent"): what it shows for
// each state of Li's player, and that its buttons drive the player. A fake
// player and happy-dom: nothing plays.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { PlayChip, playNote } from "@lianki/debug-chat/PlayChip";
import { chatExtra, CHAT_LOCALES, EXTRA } from "@lianki/debug-chat/chat-ui-locales";
import type { LiPlayer, PlayView } from "@lianki/debug-chat/li-player";
import type { LineAudio } from "@lianki/debug-chat/play-audio";

const FILE: LineAudio = { src: "https://cdn.example.com/a.mp3", kind: "file", title: "Lesson 3" };
const LIVE: LineAudio = { src: "https://ice.example.com/stream", kind: "stream" };
const IDLE: PlayView = { id: null, status: "idle", pos: 0, dur: NaN, live: false };

/** A player whose view the test sets; it records what the chip asked. */
function fake(v: PlayView = IDLE) {
  const subs = new Set<(v: PlayView) => void>();
  const calls: string[] = [];
  let view = v;
  const p = {
    view: () => view,
    subscribe: (f: (v: PlayView) => void) => (subs.add(f), () => void subs.delete(f)),
    toggle: async (id: string) => (calls.push(`toggle ${id}`), view),
    stop: () => void calls.push("stop"),
  } as unknown as LiPlayer;
  const set = (next: PlayView) => {
    view = next;
    for (const f of subs) f(next);
  };
  return { p, calls, set, subs };
}

const html = (v: PlayView, audio = FILE, id = "m1") =>
  renderToString(createElement(PlayChip, { id, audio, player: fake(v).p }));

describe("what the chip shows", () => {
  it("idle: ▶, the title, a progress bar for a file", () => {
    const h = html(IDLE);
    expect(h).toContain('data-play-status="idle"');
    expect(h).toContain("▶");
    expect(h).toContain("Lesson 3");
    expect(h).toContain('role="progressbar"');
    expect(h).not.toContain("debug-chat-play-stop");
  });

  it("a stream: the live badge, no bar; no title: the word for audio", () => {
    const h = html(IDLE, LIVE);
    expect(h).toContain("debug-chat-play-live");
    expect(h).toContain(chatExtra().playLive);
    expect(h).toContain(chatExtra().playAudio);
    expect(h).not.toContain('role="progressbar"');
  });

  it("playing: ⏸, stop, the progress and the time", () => {
    const h = html({ id: "m1", status: "playing", pos: 65, dur: 130, live: false });
    expect(h).toContain("⏸");
    expect(h).toContain("debug-chat-play-stop");
    expect(h).toContain('aria-valuenow="50"');
    expect(h).toContain("1:05");
  });

  it("another line's state is not this chip's", () => {
    expect(html({ id: "other", status: "playing", pos: 1, dur: 2, live: false })).toContain(
      'data-play-status="idle"',
    );
  });

  it("each reason in words, never silence", () => {
    const x = chatExtra();
    expect(html({ ...IDLE, id: "m1", status: "blocked", why: "locked" })).toContain(x.playTap);
    expect(html({ ...IDLE, id: "m1", status: "paused", why: "mic" })).toContain(x.playMicOn);
    expect(html({ ...IDLE, id: "m1", status: "waiting" })).toContain(x.playWaiting);
    expect(html({ ...IDLE, id: "m1", status: "error", why: "load" })).toContain(
      x.playFailed.replace("'", "&#x27;"),
    );
    expect(html({ ...IDLE, id: "m1", status: "error", why: "hls" })).toContain(
      x.playNoStream.replace("'", "&#x27;"),
    );
    expect(playNote({ ...IDLE, status: "error", why: "unsupported" }, x)).toBe(x.playNoStream);
    expect(playNote({ ...IDLE, status: "playing" }, x)).toBeNull();
  });

  it("no player (SSR): an idle chip", () => {
    expect(
      renderToString(createElement(PlayChip, { id: "m1", audio: FILE, player: null })),
    ).toContain('data-play-status="idle"');
  });

  it("every string in all 16 locales", () => {
    for (const l of CHAT_LOCALES)
      for (const k of [
        "playAudio",
        "playPlay",
        "playPause",
        "playStop",
        "playLive",
        "playTap",
        "playMicOn",
        "playWaiting",
        "playFailed",
        "playNoStream",
      ] as const)
        expect(EXTRA[l][k]?.length).toBeGreaterThan(0);
  });
});

describe("the buttons drive the player", () => {
  const win = new Window({ url: "https://lianki.com/" });
  const g = globalThis as Record<string, unknown>;
  const saved: Record<string, unknown> = {};
  beforeAll(() => {
    for (const k of ["window", "document", "navigator", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"])
      saved[k] = g[k];
    g.window = win;
    g.document = win.document;
    g.HTMLElement = win.HTMLElement;
    g.IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) g[k] = v;
  });

  it("▶ toggles, ⏹ stops, the tap note plays; a press keeps the focus", async () => {
    const f = fake();
    const box = win.document.createElement("div");
    win.document.body.appendChild(box);
    const root = createRoot(box as unknown as Element);
    await act(async () =>
      root.render(createElement(PlayChip, { id: "m1", audio: FILE, player: f.p })),
    );
    const q = (id: string) => box.querySelector(`[data-testid="${id}"]`) as unknown as HTMLElement;
    const down = (el: HTMLElement) => {
      const e = new win.MouseEvent("mousedown", { bubbles: true, cancelable: true });
      el.dispatchEvent(e as unknown as Event);
      return e.defaultPrevented;
    };
    expect(down(q("debug-chat-play-toggle"))).toBe(true);
    await act(async () => q("debug-chat-play-toggle").click());
    expect(f.calls).toEqual(["toggle m1"]);
    await act(async () => f.set({ id: "m1", status: "playing", pos: 1, dur: 10, live: false }));
    expect(q("debug-chat-play").getAttribute("data-play-status")).toBe("playing");
    expect(down(q("debug-chat-play-stop"))).toBe(true);
    await act(async () => q("debug-chat-play-stop").click());
    expect(f.calls.at(-1)).toBe("stop");
    await act(async () => f.set({ ...IDLE, id: "m1", status: "blocked", why: "locked" }));
    expect(down(q("debug-chat-play-note"))).toBe(true);
    await act(async () => q("debug-chat-play-note").click());
    expect(f.calls.at(-1)).toBe("toggle m1");
    await act(async () => f.set({ ...IDLE, id: "m1", status: "waiting" }));
    await act(async () => q("debug-chat-play-note").click());
    expect(f.calls.length).toBe(3);
    await act(async () => root.unmount());
    expect(f.subs.size).toBe(0);
  });
});
