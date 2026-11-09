import { describe, expect, it } from "bun:test";
import {
  HOLD_ATTR,
  HOLD_CSS,
  HOLD_MS,
  HOLD_SLOP_PX,
  type Held,
  heldAfterPress,
  holdStarts,
  holdStill,
  lineAt,
  logEngaged,
  typingLook,
} from "@lianki/debug-chat/log-engage";
import { LOG_TOUCH, logSurface } from "@lianki/debug-chat/log-surface";

const rest = { typing: false, plusMenu: false, micActive: false, held: false as Held };

describe("logEngaged", () => {
  it("is off at rest: the history is click-through glass", () => {
    expect(logEngaged(rest)).toBe(false);
    expect(
      logSurface({ expanded: false, fade: false, touch: logEngaged(rest) }).className,
    ).not.toContain("pointer-events-auto");
  });
  it("is on while the input is in use, or a hold engaged it", () => {
    expect(logEngaged({ ...rest, typing: true })).toBe(true);
    expect(logEngaged({ ...rest, plusMenu: true })).toBe(true);
    expect(logEngaged({ ...rest, held: "rest" })).toBe(true);
    expect(logEngaged({ ...rest, held: "open" })).toBe(true);
    expect(logSurface({ expanded: true, fade: false, touch: true }).className).toContain(LOG_TOUCH);
  });
  it("the mic alone does not engage it: a drag over the history pans the page (owner, 2026-11-10)", () => {
    expect(logEngaged({ ...rest, micActive: true })).toBe(false);
    const c = logSurface({ expanded: true, fade: false, touch: false }).className;
    expect(c).not.toContain("pointer-events-auto");
    // No scroll box at rest: a drag from a link in it scrolls the page, not the history.
    expect(c).toContain("overflow-y-hidden");
    expect(c).not.toContain("overflow-y-auto");
    expect(logSurface({ expanded: true, fade: false, touch: true }).className).toContain(
      "overflow-y-auto",
    );
  });
});

describe("holdStarts", () => {
  const log = { left: 100, top: 500, right: 400, bottom: 700 };
  const at = { engaged: false, log, button: 0, x: 200, y: 600 };
  it("starts on a primary press inside the history at rest", () => {
    expect(holdStarts(at)).toBe(true);
  });
  it("not when engaged (the log takes the press itself), hidden, empty, outside, or another button", () => {
    expect(holdStarts({ ...at, engaged: true })).toBe(false);
    expect(holdStarts({ ...at, log: null })).toBe(false);
    expect(holdStarts({ ...at, log: { ...log, bottom: 500 } })).toBe(false);
    expect(holdStarts({ ...at, y: 499 })).toBe(false);
    expect(holdStarts({ ...at, x: 401 })).toBe(false);
    expect(holdStarts({ ...at, button: 2 })).toBe(false);
  });
});

describe("holdStill", () => {
  it("keeps within the slop, cancels past it", () => {
    expect(holdStill({ x: 0, y: 0 }, { x: 6, y: 8 })).toBe(true);
    expect(holdStill({ x: 0, y: 0 }, { x: 0, y: HOLD_SLOP_PX + 1 })).toBe(false);
  });
  it("lasts the platform's long-press", () => {
    expect(HOLD_MS).toBeGreaterThanOrEqual(400);
    expect(HOLD_MS).toBeLessThanOrEqual(600);
  });
});

describe("lineAt", () => {
  const rows = [
    { left: 0, right: 100, top: 0, bottom: 20 },
    { left: 0, right: 100, top: 24, bottom: 44 },
  ];
  it("picks the line under the point, else the nearest by height", () => {
    expect(lineAt(rows, 50, 30)).toBe(1);
    expect(lineAt(rows, 50, 21)).toBe(0);
    expect(lineAt(rows, 50, 90)).toBe(1);
    expect(lineAt([], 0, 0)).toBe(-1);
  });
});

describe("heldAfterPress", () => {
  const press = { inChat: true, inLog: false, busy: false };
  it("a press outside the chat drops it", () => {
    expect(heldAfterPress("rest", { ...press, inChat: false })).toBe(false);
    expect(heldAfterPress("open", { ...press, inChat: false })).toBe(false);
  });
  it("a press in the chat keeps it as it was", () => {
    expect(heldAfterPress("rest", press)).toBe("rest");
    expect(heldAfterPress(false, press)).toBe(false);
    expect(heldAfterPress(false, { ...press, inLog: true })).toBe(false);
  });
  it("a press on the history while typing holds it open (the press blurs the input)", () => {
    expect(heldAfterPress(false, { ...press, inLog: true, busy: true })).toBe("open");
  });
});

describe("typingLook", () => {
  it("held open looks like typing (height, glass, opacity); a hold at rest does not", () => {
    expect(typingLook(true, false)).toBe(true);
    expect(typingLook(false, "open")).toBe(true);
    expect(typingLook(false, "rest")).toBe(false);
    expect(typingLook(false, false)).toBe(false);
  });
});

describe("HOLD_CSS", () => {
  it("turns the page's selection and callout off under the attribute, never the chat's", () => {
    expect(HOLD_CSS).toContain(`html[${HOLD_ATTR}]`);
    expect(HOLD_CSS).toContain(":not([data-debug-chat] *)");
    expect(HOLD_CSS).toContain("-webkit-touch-callout:none");
  });
});
