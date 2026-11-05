import { describe, expect, it } from "bun:test";
import { LINE_SELECTABLE } from "@lianki/debug-chat/copy-line";
import {
  FENCE_ATTR,
  FENCE_CSS,
  FENCE_SELECTOR,
  SELECTABLE_SELECTOR,
  clampSide,
  fenceUp,
  pointerHint,
} from "@lianki/debug-chat/select-fence";

describe("clampSide: where a focus that left the chat goes back to", () => {
  it("stays put inside the chat", () => {
    expect(clampSide(0)).toBeNull();
    expect(clampSide(0, "before")).toBeNull();
    expect(clampSide(0, "after")).toBeNull();
  });
  it("goes by document order without a pointer", () => {
    expect(clampSide(-1)).toBe("start");
    expect(clampSide(1)).toBe("end");
  });
  it("goes the way the pointer left, over document order", () => {
    expect(clampSide(-1, "after")).toBe("end");
    expect(clampSide(1, "before")).toBe("start");
    expect(clampSide(1, "after")).toBe("end");
    expect(clampSide(-1, "before")).toBe("start");
  });
});

describe("pointerHint: which way the pointer left", () => {
  const fence = { top: 100, bottom: 400 };
  const line = { top: 200, bottom: 220 };
  it("above or below the chat", () => {
    expect(pointerHint(50, fence, line)).toBe("before");
    expect(pointerHint(500, fence)).toBe("after");
  });
  it("beside the chat: above or below the line it started on", () => {
    expect(pointerHint(150, fence, line)).toBe("before");
    expect(pointerHint(300, fence, line)).toBe("after");
  });
  it("level with the line, or with no line: no say", () => {
    expect(pointerHint(210, fence, line)).toBeUndefined();
    expect(pointerHint(210, fence)).toBeUndefined();
  });
});

describe("fenceUp: when the page outside goes non-selectable", () => {
  const up = (armed: boolean, pressed: boolean, anchoredInChat: boolean, collapsed: boolean) =>
    fenceUp({ armed, pressed, anchoredInChat, collapsed });
  it("while a line is pressed", () => {
    expect(up(true, true, false, true)).toBe(true);
  });
  it("after it, while the selection it made in the chat is open (iOS handles)", () => {
    expect(up(true, false, true, false)).toBe(true);
    expect(up(true, false, true, true)).toBe(false);
    expect(up(true, false, false, false)).toBe(false);
  });
  it("not once a press outside the chat disarmed it, though the old selection is still there", () => {
    expect(up(false, false, true, false)).toBe(false);
  });
  it("never for a selection no press on a line started", () => {
    expect(up(false, false, false, false)).toBe(false);
  });
});

describe("FENCE_CSS", () => {
  it("applies only under the attribute, spares the chat and its ancestors, keeps the lines", () => {
    const [outside, lines] = FENCE_CSS.split("\n");
    expect(outside).toStartWith(`html[${FENCE_ATTR}] body *`);
    expect(outside).toContain(`:not(${FENCE_SELECTOR} *)`);
    expect(outside).toContain(`:not(:has(${FENCE_SELECTOR}))`);
    expect(outside).toContain("user-select:none");
    expect(lines).toContain(`${FENCE_SELECTOR} ${SELECTABLE_SELECTOR}`);
    expect(lines).toContain("user-select:text");
  });
  it("finds the lines by a class LINE_SELECTABLE carries", () => {
    expect(LINE_SELECTABLE.split(" ")).toContain(SELECTABLE_SELECTOR.slice(1));
  });
});
