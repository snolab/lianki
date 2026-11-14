import { describe, expect, it } from "bun:test";
import { RUN_GAP_MS, isOwnVoice, passageStarts, runsOf } from "@lianki/debug-chat/avatar-rules";
import type { ChatMessage } from "@lianki/debug-chat/wire";

const own = (extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id: "one",
  from: "owner",
  source: "stt",
  text: "Words",
  label: "page",
  at: 0,
  ...extra,
});
const starts = (messages: ChatMessage[], seeds = messages.map(() => "same"), nodes?: string[]) =>
  passageStarts(
    messages,
    messages.map((m, i) => ({ seed: seeds[i]!, at: m.at, node: nodes?.[i] })),
  );

describe("own voice passages", () => {
  it("recognizes own speech without treating an undecided enrolled voice as the owner", () => {
    expect(isOwnVoice(own())).toBe(true);
    expect(isOwnVoice(own({ speaker: { decision: "me", voice: "me" } }))).toBe(true);
    expect(isOwnVoice(own({ speaker: { decision: "unknown", reason: "no-print" } }))).toBe(true);
    expect(isOwnVoice(own({ speaker: { decision: "unknown", reason: "short" } }))).toBe(false);
    expect(isOwnVoice(own({ speaker: { decision: "unknown" } }))).toBe(false);
    expect(isOwnVoice(own({ speaker: { decision: "other", voice: "s1" } }))).toBe(false);
    expect(isOwnVoice(own({ from: "friend" }))).toBe(false);
    expect(isOwnVoice(own({ from: "agent" }))).toBe(false);
    expect(isOwnVoice(own({ source: undefined }))).toBe(true);
    expect(isOwnVoice(own({ source: undefined, speaker: { decision: "me" } }))).toBe(true);
  });

  it("joins own speech across avatar presentation changes and keeps message indexes intact", () => {
    const messages = [own(), own({ id: "two", speaker: { decision: "me" } }), own({ id: "three" })];
    expect(runsOf(starts(messages, ["owner", "verified", "owner"]))).toEqual([[0, 1, 2]]);
    expect(messages.map((m) => m.id)).toEqual(["one", "two", "three"]);
    expect(starts([])).toEqual([]);
  });

  it("breaks both sides of non-own speech even when the avatar seeds match", () => {
    for (const middle of [
      own({ speaker: { decision: "other", voice: "s1" } }),
      own({ speaker: { decision: "unknown", reason: "noise" } }),
      own({ from: "friend" }),
    ])
      expect(starts([own(), middle, own()])).toEqual([true, true, true]);
  });

  it("breaks at a person, thread, node, or long time gap", () => {
    expect(starts([own({ sender: { id: "a" } }), own({ sender: { id: "b" } })])).toEqual([
      true,
      true,
    ]);
    expect(starts([own({ sender: { id: "a" } }), own()])).toEqual([true, false]);
    expect(starts([own(), own({ sender: { id: "a" } })])).toEqual([true, false]);
    expect(starts([own({ sender: { id: "a" } }), own({ sender: { id: "a" } })])).toEqual([
      true,
      false,
    ]);
    expect(starts([own({ thread: "a" }), own({ thread: "b" })])).toEqual([true, true]);
    expect(starts([own(), own()], undefined, ["/a", "/b"])).toEqual([true, true]);
    expect(starts([own(), own({ at: RUN_GAP_MS })])).toEqual([true, false]);
    expect(starts([own(), own({ at: RUN_GAP_MS + 1 })])).toEqual([true, true]);
    expect(starts([own(), own({ at: -RUN_GAP_MS - 1 })])).toEqual([true, true]);
    expect(
      passageStarts(
        [own(), own({ at: 11 })],
        [
          { seed: "a", at: 0 },
          { seed: "a", at: 11 },
        ],
        10,
      ),
    ).toEqual([true, true]);
  });

  it("preserves existing non-owner grouping by seed, node and time", () => {
    const agent = (extra: Partial<ChatMessage> = {}) => own({ from: "agent", ...extra });
    expect(starts([agent(), agent(), agent()], ["a", "a", "b"])).toEqual([true, false, true]);
    expect(starts([agent(), agent()], undefined, ["/a", "/b"])).toEqual([true, true]);
    expect(starts([agent(), agent({ at: RUN_GAP_MS + 1 })])).toEqual([true, true]);
    expect(starts([own({ from: "friend" }), own({ from: "friend" })])).toEqual([true, false]);
  });
});
