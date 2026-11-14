// The live lane table (config chat.lanes; voices.ts setLaneTable): dynamic
// lanes for the chat, the router (lane-route.ts), the avatar flash
// (addressed.ts), the wake words (wake-names.ts) and the @mention (polish.ts).
// The built-in three behave as before with an empty table.
import { afterEach, describe, expect, it } from "bun:test";
import {
  LANES,
  LANE_IDS,
  isLaneId,
  laneIds,
  laneOf,
  laneSpec,
  laneTable,
  parseLaneDef,
  setLaneTable,
  voiceIdOf,
} from "@/packages/debug-chat/src/voices";
import {
  ROUTE_LANES,
  isRouteLane,
  laneNames,
  laneOfRoute,
  laneTakes,
  routeLanes,
  routeLine,
  routeOfLane,
} from "@/packages/debug-chat/src/lane-route";
import { addressedLanes, latestOfLane, ringOf } from "@/packages/debug-chat/src/addressed";
import { laneSpellings, wakeParticipants } from "@/packages/debug-chat/src/wake-names";
import { wakeMention } from "@/packages/debug-chat/src/polish";
import { presentList } from "@/packages/debug-chat/src/presence";

afterEach(() => void setLaneTable([]));

const RECHROME = {
  id: "rechrome",
  name: "小镀",
  aliases: ["Redu"],
  heard: ["瑞克罗姆"],
  voice: "calm",
  color: "oklch(0.6 0.12 200)",
};

describe("parseLaneDef / setLaneTable", () => {
  it("keeps a well-formed row, lower-cases its names", () => {
    expect(parseLaneDef(RECHROME)).toEqual({ ...RECHROME, aliases: ["redu"] });
    expect(parseLaneDef({ id: "otoji-codex-54566" })).toEqual({ id: "otoji-codex-54566" });
  });
  it("drops a row with anything wrong in it", () => {
    for (const bad of [
      null,
      [],
      "x",
      { id: "" },
      { id: "has space" },
      { id: "a", aliases: "x" },
      { id: "a", aliases: [1] },
      { id: "a", aliases: [""] },
      { id: "a", aliases: ["【x】"] },
      { id: "a", aliases: Array(25).fill("x") },
      { id: "a", heard: ["x".repeat(41)] },
      { id: "a", name: "" },
      { id: "a", name: 3 },
      { id: "a", voice: "loud" },
      { id: "a", color: "#f00" },
      { id: "a", color: 1 },
    ])
      expect(parseLaneDef(bad)).toBeNull();
  });
  it("first row per id, at most 64, anything else clears", () => {
    expect(setLaneTable([{ id: "a" }, { id: "a", name: "B" }, { id: "b c" }])).toEqual([
      { id: "a" },
    ]);
    expect(setLaneTable(Array.from({ length: 70 }, (_, i) => ({ id: `l${i}` })))).toHaveLength(64);
    expect(setLaneTable("nope")).toEqual([]);
    expect(laneTable()).toEqual([]);
  });
});

describe("the built-in lanes, with an empty table, as before", () => {
  it("ids, specs, routes", () => {
    expect(laneIds()).toEqual([...LANE_IDS]);
    for (const id of LANE_IDS) expect(laneSpec(id)).toBe(LANES[id]);
    expect(routeLanes()).toEqual([...ROUTE_LANES]);
    expect(isRouteLane("codex")).toBe(true);
    expect(isRouteLane("rechrome")).toBe(false);
    expect(isLaneId("rechrome")).toBe(false);
    expect(routeOfLane("main")).toBeNull();
    expect(routeOfLane("claude")).toBe("chat");
    expect(laneOfRoute("chat")).toBe("claude");
    expect(laneOfRoute("codex")).toBe("codex");
    expect(laneNames("codex").exact).toContain("coco");
    expect(laneNames("nobody")).toEqual({ exact: [], heard: [] });
    expect(routeLine("coco, 看一下").lanes).toEqual(["codex"]);
    expect(routeLine("全体，集合").lanes).toEqual(["chat", "codex", "agy"]);
  });
  it("an unknown id still gets a plain spec (its name, main's voice, the generated mark)", () => {
    const s = laneSpec("ghost");
    expect(s).toMatchObject({ name: "ghost", voice: "main", aliases: ["ghost"] });
    expect(s.mark?.bg).toMatch(/^oklch\(/);
  });
});

describe("a configured lane", () => {
  it("is a lane: its spec, its prefix, its voice, its ring", () => {
    setLaneTable([RECHROME]);
    expect(laneIds()).toEqual([...LANE_IDS, "rechrome"]);
    expect(isLaneId("rechrome")).toBe(true);
    const s = laneSpec("rechrome");
    expect(s).toMatchObject({ name: "小镀", voice: "calm", aliases: ["rechrome", "小镀", "redu"] });
    expect(s.mark?.bg).toBe("oklch(0.6 0.12 200)");
    expect(ringOf("rechrome")).toBe("oklch(0.6 0.12 200)");
    expect(laneOf({ text: "【小镀】hi" })).toEqual({ lane: "rechrome", text: "hi" });
    expect(voiceIdOf({ text: "【rechrome】hi" })).toBe("calm");
    expect(
      latestOfLane([
        { id: "1", lane: "rechrome" },
        { id: "2", lane: "nope" },
      ]),
    ).toEqual({
      rechrome: "1",
    });
    // Without a colour: the generated mark's.
    setLaneTable([{ id: "otoji-codex-54566" }]);
    expect(laneSpec("otoji-codex-54566").mark?.bg).toMatch(/^oklch\(/);
  });
  it("routes: by id, name, alias (any case), heard with punctuation only; 全体 includes it", () => {
    setLaneTable([RECHROME, { id: "otoji-codex-54566" }]);
    expect(routeLanes()).toEqual(["chat", "codex", "agy", "rechrome", "otoji-codex-54566"]);
    expect(isRouteLane("rechrome")).toBe(true);
    expect(routeLine("小镀，看一下").lanes).toEqual(["rechrome"]);
    expect(routeLine("Redu, look").lanes).toEqual(["rechrome"]);
    expect(routeLine("REchrome 看一下")).toMatchObject({ lanes: ["rechrome"], text: "看一下" });
    expect(routeLine("瑞克罗姆，在吗").lanes).toEqual(["rechrome"]);
    expect(routeLine("瑞克罗姆的设计").addressed).toBe(false);
    expect(routeLine("OTOJI-CODEX-54566: hi").lanes).toEqual(["otoji-codex-54566"]);
    expect(routeLine("coco 和 小镀，看一下").lanes).toEqual(["codex", "rechrome"]);
    expect(routeLine("全体，集合").lanes).toContain("otoji-codex-54566");
    expect(laneTakes("rechrome", { from: "owner", text: "小镀，看一下" })).toBe(true);
    expect(addressedLanes("小镀，看一下")).toEqual(["rechrome"]);
    expect(wakeMention("小镀，看一下")).toBe("@小镀 看一下");
  });
  it("a row for a built-in lane adds names (咪宝 from config, no deploy) and may rename it", () => {
    setLaneTable([
      { id: "agy", aliases: ["mibao"], heard: ["米宝"] },
      { id: "codex", name: "可乐", voice: "bright" },
    ]);
    expect(laneIds()).toEqual([...LANE_IDS]);
    expect(laneSpec("agy").aliases).toContain("mibao");
    expect(laneSpec("agy").name).toBe("杰咪");
    expect(laneSpec("codex")).toMatchObject({ name: "可乐", voice: "bright" });
    expect(routeLine("mibao, hi").lanes).toEqual(["agy"]);
    expect(routeLine("米宝，在吗").lanes).toEqual(["agy"]);
    expect(laneNames("agy").exact).toEqual(expect.arrayContaining(["杰咪", "agy", "mibao"]));
    expect(laneSpellings("agy")).toContain("mibao");
    expect(laneSpellings("agy")).toContain("米宝");
    // A row naming main adds no "main" address.
    setLaneTable([{ id: "claude", aliases: ["kk"] }]);
    expect(laneNames("chat").exact).toContain("kk");
    expect(routeLanes()).toEqual([...ROUTE_LANES]);
  });
  it("its name is a wake word; its token entry in presence becomes its lane's", () => {
    setLaneTable([RECHROME]);
    expect(wakeParticipants({}).map((p) => p.name)).toContain("小镀");
    const list = presentList({
      now: 10,
      readMs: 100,
      speakerMs: 100,
      live: [{ tag: "t".repeat(16), at: 5 }],
      records: [{ tag: "t".repeat(16), id: "i", userId: "u", thread: "owner", lane: "rechrome" }],
      lines: [],
      lanes: [{ lane: "rechrome", state: "listener" }],
    });
    expect(list[0]).toMatchObject({ key: "lane:rechrome", lane: "rechrome", mode: "listener" });
  });
});
