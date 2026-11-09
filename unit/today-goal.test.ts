import { describe, expect, it } from "bun:test";
import { doneIn, dueNow, goal, localMidnight, shownLists } from "@/lib/today/goal";
import { FLAGS } from "@/lib/flags";
import { APP_NAV } from "@/lib/app-nav";
import { isAppRoute } from "@/lib/app-locale";

/** /today: one number, the cards left today, from /words's own counts. */
describe("today's goal", () => {
  const lists = [
    { id: "a", source: "ja-n5", due: 5 },
    { id: "b", source: "group:x", due: 9 },
    { id: "c", source: "alphabet:kana", due: 7 },
    { id: "d", source: "ja-n4", due: 2 },
  ];
  it("counts the lists /words shows: catalog lists, not groups or /alphabet", () => {
    const shown = shownLists(lists, new Set(["ja-n5", "ja-n4"]));
    expect(shown.map((l) => l.id)).toEqual(["a", "d"]);
    expect(dueNow(shown)).toBe(7);
  });
  it("without the catalog, every list but groups", () => {
    expect(shownLists(lists, null).map((l) => l.id)).toEqual(["a", "c", "d"]);
  });
  it("done is summed over the shown lists only", () => {
    const shown = shownLists(lists, new Set(["ja-n5", "ja-n4"]));
    expect(doneIn(shown, { a: 3, c: 10, d: 1 })).toBe(4);
  });
  it("the share of the day done; nothing left reads as complete", () => {
    expect(goal(6, 2)).toEqual({ left: 6, done: 2, share: 0.25 });
    expect(goal(0, 0).share).toBe(1);
    expect(goal(0, 9).share).toBe(1);
    expect(goal(-3, Number.NaN)).toEqual({ left: 0, done: 0, share: 1 });
  });
  it("the day starts at the local midnight", () => {
    const now = new Date(2026, 10, 10, 15, 30);
    const m = new Date(localMidnight(now));
    expect([m.getHours(), m.getMinutes(), m.getDate()]).toEqual([0, 0, 10]);
  });
  it("ships on, for everyone, in the rail behind its flag, as an app route", () => {
    const f = FLAGS["today.goal"] as { default: boolean; audience?: string };
    expect(f.default).toBe(true);
    expect(f.audience).toBeUndefined();
    expect(APP_NAV.find((n) => n.key === "today")).toMatchObject({
      href: "/today",
      flag: "today.goal",
    });
    expect(isAppRoute("/today")).toBe(true);
  });
});
