import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resetUiStores } from "@lianki/ui-state";
import { CHAT_FOLD_INITIAL, chatFold } from "@lianki/debug-chat/ui-store";
import {
  type FoldState,
  HANDLE_SIZE,
  floatSide,
  foldNext,
  handleTop,
  handleTouch,
  mirrorShift,
  nearestEdge,
  pushedAgainst,
  TOUCH_INSET,
} from "@lianki/debug-chat/fold";

const at = (fold: FoldState["fold"], edge: FoldState["edge"] = "right"): FoldState => ({
  fold,
  edge,
});

describe("foldNext", () => {
  it("the mark toggles open ⇄ pill: the third level (tucked) is removed", () => {
    expect(foldNext(at("open"), { type: "mark" })).toEqual(at("pill"));
    expect(foldNext(at("pill"), { type: "mark" })).toEqual(at("open"));
    expect(foldNext(at("pill", "left"), { type: "mark" })).toEqual(at("open", "left"));
  });
  it("the handle brings the pill back, never the full chat", () => {
    expect(foldNext(at("tucked"), { type: "handle" })).toEqual(at("pill"));
    expect(foldNext(at("open"), { type: "handle" })).toEqual(at("open"));
  });
  it("restore opens from any fold; minimize only folds an open chat", () => {
    for (const f of ["open", "pill", "tucked"] as const)
      expect(foldNext(at(f, "left"), { type: "restore" })).toEqual(at("open", "left"));
    expect(foldNext(at("open"), { type: "minimize" })).toEqual(at("pill"));
    expect(foldNext(at("tucked"), { type: "minimize" })).toEqual(at("tucked"));
  });
  it("a pill pushed against an edge no longer tucks: it stays a pill at that edge", () => {
    expect(foldNext(at("pill"), { type: "dropped", nearest: "left", against: "left" })).toEqual(
      at("pill", "left"),
    );
  });
  it("any other drop only follows the nearest edge (mirroring on the left)", () => {
    expect(foldNext(at("pill"), { type: "dropped", nearest: "left", against: null })).toEqual(
      at("pill", "left"),
    );
    // An open bar against the edge does not tuck.
    expect(foldNext(at("open"), { type: "dropped", nearest: "right", against: "right" })).toEqual(
      at("open", "right"),
    );
  });
});

describe("edges", () => {
  it("nearest edge by the box's centre", () => {
    expect(nearestEdge(0, 128, 390)).toBe("left");
    expect(nearestEdge(250, 378, 390)).toBe("right");
    // Centre exactly in the middle: the right, the default.
    expect(nearestEdge(130, 260, 390)).toBe("right");
  });
  it("pushed against an edge only when flush with it", () => {
    expect(pushedAgainst(0, 120, 390)).toBe("left");
    expect(pushedAgainst(270, 390, 390)).toBe("right");
    expect(pushedAgainst(8, 128, 390)).toBeNull();
    expect(pushedAgainst(262, 382, 390)).toBeNull();
  });
  it("the floating lines align from the pill's side, not the screen third", () => {
    expect(floatSide("right")).toBe("left");
    expect(floatSide("left")).toBe("right");
  });
});

describe("mirrorShift", () => {
  const d = { boxWidth: 320, pillWidth: 128 };
  it("keeps a minimized pill in place when the box mirrors", () => {
    expect(mirrorShift({ ...d, from: "right", to: "left", fold: "pill" })).toBe(-192);
    expect(mirrorShift({ ...d, from: "left", to: "right", fold: "tucked" })).toBe(192);
  });
  it("nothing moves open, or when the edge stays", () => {
    expect(mirrorShift({ ...d, from: "right", to: "left", fold: "open" })).toBe(0);
    expect(mirrorShift({ ...d, from: "left", to: "left", fold: "pill" })).toBe(0);
  });
});

describe("handle", () => {
  it("both shapes are thumb-sized, their touch area off the Back-gesture edge", () => {
    for (const shape of ["half", "square"] as const) {
      const t = handleTouch(shape);
      expect(t.inset).toBe(TOUCH_INSET);
      expect(t.width).toBeGreaterThanOrEqual(44);
      expect(HANDLE_SIZE[shape].h).toBeGreaterThanOrEqual(44);
    }
  });
  it("centred on the pill, kept inside the safe area", () => {
    expect(handleTop({ centerY: 800, height: 88, vh: 844 })).toBe(756);
    expect(handleTop({ centerY: 840, height: 88, vh: 844, safeBottom: 34 })).toBe(722);
    expect(handleTop({ centerY: 10, height: 88, vh: 844, safeTop: 47 })).toBe(47);
  });
});

describe("chatFold (per device)", () => {
  let data: Map<string, string>;
  beforeEach(() => {
    data = new Map();
    const localStorage = {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, String(v)),
      removeItem: (k: string) => void data.delete(k),
    };
    (globalThis as { window?: unknown }).window = { localStorage, addEventListener() {} };
    resetUiStores();
  });
  afterEach(() => {
    resetUiStores();
    delete (globalThis as { window?: unknown }).window;
  });
  const stored = (state: unknown) =>
    data.set("lk:pref:chat-fold", JSON.stringify({ state, version: 1 }));
  it("starts untucked on the right, kept in localStorage lk:pref:chat-fold", () => {
    expect(CHAT_FOLD_INITIAL).toEqual({ tucked: false, edge: "right" });
    expect(chatFold().getState()).toEqual(CHAT_FOLD_INITIAL);
    chatFold().setState({ tucked: true, edge: "left" });
    expect(JSON.parse(data.get("lk:pref:chat-fold")!).state).toEqual({
      tucked: true,
      edge: "left",
    });
    resetUiStores();
    expect(chatFold().getState()).toEqual({ tucked: true, edge: "left" });
  });
  it("a damaged value falls back field by field", () => {
    stored({ tucked: "yes", edge: "left" });
    expect(chatFold().getState()).toEqual({ tucked: false, edge: "left" });
    resetUiStores();
    stored({ tucked: true, edge: "top" });
    expect(chatFold().getState()).toEqual({ tucked: true, edge: "right" });
    resetUiStores();
    stored(null);
    expect(chatFold().getState()).toEqual(CHAT_FOLD_INITIAL);
  });
});
