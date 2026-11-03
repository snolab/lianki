import { describe, expect, it } from "bun:test";
import {
  NEAR_END_PX,
  foldBackTo,
  nearEnd,
  repinEnd,
  stillAtEnd,
} from "@lianki/debug-chat/log-surface";

describe("nearEnd", () => {
  it("counts a few px from the end as the end", () => {
    expect(nearEnd(0)).toBe(true);
    expect(nearEnd(NEAR_END_PX)).toBe(true);
    expect(nearEnd(NEAR_END_PX + 1)).toBe(false);
  });
});

describe("foldBackTo", () => {
  const view = { top: 16, bottom: 900 };
  it("back to the end when the newest line is still in view at release", () => {
    // The 2026-11-03 bug: a short drag at the end, the newest line near the
    // bottom; the fold kept the tall view's centre line, from far back.
    expect(foldBackTo({ newest: { top: 560, bottom: 590 }, view })).toBe("end");
    expect(foldBackTo({ newest: { top: 870, bottom: 905 }, view })).toBe("end");
  });
  it("keeps the line being read once the newest line was scrolled out", () => {
    expect(foldBackTo({ newest: { top: 1300, bottom: 1330 }, view })).toBe("anchor");
  });
  it("a newest line scrolled out above (forward into the slack) still lands at the end only while in view", () => {
    expect(foldBackTo({ newest: { top: -40, bottom: -10 }, view })).toBe("anchor");
    expect(foldBackTo({ newest: { top: 10, bottom: 40 }, view })).toBe("end");
  });
  it("an empty log is at its end", () => {
    expect(foldBackTo({ newest: null, view })).toBe("end");
  });
});

describe("repinEnd", () => {
  it("re-pins a log that was at its end when it shrank or its content grew", () => {
    expect(repinEnd({ atEnd: true, scrollTop: 500, scrollHeight: 1200, clientHeight: 300 })).toBe(
      900,
    );
  });
  it("leaves it alone at the end already", () => {
    expect(
      repinEnd({ atEnd: true, scrollTop: 899.5, scrollHeight: 1200, clientHeight: 300 }),
    ).toBeNull();
  });
  it("never moves a log he scrolled up", () => {
    expect(
      repinEnd({ atEnd: false, scrollTop: 100, scrollHeight: 1200, clientHeight: 300 }),
    ).toBeNull();
  });
  it("a log shorter than its box stays at 0", () => {
    expect(
      repinEnd({ atEnd: true, scrollTop: 0, scrollHeight: 200, clientHeight: 300 }),
    ).toBeNull();
  });
});

describe("stillAtEnd", () => {
  it("at the end within 4px", () => {
    expect(stillAtEnd({ gap: 3, ownPin: false })).toBe(true);
  });
  it("the re-pin's own scroll, landing after the log shrank more, stays at the end", () => {
    // The keyboard: pinned at clientHeight 253, the event came at 241.
    expect(stillAtEnd({ gap: 12, ownPin: true })).toBe(true);
  });
  it("any other scroll away from the end leaves it", () => {
    expect(stillAtEnd({ gap: 114, ownPin: false })).toBe(false);
  });
});
