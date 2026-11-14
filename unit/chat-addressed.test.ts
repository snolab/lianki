/**
 * Who the owner called (packages/debug-chat/src/addressed.ts): the addressed
 * lanes of a line (the route lanes of lane-route.ts mapped to chat lanes),
 * the once-per-utterance flash, and the marks drawn after an owner line
 * (LaneMark.tsx).
 */
import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ADDRESSED_CSS,
  FLASH_ATTR,
  FLASH_MS,
  ROUTE_TO_LANE,
  UTTERANCE_GAP_MS,
  addressedLanes,
  createAddressFlash,
  flashProps,
  latestOfLane,
  ringOf,
} from "@lianki/debug-chat/addressed";
import { AddressedMarks, LaneTag, laneAvatar } from "@lianki/debug-chat/LaneMark";
import { EXTRA } from "@lianki/debug-chat/chat-ui-locales";
import { ROUTE_LANES } from "@lianki/debug-chat/lane-route";
import { LANES } from "@lianki/debug-chat/voices";

describe("addressedLanes", () => {
  it("maps every route lane to a chat lane: chat is 小克's", () => {
    expect(ROUTE_TO_LANE).toEqual({ chat: "claude", codex: "codex", agy: "agy" });
    for (const r of ROUTE_LANES) expect(ROUTE_TO_LANE[r] in LANES).toBe(true);
  });

  it("finds own names and the owner's names for the lanes", () => {
    expect(addressedLanes("codex, 看一下")).toEqual(["codex"]);
    expect(addressedLanes("coco，帮我看看")).toEqual(["codex"]);
    expect(addressedLanes("杰咪，在吗")).toEqual(["agy"]);
    expect(addressedLanes("xiaoke, hello")).toEqual(["claude"]);
    expect(addressedLanes("小可 你好")).toEqual(["claude"]);
  });

  it("finds heard spellings, with their separator", () => {
    expect(addressedLanes("可可，看一下")).toEqual(["codex"]);
    expect(addressedLanes("杰米，在吗")).toEqual(["agy"]);
    expect(addressedLanes("小克，你好")).toEqual(["claude"]);
    expect(addressedLanes("hey Xiao Ke, are you there")).toEqual(["claude"]);
  });

  it("is empty for a line that names nobody", () => {
    expect(addressedLanes("今天天气不错")).toEqual([]);
    expect(addressedLanes("Codecs are hard")).toEqual([]);
    expect(addressedLanes("codex的设计不错")).toEqual([]);
    expect(addressedLanes("")).toEqual([]);
    expect(addressedLanes("   ")).toEqual([]);
    expect(addressedLanes(undefined)).toEqual([]);
    expect(addressedLanes(42)).toEqual([]);
  });

  it("finds several names, in the order named", () => {
    expect(addressedLanes("codex 和 agy，一起看看")).toEqual(["codex", "agy"]);
    expect(addressedLanes("杰咪和coco，你们好")).toEqual(["agy", "codex"]);
    expect(addressedLanes("codex 和 codex，看看")).toEqual(["codex"]);
  });
});

describe("createAddressFlash", () => {
  const owner = (id: string, text: string) => ({ id, from: "owner", text });

  it("flashes a name in the interim once per utterance", () => {
    const f = createAddressFlash();
    expect(f.heard("co", 0)).toEqual([]);
    expect(f.heard("coco，", 100)).toEqual(["codex"]);
    expect(f.heard("coco，帮我", 200)).toEqual([]);
    expect(f.heard("coco，帮我看看", 300)).toEqual([]);
    expect(f.heard("", 400)).toEqual([]);
  });

  it("adds a second name heard later in the same utterance", () => {
    const f = createAddressFlash();
    expect(f.heard("codex 和", 0)).toEqual(["codex"]);
    expect(f.heard("codex 和 agy，", 100)).toEqual(["agy"]);
    expect(f.heard("codex，", 200)).toEqual([]);
  });

  it("ignores the history, then pulses each arriving line's marks", () => {
    const f = createAddressFlash();
    expect(f.lines([], 0)).toEqual({ arrived: [], lanes: [] });
    const hist = [owner("a", "codex, old"), { id: "b", from: "agent", text: "hi" }];
    expect(f.lines(hist, 1)).toEqual({ arrived: [], lanes: [] });
    expect(f.lines(hist, 2)).toEqual({ arrived: [], lanes: [] });
    const next = [...hist, owner("c", "杰咪，新的")];
    expect(f.lines(next, 3)).toEqual({ arrived: [{ id: "c", lanes: ["agy"] }], lanes: ["agy"] });
    expect(f.lines(next, 4)).toEqual({ arrived: [], lanes: [] });
  });

  it("does not flash the log again for the line the interim already flashed", () => {
    const f = createAddressFlash();
    f.lines([owner("h", "hello")], 0);
    expect(f.heard("coco，看", 1000)).toEqual(["codex"]);
    const r = f.lines([owner("h", "hello"), owner("n", "coco，看一下")], 1500);
    expect(r).toEqual({ arrived: [{ id: "n", lanes: ["codex"] }], lanes: [] });
    // The sent line ended the utterance: the next one flashes again.
    expect(f.heard("coco，再看", 1600)).toEqual(["codex"]);
  });

  it("does not count the hub's copy of a line just shown as a new call", () => {
    const f = createAddressFlash();
    f.lines([owner("h", "x")], 0);
    expect(f.lines([owner("h", "x"), owner("tmp", "coco，看")], 10).lanes).toEqual(["codex"]);
    const echo = f.lines([owner("h", "x"), owner("tmp", "coco，看"), owner("hub", "coco，看")], 20);
    expect(echo).toEqual({ arrived: [], lanes: [] });
    // Long after, the same words are a new call.
    const again = [
      owner("h", "x"),
      owner("tmp", "coco，看"),
      owner("hub", "coco，看"),
      owner("z", "coco，看"),
    ];
    expect(f.lines(again, 20 + UTTERANCE_GAP_MS + 1).lanes).toEqual(["codex"]);
  });

  it("starts a new utterance after a quiet gap without a send", () => {
    const f = createAddressFlash();
    expect(f.heard("codex，", 0)).toEqual(["codex"]);
    expect(f.heard("codex，", UTTERANCE_GAP_MS)).toEqual([]);
    expect(f.heard("codex，", 2 * UTTERANCE_GAP_MS + 1)).toEqual(["codex"]);
    // A line long after the last interim: the stale utterance is over, it flashes.
    f.lines([], 0);
    f.lines([owner("a", "x")], 0);
    expect(f.lines([owner("a", "x"), owner("b", "codex，")], 10 * UTTERANCE_GAP_MS).lanes).toEqual([
      "codex",
    ]);
  });

  it("lists nothing for a line that names nobody", () => {
    const f = createAddressFlash();
    f.lines([owner("a", "x")], 0);
    expect(f.lines([owner("a", "x"), owner("b", "just talking")], 1)).toEqual({
      arrived: [],
      lanes: [],
    });
  });
});

describe("flash styling", () => {
  it("rings in the lane's mark colour, or the text colour without one", () => {
    expect(ringOf("codex")).toBe(LANES.codex.mark!.bg);
    expect(ringOf("main")).toBe("currentColor");
    const p = flashProps("agy");
    expect(p[FLASH_ATTR]).toBe("agy");
    expect(p.style["--lk-ring"]).toBe(LANES.agy.mark!.bg);
  });

  it("pulses twice over FLASH_MS, and holds a still ring under reduced motion", () => {
    expect(FLASH_MS).toBe(1200);
    expect(ADDRESSED_CSS).toContain("@keyframes lk-addr-pulse");
    expect(ADDRESSED_CSS).toContain(`lk-addr-pulse ${FLASH_MS / 2}ms ease-out 2`);
    expect(ADDRESSED_CSS).toMatch(
      /prefers-reduced-motion: reduce\)\{\[data-lk-flash\]\{animation:none!important;box-shadow:0 0 0 2px var\(--lk-ring\)\}/,
    );
    expect(ADDRESSED_CSS).toContain('html[data-motion="off"] [data-lk-flash]');
  });

  it("finds each lane's most recent line", () => {
    expect(
      latestOfLane([
        { id: "1", lane: "codex" },
        { id: "2" },
        { id: "3", lane: "agy" },
        { id: "4", lane: "codex" },
        { id: "5", lane: "nope" },
      ]),
    ).toEqual({ codex: "4", agy: "3" });
  });
});

describe("AddressedMarks", () => {
  const html = (pulse?: boolean) =>
    renderToStaticMarkup(
      createElement(AddressedMarks, {
        lanes: ["codex", "agy"],
        label: EXTRA.en.addressed,
        pulse,
      }),
    );

  it("labels each mark with the lane's name", () => {
    const h = html();
    expect(h).toContain('aria-label="Addressed: coco"');
    expect(h).toContain('aria-label="Addressed: 杰咪"');
    expect(h).toContain('data-lane="codex"');
    expect(h).not.toContain(FLASH_ATTR);
  });

  it("pulses on arrival", () => {
    const h = html(true);
    expect(h).toContain(`${FLASH_ATTR}="codex"`);
    expect(h).toContain("--lk-ring");
  });

  it("falls back to the lane id with no name, and draws no mark without one", () => {
    const h = renderToStaticMarkup(
      createElement(AddressedMarks, { lanes: ["main"], label: "Addressed: {name}" }),
    );
    expect(h).toContain('aria-label="Addressed: main"');
    expect(laneAvatar("main")).toBeUndefined();
  });

  it("has the label in every locale, keeping {name}", () => {
    for (const [l, s] of Object.entries(EXTRA))
      expect([l, s.addressed.includes("{name}")]).toEqual([l, true]);
  });
});

describe("LaneTag", () => {
  const tag = (props: Parameters<typeof LaneTag>[0]) =>
    renderToStaticMarkup(createElement(LaneTag, props));
  it("writes the name with the colour that suits it", () => {
    expect(tag({ lane: "codex" })).toContain("coco: ");
    expect(tag({ lane: "agy" })).toContain("杰咪：");
    expect(tag({ lane: "codex", inline: true })).not.toContain(":");
    expect(tag({ lane: "main", agentName: "Li" })).toContain("Li: ");
    expect(tag({ lane: "main" })).toBe("");
  });
});
