import { describe, expect, it } from "bun:test";
import { WAITING_INK, lastPendingIndex, waitingMark } from "@lianki/debug-chat/waiting-mark";

describe("waiting for the partner: the label only on the last pending line (owner, 2026-11-10)", () => {
  const msgs = [{ from: "agent" }, { from: "owner" }, { from: "owner" }, { from: "owner" }];
  const lastAgent = 0;
  const lastPending = lastPendingIndex(msgs);
  const marks = msgs.map((m, i) =>
    waitingMark({ i, from: m.from, agentOnline: false, lastAgent, lastPending }),
  );

  it("earlier pending lines get a mark, the last the label, answered ones nothing", () => {
    expect(lastPending).toBe(3);
    expect(marks).toEqual([null, "mark", "mark", "label"]);
  });

  it("nothing while the partner is online", () => {
    expect(
      waitingMark({ i: 3, from: "owner", agentOnline: true, lastAgent, lastPending }),
    ).toBeNull();
  });

  it("no pending line when the agent spoke last; none in an empty chat", () => {
    expect(lastPendingIndex([{ from: "owner" }, { from: "agent" }])).toBe(-1);
    expect(lastPendingIndex([])).toBe(-1);
  });

  it("one pending line is the label", () => {
    expect(
      waitingMark({ i: 1, from: "owner", agentOnline: false, lastAgent: 0, lastPending: 1 }),
    ).toBe("label");
  });

  it("its ink is oklch, both themes", () => {
    expect(WAITING_INK).toMatch(/^light-dark\(oklch\(.+\), oklch\(.+\)\)$/);
  });
});
