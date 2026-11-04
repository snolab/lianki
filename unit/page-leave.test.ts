import { describe, expect, it } from "bun:test";
import { onPageLeave, type LeaveReason } from "@/lib/page-leave";
import { type GestureEvent, IDLE, stepGesture } from "@/lib/words/swipe-machine";

function targets() {
  const win = new EventTarget();
  const doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
  return { win, doc };
}

describe("onPageLeave (edge Back, app switch: docs/design-principles.md)", () => {
  it("reports hidden, pagehide and popstate; blur only when asked", () => {
    const t = targets();
    const seen: LeaveReason[] = [];
    const off = onPageLeave((why) => seen.push(why), t);
    t.doc.dispatchEvent(new Event("visibilitychange")); // still visible: nothing
    t.doc.visibilityState = "hidden";
    t.doc.dispatchEvent(new Event("visibilitychange"));
    t.win.dispatchEvent(new Event("pagehide"));
    t.win.dispatchEvent(new Event("popstate"));
    t.win.dispatchEvent(new Event("blur"));
    expect(seen).toEqual(["hidden", "pagehide", "popstate"]);
    off();
    t.win.dispatchEvent(new Event("popstate"));
    expect(seen.length).toBe(3);

    const withBlur: LeaveReason[] = [];
    const off2 = onPageLeave((why) => withBlur.push(why), { ...t, blur: true });
    t.win.dispatchEvent(new Event("blur"));
    off2();
    t.win.dispatchEvent(new Event("blur"));
    expect(withBlur).toEqual(["blur"]);
  });
});

describe("a gesture the system steals", () => {
  const A = 64;
  const run = (evs: GestureEvent[]) => {
    let s = IDLE;
    const fx: string[] = [];
    for (const e of evs) {
      const r = stepGesture(s, e, A);
      s = r.state;
      fx.push(...r.effects.map((f) => f.type));
    }
    return { s, fx };
  };

  it("past the far level, then cancelled: home, no grade; a late lift taps nothing", () => {
    const evs: GestureEvent[] = [{ type: "down", x: 300, y: 100, t: 0, catching: false }];
    // A drag toward the left edge, as Android's Back would take over.
    for (let i = 1; i <= 12; i++) evs.push({ type: "move", x: 300 - i * 16, y: 100, t: i * 16 });
    evs.push({ type: "cancel" });
    const stolen = run(evs);
    expect(stolen.fx).toContain("level");
    expect(stolen.fx).not.toContain("release");
    expect(stolen.fx.at(-1)).toBe("return");
    const after = run([...evs, { type: "settled" }, { type: "up", t: 400 }]);
    expect(after.s.phase).toBe("idle");
    expect(after.fx).not.toContain("tap");
    expect(after.fx).not.toContain("release");
  });
});
