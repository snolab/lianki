import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  BAR_CONTROL,
  BAR_LINE,
  CONTROL_W,
  INPUT_START,
  MIC_BOX,
  NO_SELECT,
  STRIP_INSET_PX,
  TAP_44_CSS,
  TEXT_SELECT,
  barGeometry,
  stripTopRadius,
} from "../packages/debug-chat/src/bar-geometry";

describe("the glass strip's top corners (owner, 2026-11-10)", () => {
  test("concentric with the progress pill's end caps: its radius (half its height) plus the inset", () => {
    // A 20 px bar under a 4 px inset: the slot is 24, the cap's radius 10, the corner 14.
    expect(stripTopRadius(20 + STRIP_INSET_PX)).toBe(10 + STRIP_INSET_PX);
    expect(stripTopRadius(17 + STRIP_INSET_PX)).toBe(8.5 + STRIP_INSET_PX);
    // Nothing measured yet: just the inset, never negative.
    expect(stripTopRadius(0)).toBe(STRIP_INSET_PX);
  });
  test("the bar is a full pill in the strip, the strip's top radius set from the measured slot", () => {
    const bar = readFileSync("packages/debug-chat/src/EtaBar.tsx", "utf8");
    expect(bar).toContain('${glass ? "rounded-full" : "rounded"}');
    const chat = readFileSync("packages/debug-chat/src/DebugChat.tsx", "utf8");
    expect(chat).toContain("borderTopLeftRadius: stripTopRadius(etaH)");
    expect(chat).toContain("borderTopRightRadius: stripTopRadius(etaH)");
  });
});

describe("chat bar geometry (concentric mic)", () => {
  test("the bar draws its radius, border and padding inline, from the variables", () => {
    const s = barGeometry() as Record<string, string>;
    expect(s.borderRadius).toBe("var(--lk-bar-r)");
    expect(s.borderWidth).toBe("var(--lk-bar-b)");
    expect(s.padding).toBe("var(--lk-bar-pad)");
    expect(s["--lk-bar-r"]).toBe(
      "calc(var(--lk-bar-b) + var(--lk-bar-pad) + var(--lk-bar-line) / 2)",
    );
  });
  test("the input's one-line height is the line box (a class the app already has)", () => {
    const src = readFileSync("packages/debug-chat/src/DebugChat.tsx", "utf8");
    expect(src).toContain(`h-[${BAR_LINE}]`);
    expect(src).toContain(`min-h-[${BAR_LINE}]`);
  });
});

describe("the mic in the cluster (it keeps its place as the chat folds)", () => {
  test("one padding, open or folded: a tighter pill moved the mark and the mic", () => {
    expect(barGeometry()).toEqual(barGeometry());
    expect(barGeometry.length).toBe(0);
  });
  test("every control, and the mic, is one fixed 44 px slot", () => {
    expect(CONTROL_W).toBe("2.75rem");
    expect(BAR_CONTROL.width).toBe(CONTROL_W);
    expect(BAR_CONTROL.flexShrink).toBe(0);
    expect((MIC_BOX as Record<string, string>)["--lk-mic-w"]).toBe(CONTROL_W);
    expect(INPUT_START).toBe(`calc(3 * ${CONTROL_W})`);
  });
  test("the touch areas are 44 px high too, outranking the app's .tap-40", () => {
    expect(TAP_44_CSS).toContain("max(100%,44px)");
    expect(TAP_44_CSS).toContain("[data-lk-tap].tap-40::before");
  });
  test("the bar's order: [mark | + | mic | input], the pill's Li in the +'s slot", () => {
    const src = readFileSync("packages/debug-chat/src/DebugChat.tsx", "utf8");
    const bar = src.slice(src.indexOf("ref={barEl}"));
    const at = (s: string) => bar.indexOf(s);
    expect(at("{controls}")).toBeGreaterThan(0);
    expect(at("<AttachButton")).toBeGreaterThan(at("{controls}"));
    expect(at("{micEl}")).toBeGreaterThan(at("<AttachButton"));
    expect(at('data-testid="debug-chat-input-slot"')).toBeGreaterThan(at("{micEl}"));
    // The mic is rendered once, as one node across the fold.
    expect(src.split("{micEl}").length).toBe(2);
    // The Li and the + take the same slot: no width class of their own.
    const li = src.slice(src.indexOf('data-testid="debug-chat-restore"'));
    expect(li.slice(0, li.indexOf("</span>"))).not.toMatch(/\bw-(8|10)\b/);
  });
});

describe("a long press on the mic selects no text (owner, 2026-11-11)", () => {
  test("NO_SELECT: no selection, no iOS callout; TEXT_SELECT gives the input text back", () => {
    expect(NO_SELECT).toMatchObject({
      userSelect: "none",
      WebkitUserSelect: "none",
      WebkitTouchCallout: "none",
    });
    expect(TEXT_SELECT).toMatchObject({ userSelect: "text", WebkitUserSelect: "text" });
  });

  test("the mic, its wrapper and the bar carry it; the input slot is text; no context menu", () => {
    const mic = readFileSync("packages/debug-chat/src/MicButton.tsx", "utf8");
    const button = mic.slice(mic.indexOf('data-testid="debug-chat-mic"'));
    const tag = button.slice(0, button.indexOf("className="));
    expect(tag).toContain("...NO_SELECT");
    expect(tag).toContain("onContextMenu={(e) => e.preventDefault()}");
    expect(mic).toContain('<div className="relative flex shrink-0" style={NO_SELECT}>');
    const chat = readFileSync("packages/debug-chat/src/DebugChat.tsx", "utf8");
    const pill = chat.slice(chat.indexOf('data-testid="debug-chat-pill"'));
    expect(pill.slice(0, pill.indexOf("className="))).toContain("...NO_SELECT");
    const slot = chat.slice(chat.indexOf('data-testid="debug-chat-input-slot"'));
    expect(slot.slice(0, slot.indexOf("className="))).toContain("...TEXT_SELECT");
  });
});
