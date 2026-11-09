import { describe, expect, it } from "bun:test";
import { dwellMs } from "@lianki/debug-chat/float-lines";
import { HOLD_MS } from "@lianki/debug-chat/log-engage";
import {
  NEW_ATTR,
  SCRUB_ATTR,
  SCRUB_PULSE_MS,
  SHIMMER_CSS,
  createNewLines,
  newShimmer,
} from "@lianki/debug-chat/shimmer";

const reply = (id: string, text = "A reply to read.") => ({ id, from: "agent", text });

describe("newShimmer: one sweep over the minimized chat's reading time (owner, 2026-11-10)", () => {
  it("lasts exactly dwellMs, picked up part-way by a negative delay", () => {
    const text = "Une phrase un peu plus longue pour lire.";
    const ms = dwellMs(text);
    expect(newShimmer(text, 1000, 1000)?.style.animation).toBe(`lk-shimmer ${ms}ms linear -0ms 1`);
    expect(newShimmer(text, 1000, 1700)?.style.animation).toBe(
      `lk-shimmer ${ms}ms linear -700ms 1`,
    );
    expect(newShimmer(text, 1000, 1000)?.[NEW_ATTR]).toBe(true);
    // Its reading time over: plain text.
    expect(newShimmer(text, 1000, 1000 + ms)).toBeNull();
  });

  it("a CJK line reads slower, so it shimmers longer (the same source)", () => {
    const zh = newShimmer("这是一条新的回复消息", 0, 0)!.style.animation;
    expect(zh).toContain(`${dwellMs("这是一条新的回复消息")}ms`);
  });
});

describe("createNewLines", () => {
  it("the history never shimmers; a live reply does; the user's own lines do not", () => {
    const n = createNewLines();
    n.see([], 0);
    const history = [reply("h1"), { id: "o1", from: "owner", text: "mine" }];
    n.see(history, 100);
    expect(n.shimmer(history[0], 100)).toBeNull();
    expect(n.arrivedAt("h1")).toBeUndefined();
    const live = [...history, reply("r1"), { id: "o2", from: "owner", text: "typed" }];
    n.see(live, 5000);
    expect(n.arrivedAt("r1")).toBe(5000);
    expect(n.shimmer(live[2], 5000)).not.toBeNull();
    expect(n.shimmer(live[3], 5000)).toBeNull();
    // Seeing again changes nothing (render-time, idempotent).
    n.see(live, 9000);
    expect(n.arrivedAt("r1")).toBe(5000);
  });

  it("hands back the same object every render, so the animation is never shifted", () => {
    const n = createNewLines();
    n.see([reply("h")], 0);
    n.see([reply("h"), reply("r")], 10);
    const a = n.shimmer(reply("r"), 10);
    const b = n.shimmer(reply("r"), 900);
    expect(a).not.toBeNull();
    expect(b).toBe(a);
  });
});

describe("the CSS", () => {
  it("a mask in oklch alpha only; off under reduced motion and the app's own switch", () => {
    expect(SHIMMER_CSS).toContain("@keyframes lk-shimmer");
    expect(SHIMMER_CSS).toContain("mask-image");
    expect(SHIMMER_CSS).not.toMatch(/#[0-9a-f]{3,6}\b|rgb\(/i);
    expect(SHIMMER_CSS).toContain("prefers-reduced-motion: reduce");
    expect(SHIMMER_CSS).toContain(`html[data-motion="off"] [${NEW_ATTR}]`);
    expect(SHIMMER_CSS).toContain(`[${SCRUB_ATTR}] [data-testid="debug-chat-float"]`);
  });

  it("the scrub pulse comes from the long-press time, no number of its own", () => {
    expect(SCRUB_PULSE_MS).toBe(2 * HOLD_MS);
  });
});
