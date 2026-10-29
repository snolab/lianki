import { describe, expect, test } from "bun:test";
import { createTestD1 } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import type { D1Like } from "@/lib/d1/types";
import { swipeAbStats } from "@/lib/repos/swipeAbD1";
import { restRating } from "@/lib/words/swipe";
import {
  parseParams,
  setSwipeVariant,
  summarizeSwipeAb,
  swipeAbTag,
  swipeVariant,
} from "@/lib/words/swipe-ab";

const memory = () => {
  const m = new Map<string, string>();
  return {
    m,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
  };
};

describe("swipe variant", () => {
  test("no storage, or storage that throws: js, and nothing breaks", () => {
    expect(swipeVariant()).toBe("js");
    setSwipeVariant("native");
    expect(swipeAbTag()).toBe("ab=js");
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(swipeVariant(broken)).toBe("js");
    expect(() => setSwipeVariant("native", broken)).not.toThrow();
    expect(swipeAbTag(broken)).toBe("ab=js");
  });

  test("js unless turned on; remembered", () => {
    const s = memory();
    expect(swipeVariant(s)).toBe("js");
    setSwipeVariant("native", s);
    expect(swipeVariant(s)).toBe("native");
    expect(s.m.get("lk:swipe-ab")).toBe("native");
    setSwipeVariant("js", s);
    expect(swipeVariant(s)).toBe("js");
  });

  test("no storage, or storage that throws: js", () => {
    expect(swipeVariant(null)).toBe("js");
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {},
    };
    expect(swipeVariant(broken)).toBe("js");
    setSwipeVariant("native", broken);
  });

  test("the telemetry tag: variant and a stable device id", () => {
    const s = memory();
    expect(swipeAbTag(s, () => 0.5)).toMatch(/^ab=js;dev=[0-9a-z]{8}$/);
    setSwipeVariant("native", s);
    const tag = parseParams(swipeAbTag(s));
    expect(tag.ab).toBe("native");
    expect(tag.dev).toBe(parseParams(swipeAbTag(s)).dev);
  });
});

test("restRating: the native slip's rest point grades like the detents", () => {
  expect(restRating(10, 44)).toBeNull();
  expect(restRating(44, 44)).toBe(3);
  expect(restRating(88, 44)).toBe(4);
  expect(restRating(-44, 44)).toBe(2);
  expect(restRating(-88, 44)).toBe(1);
});

describe("summarizeSwipeAb", () => {
  const row = (email: string, rating: number | null, finger: number, params: string) => ({
    email,
    rating,
    finger,
    params,
  });
  const rows = [
    row("a@x", 3, 50, "snap=0.75;ab=js;dev=d1"),
    row("a@x", 1, -100, "snap=0.75;ab=js;dev=d1"),
    row("a@x", null, 20, "snap=0.75;ab=js;dev=d1"),
    row("a@x", null, 0, "snap=0.75;ab=js;dev=d1;ev=undo"),
    row("b@x", 4, 90, "scroll-snap;ab=native;dev=d2"),
    row("c@x", 2, -40, "scroll-snap;ab=native;dev=d3"),
    row("d@x", 3, 40, "snap=0.75;coast=30"),
  ];

  test("per variant: swipes, people, grades, cancels, undos, travel", () => {
    const [js, native] = summarizeSwipeAb(rows);
    expect(js).toMatchObject({
      variant: "js",
      swipes: 3,
      users: 1,
      devices: 1,
      grades: [1, 0, 1, 0],
      cancels: 1,
      undos: 1,
      undoRate: 0.5,
      medianTravel: 75,
    });
    expect(js.cancelRate).toBeCloseTo(1 / 3);
    expect(native).toMatchObject({
      swipes: 2,
      users: 2,
      devices: 2,
      grades: [0, 1, 0, 1],
      medianTravel: 65,
    });
  });

  test("swipeAbStats reads the tagged rows from D1", async () => {
    const d1 = createTestD1(testSchema()) as unknown as D1Like;
    await d1.exec(`
      INSERT INTO swipe_log (email, at, finger, v, projected, rating, a, params) VALUES
        ('a@x', '2026-10-29T01:00:00Z', 50, 0.1, 44, 3, 44, 'snap=0.75;ab=js'),
        ('b@x', '2026-10-29T02:00:00Z', 90, 0, 88, 4, 44, 'scroll-snap;ab=native'),
        ('c@x', '2026-10-28T00:00:00Z', 40, 0.1, 44, 3, 44, 'snap=0.75');
    `);
    const { stats, first, last } = await swipeAbStats(d1);
    expect(stats.map((s) => s.swipes)).toEqual([1, 1]);
    expect([first, last]).toEqual(["2026-10-29T01:00:00Z", "2026-10-29T02:00:00Z"]);
  });
});
