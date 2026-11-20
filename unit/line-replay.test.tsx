// "Play original audio" in a spoken line's details (packages/debug-chat/src/
// line-replay.ts, LineReplay.tsx, MessageDetails.tsx; docs/recordings.md,
// "Replay from the chat"): which clip belongs to a line, what the chip plays,
// and that nothing shows without one. Fake fetch, fake player, happy-dom:
// nothing plays, no audio element is made.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { globalDescriptor, restoreGlobal } from "./support/globals";
import { Window } from "happy-dom";
import { act, createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import {
  REPLAY_LOOKUP_LIMIT,
  clipLineAudio,
  findLineClips,
  replayTitle,
  replayWindows,
  replayable,
  windowOf,
} from "@lianki/debug-chat/line-replay";
import { LineReplay } from "@lianki/debug-chat/LineReplay";
import { useMessageDetails } from "@lianki/debug-chat/MessageDetails";
import { CHAT_LOCALES, EXTRA } from "@lianki/debug-chat/chat-ui-locales";
import { LI_PLAY_KEY, LI_PLAY_V, type LiPlayer, type PlayView } from "@lianki/debug-chat/li-player";
import type { LineAudio } from "@lianki/debug-chat/play-audio";
import { UI_EN } from "@lianki/debug-chat/ui-strings";
import type { ChatMessage } from "@lianki/debug-chat/wire";
import { FLAGS } from "@/lib/flags";

const T = { t_speechEnd: 1_000, t_uploadStart: 1_040 };
const LINE: ChatMessage = {
  id: "line1",
  from: "owner",
  label: "",
  text: "hello",
  at: 2_000,
  source: "stt",
  timing: T,
};

type Call = { url: string; init?: RequestInit };
/** A fetch answering the feed from `clips`, by `before` and `limit`, as the route does. */
function feed(clips: { id: string; at: number }[], status = 200) {
  const calls: Call[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const q = new URL(url, "https://lianki.com").searchParams;
    const before = Number(q.get("before"));
    const limit = Number(q.get("limit"));
    const rows = clips
      .filter((c) => c.at < before)
      .sort((a, b) => b.at - a.at)
      .slice(0, limit);
    return new Response(JSON.stringify({ clips: rows, more: false }), { status });
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe("which clip is the line's", () => {
  it("only his own spoken lines", () => {
    expect(replayable(LINE)).toBe(true);
    expect(replayable({ ...LINE, from: "agent" })).toBe(false);
    expect(replayable({ ...LINE, from: "friend" })).toBe(false);
    expect(replayable({ ...LINE, source: undefined })).toBe(false);
    expect(replayable({ ...LINE, removed: true })).toBe(false);
  });

  it("a window from t_speechEnd to t_uploadStart, or none", () => {
    expect(windowOf(T)).toEqual({ from: 1_000, to: 1_040 });
    expect(windowOf(undefined)).toBeNull();
    expect(windowOf({ t_uploadStart: 5 })).toBeNull();
    expect(windowOf({ t_speechEnd: 5 })).toBeNull();
    expect(windowOf({ t_speechEnd: 5, t_uploadStart: 4 })).toBeNull();
    expect(windowOf({ t_speechEnd: Number.NaN, t_uploadStart: 4 })).toBeNull();
  });

  it("a merged line: one window per part; else the line's own", () => {
    expect(replayWindows(LINE)).toEqual([{ from: 1_000, to: 1_040 }]);
    expect(
      replayWindows({
        timing: T,
        parts: [
          { id: "a", text: "a", at: 1, timing: { t_speechEnd: 10, t_uploadStart: 12 } },
          { id: "b", text: "b", at: 2 },
          { id: "c", text: "c", at: 3, timing: { t_speechEnd: 30, t_uploadStart: 31 } },
        ],
      }),
    ).toEqual([
      { from: 10, to: 12 },
      { from: 30, to: 31 },
    ]);
    expect(replayWindows({ parts: [], timing: undefined })).toEqual([]);
  });

  it("asks the feed just past the window, own session, and takes the clip inside it", async () => {
    const { f, calls } = feed([
      { id: "after", at: 1_050 },
      { id: "mine", at: 1_020 },
      { id: "before", at: 990 },
    ]);
    expect(await findLineClips(LINE, f)).toEqual(["mine"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`/api/my/recordings?before=1041&limit=${REPLAY_LOOKUP_LIMIT}`);
    expect(calls[0]!.init?.credentials).toBe("same-origin");
  });

  it("the window's edges count", async () => {
    expect(await findLineClips(LINE, feed([{ id: "end", at: 1_040 }]).f)).toEqual(["end"]);
    expect(await findLineClips(LINE, feed([{ id: "start", at: 1_000 }]).f)).toEqual(["start"]);
  });

  it("no clip in the window, or none at all: nothing", async () => {
    expect(await findLineClips(LINE, feed([{ id: "old", at: 500 }]).f)).toEqual([]);
    expect(await findLineClips(LINE, feed([]).f)).toEqual([]);
  });

  it("each part looks itself up; one clip twice is listed once", async () => {
    const parts: ChatMessage["parts"] = [
      { id: "a", text: "a", at: 1, timing: { t_speechEnd: 100, t_uploadStart: 110 } },
      { id: "b", text: "b", at: 2, timing: { t_speechEnd: 200, t_uploadStart: 210 } },
      { id: "c", text: "c", at: 3, timing: { t_speechEnd: 205, t_uploadStart: 215 } },
    ];
    const { f, calls } = feed([
      { id: "p1", at: 105 },
      { id: "p2", at: 207 },
    ]);
    expect(await findLineClips({ ...LINE, parts }, f)).toEqual(["p1", "p2"]);
    expect(calls).toHaveLength(3);
  });

  it("recordings off (404, 401, 403): null; not his line: no request", async () => {
    for (const s of [404, 401, 403]) expect(await findLineClips(LINE, feed([], s).f)).toBeNull();
    const { f, calls } = feed([{ id: "x", at: 1_020 }]);
    expect(await findLineClips({ ...LINE, from: "agent" }, f)).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("a failed or odd answer skips that window", async () => {
    const parts: ChatMessage["parts"] = [
      { id: "a", text: "a", at: 1, timing: { t_speechEnd: 100, t_uploadStart: 110 } },
      { id: "b", text: "b", at: 2, timing: { t_speechEnd: 200, t_uploadStart: 210 } },
      { id: "c", text: "c", at: 3, timing: { t_speechEnd: 300, t_uploadStart: 310 } },
      { id: "d", text: "d", at: 4, timing: { t_speechEnd: 400, t_uploadStart: 410 } },
    ];
    let n = 0;
    const f = (async () => {
      n++;
      if (n === 1) throw new Error("offline");
      if (n === 2) return new Response("{}", { status: 500 });
      if (n === 3) return new Response("not json", { status: 200 });
      return new Response(
        JSON.stringify({
          clips: [
            { id: 7, at: 405 },
            { id: "bad-at", at: "405" },
            { id: "ok", at: 405 },
          ],
        }),
      );
    }) as unknown as typeof fetch;
    expect(await findLineClips({ ...LINE, parts }, f)).toEqual(["ok"]);
    expect(n).toBe(4);
  });

  it("the clip as line audio: his own WAV, a file", () => {
    expect(clipLineAudio("a/b", "Play")).toEqual({
      src: "/api/my/recordings?clip=a%2Fb",
      kind: "file",
      mime: "audio/wav",
      title: "Play",
    });
    expect(clipLineAudio("id1", "Play", "https://lianki.com").src).toBe(
      "https://lianki.com/api/my/recordings?clip=id1",
    );
  });

  it("numbered titles only for several clips", () => {
    expect(replayTitle("Play original audio", 0, 1)).toBe("Play original audio");
    expect(replayTitle("Play original audio", 1, 3)).toBe("Play original audio 2/3");
  });

  it("the words in all 16 locales; the flag ships on, for the owner", () => {
    for (const l of CHAT_LOCALES) expect(EXTRA[l].lineReplay?.length).toBeGreaterThan(0);
    const flag = (FLAGS as Record<string, { default: boolean; audience?: string }>)[
      "chat.line-replay"
    ];
    expect(flag?.default).toBe(true);
    expect(flag?.audience).toBe("owner");
  });
});

/** A player whose view the test sets; it records what the chip asked. */
function fakePlayer() {
  const calls: { id: string; audio: LineAudio }[] = [];
  const view: PlayView = { id: null, status: "idle", pos: 0, dur: NaN, live: false };
  const p = {
    v: LI_PLAY_V,
    view: () => view,
    subscribe: () => () => {},
    toggle: async (id: string, audio: LineAudio) => (calls.push({ id, audio }), view),
    stop: () => {},
  } as unknown as LiPlayer;
  return { p, calls };
}

describe("the row in the details", () => {
  const win = new Window({ url: "https://lianki.com/en" });
  const g = globalThis as Record<string, unknown>;
  const keys = [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "IS_REACT_ACT_ENVIRONMENT",
    "fetch",
    "location",
    "innerWidth",
    "innerHeight",
    LI_PLAY_KEY,
  ];
  const saved = Object.fromEntries(keys.map((k) => [k, globalDescriptor(k)]));
  beforeAll(() => {
    g.window = win;
    g.document = win.document;
    g.HTMLElement = win.HTMLElement;
    g.location = win.location;
    g.innerWidth = 400;
    g.innerHeight = 800;
    g.IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterAll(() => {
    for (const [k, d] of Object.entries(saved)) restoreGlobal(k, d);
  });

  const mount = async (el: ReturnType<typeof createElement>) => {
    const box = win.document.createElement("div");
    win.document.body.appendChild(box);
    const root = createRoot(box as unknown as Element);
    await act(async () => root.render(el));
    // The lookup settles.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    return { box, root };
  };
  const words = EXTRA.en.lineReplay;

  it("a clip: Li's ▶ chip, titled; a tap plays his clip through the player", async () => {
    const { p, calls } = fakePlayer();
    const { box, root } = await mount(
      createElement(LineReplay, {
        message: LINE,
        words,
        player: p,
        fetchImpl: feed([{ id: "clip1", at: 1_010 }]).f,
      }),
    );
    expect(box.querySelector('[data-testid="debug-chat-line-replay"]')).not.toBeNull();
    expect(box.textContent).toContain(words);
    const toggle = box.querySelector(
      '[data-testid="debug-chat-play-toggle"]',
    ) as unknown as HTMLElement;
    await act(async () => toggle.click());
    expect(calls).toHaveLength(1);
    expect(calls[0]!.id).toBe("replay:line1:clip1");
    expect(calls[0]!.audio.src).toBe("https://lianki.com/api/my/recordings?clip=clip1");
    expect(calls[0]!.audio.kind).toBe("file");
    await act(async () => root.unmount());
  });

  it("no clip, recordings off, or not his line: nothing at all", async () => {
    for (const [message, f] of [
      [LINE, feed([]).f],
      [LINE, feed([], 404).f],
      [{ ...LINE, from: "agent" as const }, feed([{ id: "x", at: 1_010 }]).f],
    ] as const) {
      const { box, root } = await mount(
        createElement(LineReplay, { message, words, player: null, fetchImpl: f }),
      );
      expect(box.innerHTML).toBe("");
      await act(async () => root.unmount());
    }
  });

  it("closed before the answer: nothing is set afterwards", async () => {
    let answer: (r: Response) => void = () => {};
    const f = (() => new Promise<Response>((r) => (answer = r))) as unknown as typeof fetch;
    const box = win.document.createElement("div");
    const root = createRoot(box as unknown as Element);
    await act(async () =>
      root.render(createElement(LineReplay, { message: LINE, words, player: null, fetchImpl: f })),
    );
    await act(async () => root.unmount());
    answer(new Response(JSON.stringify({ clips: [{ id: "late", at: 1_010 }] })));
    await new Promise((r) => setTimeout(r, 0));
    expect(box.innerHTML).toBe("");
  });

  it("by default: the page's fetch and the page's one player", async () => {
    const { p, calls } = fakePlayer();
    g[LI_PLAY_KEY] = p;
    const { f, calls: asked } = feed([{ id: "dflt", at: 1_030 }]);
    g.fetch = f;
    const { box, root } = await mount(createElement(LineReplay, { message: LINE, words }));
    expect(asked).toHaveLength(1);
    const toggle = box.querySelector(
      '[data-testid="debug-chat-play-toggle"]',
    ) as unknown as HTMLElement;
    await act(async () => toggle.click());
    expect(calls[0]!.id).toBe("replay:line1:dflt");
    await act(async () => root.unmount());
  });

  it("no fetch on the page: nothing, and no error", async () => {
    g.fetch = undefined;
    const { box, root } = await mount(
      createElement(LineReplay, { message: LINE, words, player: null }),
    );
    expect(box.innerHTML).toBe("");
    await act(async () => root.unmount());
  });

  it("in the message details only with `replay`", async () => {
    const proto = win.HTMLElement.prototype as unknown as Record<string, unknown>;
    const hadShow = proto.showPopover;
    proto.showPopover = function () {};
    const { p } = fakePlayer();
    g[LI_PLAY_KEY] = p;
    g.fetch = feed([{ id: "inpop", at: 1_020 }]).f;
    const Probe = ({ replay }: { replay: boolean }) => {
      const d = useMessageDetails("Details", undefined, UI_EN, EXTRA.en, replay);
      useEffect(() => {
        d.openVoice(LINE, "me", new win.DOMRect(0, 0, 10, 10) as unknown as DOMRect);
        // Open once.
        // oxlint-disable-next-line react-hooks/exhaustive-deps
      }, []);
      return d.popup || null;
    };
    for (const replay of [true, false]) {
      const { root } = await mount(createElement(Probe, { replay }));
      const row = win.document.body.querySelector('[data-testid="debug-chat-line-replay"]');
      if (replay) expect(row?.textContent).toContain(words);
      else expect(row).toBeNull();
      await act(async () => root.unmount());
    }
    proto.showPopover = hadShow;
  });
});
