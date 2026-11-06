import { describe, expect, it } from "bun:test";
import type { Ask, AskAnswer } from "@lianki/debug-chat/ask";
import {
  JUMP_INSET_PX,
  asksAbove,
  isAbove,
  jumpLabel,
  jumpTop,
  nearestAbove,
  openAskIds,
} from "@lianki/debug-chat/ask-above";

const ask = (askId: string, expiresAt?: number): Ask => ({
  askId,
  questions: [{ id: "q1", question: "Deploy?", options: [{ id: "o1", label: "Yes" }] }],
  ...(expiresAt === undefined ? {} : { expiresAt }),
});
const answer: AskAnswer = {
  choices: { q1: ["o1"] },
  source: "tap",
  thread: "owner",
  label: "/words iPhone",
  at: 5,
};

describe("openAskIds: which cards count", () => {
  it("only open asks, oldest first", () => {
    const list = [
      { id: "plain" },
      { id: "a", ask: ask("a") },
      { id: "done", ask: ask("d"), answer },
      { id: "gone", ask: ask("g", 100) },
      { id: "later", ask: ask("l", 2000) },
    ];
    expect(openAskIds(list, 1000)).toEqual(["a", "later"]);
  });
  it("an ask past its deadline stops counting, with no event needed", () => {
    const list = [{ id: "a", ask: ask("a", 1000) }];
    expect(openAskIds(list, 999)).toEqual(["a"]);
    expect(openAskIds(list, 1000)).toEqual([]);
  });
});

describe("isAbove", () => {
  it("out of the view with its bottom over the top edge", () => {
    expect(isAbove({ isIntersecting: false, bottom: 90, rootTop: 100 })).toBe(true);
    expect(isAbove({ isIntersecting: false, bottom: 100, rootTop: 100 })).toBe(true);
  });
  it("a card below the view (he scrolled up) is not above", () => {
    expect(isAbove({ isIntersecting: false, bottom: 900, rootTop: 100 })).toBe(false);
  });
  it("a card with any part in view is not above, its top may be", () => {
    expect(isAbove({ isIntersecting: true, bottom: 120, rootTop: 100 })).toBe(false);
  });
});

describe("asksAbove and the count", () => {
  const open = ["a", "b", "c"];
  it("keeps the log's order, and counts", () => {
    const list = asksAbove(open, new Set(["c", "a"]));
    expect(list).toEqual(["a", "c"]);
    expect(list.length).toBe(2);
  });
  it("an answer (here or on another device) clears the card at once", () => {
    const above = new Set(["a", "b"]);
    const messages = [
      { id: "a", ask: ask("a") },
      { id: "b", ask: ask("b") },
    ];
    expect(asksAbove(openAskIds(messages, 0), above)).toEqual(["a", "b"]);
    // The hub's `answered` stamps `answer` on the line (DebugEval); the observer has not spoken yet.
    const stamped = [messages[0]!, { ...messages[1]!, answer }];
    expect(asksAbove(openAskIds(stamped, 0), above)).toEqual(["a"]);
    expect(asksAbove(openAskIds([{ ...messages[0]!, answer }, stamped[1]!], 0), above)).toEqual([]);
  });
});

describe("nearestAbove: where each tap goes", () => {
  it("the newest above the view, then the one before it", () => {
    const above = new Set(["a", "b", "c"]);
    const open = ["a", "b", "c", "visible"];
    const first = nearestAbove(asksAbove(open, above));
    expect(first).toBe("c");
    above.delete(first!);
    expect(nearestAbove(asksAbove(open, above))).toBe("b");
  });
  it("nothing above, nothing to go to", () => {
    expect(nearestAbove([])).toBeNull();
  });
});

describe("jumpTop", () => {
  it("puts the line clear of the top fade", () => {
    // Line 500px over the log's top edge, the log at scrollTop 1000.
    expect(jumpTop({ scrollTop: 1000, lineTop: -400, rootTop: 100 })).toBe(500 - JUMP_INSET_PX);
  });
  it("never under 0", () => {
    expect(jumpTop({ scrollTop: 10, lineTop: 90, rootTop: 100 })).toBe(0);
  });
});

describe("jumpLabel", () => {
  it("fills in the count", () => {
    expect(jumpLabel("Above: {count}", 3)).toBe("Above: 3");
  });
});
