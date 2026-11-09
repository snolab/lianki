import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { parkedOf } from "@/lib/progress-tree";
import { EtaList } from "@lianki/debug-chat/EtaBar";
import { isParked, parkMark } from "@lianki/debug-chat/eta";
import { focusRow, parkedBar } from "@lianki/debug-chat/gantt-view";
import { CHAT_STRINGS_EN } from "@lianki/debug-chat/wire";

const MIN = 60_000;
const NOW = 1_800_000_000_000;

describe("parked tasks: waiting for the owner, blocked (owner, 2026-11-10)", () => {
  it("parkedOf: blocked, waiting-owner, an open decision nobody works on", () => {
    expect(parkedOf({ status: "blocked", kind: "task" }, false)).toBe("blocked");
    expect(parkedOf({ status: "waiting-owner", kind: "task" }, true)).toBe("owner");
    expect(parkedOf({ status: "waiting", kind: "decision" }, true)).toBe("owner");
    expect(parkedOf({ status: "doing", kind: "decision" }, true)).toBeUndefined();
    expect(parkedOf({ status: "doing", kind: "task" }, true)).toBeUndefined();
    expect(parkedOf({ status: "waiting", kind: "task" }, false)).toBeUndefined();
    expect(parkedOf({ status: "done", kind: "task" }, true)).toBeUndefined();
  });

  it("the red mark: ? for a decision, ! otherwise, only while waiting for the owner", () => {
    expect(parkMark({ parked: "owner" })).toBe("!");
    expect(parkMark({ parked: "owner", question: true })).toBe("?");
    expect(parkMark({ parked: "blocked" })).toBeNull();
    expect(parkMark({ parked: "owner", done: true })).toBeNull();
    expect(isParked({ parked: "blocked" })).toBe(true);
    expect(isParked({})).toBe(false);
  });

  it("a parked task is never the row the view centres on", () => {
    const rows = [{ at: NOW + 5 * MIN, parked: "owner" }, { at: NOW + 20 * MIN }];
    expect(focusRow(rows, NOW)).toBe(1);
  });

  it("the hollow bar: hatched, an edge, no fill colour of its own", () => {
    const b = parkedBar("oklch(0.6 0.1 250 / 0.2)", "oklch(0.4 0 0)");
    expect(b.background).toContain("repeating-linear-gradient");
    expect(b.outline).toContain("1px solid");
  });

  it("the list: hatched, no fill, a red mark with its label, a reminder time", () => {
    const html = renderToString(
      createElement(EtaList, {
        tasks: [
          {
            id: "/a",
            title: "Pick a name",
            start: NOW - 10 * MIN,
            at: NOW + 9 * 60 * MIN,
            pct: 50,
            parked: "owner",
            question: true,
          },
          { id: "/b", title: "Running", start: NOW - 10 * MIN, at: NOW + 20 * MIN, pct: 50 },
        ],
        now: NOW,
        strings: CHAT_STRINGS_EN,
      }),
    ).replace(/<!-- -->/g, "");
    expect(html).toContain('data-state="parked"');
    expect(html).toContain('aria-label="Waiting for you"');
    expect(html).toMatch(/data-testid="debug-chat-eta-mark"[^>]*>\?</);
    expect(html).toContain("reminder in 9H");
    // Only the running row has a progress fill.
    expect(html.match(/data-testid="debug-chat-eta-fill"/g)?.length).toBe(1);
  });
});
