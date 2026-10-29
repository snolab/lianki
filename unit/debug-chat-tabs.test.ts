import { describe, expect, it } from "bun:test";
import { joinTabs, speakerTab } from "@lianki/debug-chat/debug-chat-tabs";

/** BroadcastChannel in memory: a post reaches every other member, never the sender. */
function bus() {
  const members: { onmessage: ((e: MessageEvent) => void) | null; closed: boolean }[] = [];
  return () => {
    const me = {
      onmessage: null as ((e: MessageEvent) => void) | null,
      closed: false,
      postMessage(data: unknown) {
        for (const m of members) if (m !== me && !m.closed) m.onmessage?.({ data } as MessageEvent);
      },
      close() {
        me.closed = true;
      },
    };
    members.push(me);
    return me;
  };
}

describe("speakerTab", () => {
  it("latest focus wins; ties go to the smaller id; none for no tabs", () => {
    expect(
      speakerTab(
        new Map([
          ["a", 1],
          ["b", 5],
        ]),
      ),
    ).toBe("b");
    expect(
      speakerTab(
        new Map([
          ["b", 0],
          ["a", 0],
        ]),
      ),
    ).toBe("a");
    expect(speakerTab(new Map())).toBeUndefined();
  });
});

describe("joinTabs: one tab reads replies aloud", () => {
  it("the most recently focused tab speaks; a focused tab always does", () => {
    const chan = bus();
    let t = 100;
    const focus = { a: false, b: false };
    const a = joinTabs(
      "a",
      chan(),
      () => focus.a,
      () => t,
    );
    const b = joinTabs(
      "b",
      chan(),
      () => focus.b,
      () => t,
    );
    // Neither ever focused: the smaller id, and only it.
    expect([a.isSpeaker(), b.isSpeaker()]).toEqual([true, false]);
    t = 200;
    b.focus();
    expect([a.isSpeaker(), b.isSpeaker()]).toEqual([false, true]);
    focus.a = true;
    expect(a.isSpeaker()).toBe(true);
    focus.a = false;
    t = 300;
    a.focus();
    expect([a.isSpeaker(), b.isSpeaker()]).toEqual([true, false]);
    // The speaker leaves: the other takes over.
    a.leave();
    expect(b.isSpeaker()).toBe(true);
  });

  it("a newcomer learns the others' focus times; foreign or malformed posts are ignored", () => {
    const chan = bus();
    const a = joinTabs(
      "a",
      chan(),
      () => true,
      () => 500,
    );
    const raw = chan();
    const c = joinTabs(
      "c",
      chan(),
      () => false,
      () => 600,
    );
    expect(c.isSpeaker()).toBe(false); // a answered hello with 500 > 0
    raw.postMessage(null);
    raw.postMessage({ type: "focus", tab: 7, at: 1 });
    raw.postMessage({ type: "focus", tab: "c", at: 9_999 });
    expect(c.isSpeaker()).toBe(false);
    expect(a.isSpeaker()).toBe(true);
  });
});
