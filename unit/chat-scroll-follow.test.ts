import { describe, expect, test } from "bun:test";
import { createScrollFollow, type FollowBox } from "../packages/debug-chat/src/scroll-follow";

function fixture() {
  let top = 0;
  let available = true;
  let clampAt = Infinity;
  const box: FollowBox = {
    scrollHeight: 100,
    clientHeight: 100,
    get scrollTop() {
      return top;
    },
    set scrollTop(value) {
      top = Math.max(0, Math.min(value, box.scrollHeight - box.clientHeight, clampAt));
    },
  };
  const following = { current: true };
  const pinned = { current: null as number | null };
  const follow = createScrollFollow({ box: () => (available ? box : null), following, pinned });
  return {
    box,
    following,
    pinned,
    follow,
    available: (value: boolean) => {
      available = value;
    },
    clamp: () => {
      box.scrollTop = top;
    },
    clampAt: (value: number) => {
      clampAt = value;
    },
  };
}

describe("chat tail follow", () => {
  test("empty log follows every history batch and later image/card growth", () => {
    const { box, follow, following, pinned } = fixture();
    expect(follow.scroll()).toBe(true);
    expect(follow.pin()).toBe(true);
    expect(pinned.current).toBe(0);
    for (const height of [2400, 4800, 5300, 5900]) {
      box.scrollHeight = height;
      // A passive geometry event can precede the queued pin.
      expect(follow.scroll()).toBe(true);
      expect(follow.pin()).toBe(true);
      expect(box.scrollTop).toBe(height - box.clientHeight);
      expect(follow.scroll()).toBe(true);
      expect(follow.scroll()).toBe(true);
      expect(following.current).toBe(true);
    }
  });

  test("upward intent wins before queued history/resize and delayed own scroll events", () => {
    const { box, follow, following, pinned } = fixture();
    box.scrollHeight = 1200;
    follow.pin();
    follow.away();
    expect(following.current).toBe(false);
    expect(pinned.current).toBeNull();
    // The queued event still reports the original programmatic bottom.
    expect(follow.scroll()).toBe(false);
    expect(follow.scroll()).toBe(false);
    box.scrollHeight = 1800;
    expect(follow.pin()).toBe(false);
    expect(follow.scroll()).toBe(false);
    expect(box.scrollTop).toBe(1100);
    box.scrollTop = 800;
    expect(follow.scroll()).toBe(false);
    box.scrollHeight = 2400;
    expect(follow.scroll()).toBe(false);
    expect(follow.pin()).toBe(false);
    // A real return to the newest visible row restores normal follow.
    box.scrollTop = 2300;
    expect(follow.scroll()).toBe(true);
    expect(follow.pin()).toBe(true);
  });

  test("ordinary upward movement revokes following after geometry settles", () => {
    const { box, follow, pinned } = fixture();
    box.scrollHeight = 1000;
    follow.pin();
    box.scrollTop = 500;
    expect(follow.scroll()).toBe(false);
    expect(pinned.current).toBeNull();
    expect(follow.pin()).toBe(false);
    box.scrollTop = 898;
    expect(follow.scroll()).toBe(true);
  });

  test("history ending with an owner line cannot force return; explicit return can", () => {
    const { box, follow, following } = fixture();
    box.scrollHeight = 1000;
    follow.pin();
    follow.away();
    box.scrollTop = 300;
    expect(follow.scroll()).toBe(false);
    // The controller deliberately takes geometry and intent only, no sender.
    box.scrollHeight = 1500;
    expect(follow.pin()).toBe(false);
    expect(box.scrollTop).toBe(300);
    expect(follow.pin(true)).toBe(true);
    expect(box.scrollTop).toBe(1400);
    expect(following.current).toBe(true);
    expect(follow.scroll()).toBe(true);
  });

  test("passive viewport changes, browser clamping and content shrink preserve follow", () => {
    const f = fixture();
    f.box.scrollHeight = 1000;
    f.follow.pin();
    f.box.clientHeight = 200;
    f.clamp(); // Browser clamps on viewport resize.
    expect(f.follow.scroll()).toBe(true);
    expect(f.follow.pin()).toBe(true);
    expect(f.box.scrollTop).toBe(800);
    f.box.scrollHeight = 150;
    f.clamp();
    expect(f.follow.scroll()).toBe(true);
    expect(f.follow.pin()).toBe(true);
    expect(f.box.scrollTop).toBe(0);
    f.box.scrollHeight = 900;
    f.clampAt(450);
    expect(f.follow.pin()).toBe(true);
    expect(f.pinned.current).toBe(450);
    expect(f.follow.scroll()).toBe(true);
  });

  test("null boxes and thread resets discard old gesture and geometry state", () => {
    const f = fixture();
    f.available(false);
    expect(f.follow.pin()).toBe(false);
    expect(f.follow.pin(true)).toBe(false);
    expect(f.follow.scroll()).toBe(true);
    f.follow.away();
    expect(f.follow.scroll()).toBe(false);
    f.follow.reset();
    expect(f.following.current).toBe(true);
    expect(f.pinned.current).toBeNull();
    f.available(true);
    f.box.scrollHeight = 1800;
    f.follow.pin();
    f.follow.away();
    f.follow.reset();
    expect(f.follow.scroll()).toBe(true);
    expect(f.follow.pin()).toBe(true);
    expect(f.box.scrollTop).toBe(1700);
  });
});
