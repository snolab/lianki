/**
 * The connection chip's states (packages/debug-chat/src/link-state.ts): remote
 * code on this page, and whether the agent has the page selection.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import {
  DELIVERY,
  EVAL_LINK_STATES,
  SELECTION_STATES,
  evalLink,
  evalSessions,
  selectionState,
  timeLeft,
} from "@lianki/debug-chat/link-state";
import { UI_EN, UI_ZH, uiStrings } from "@lianki/debug-chat/ui-strings";
import { CHAT_LOCALES } from "@lianki/debug-chat/chat-ui-locales";

const NOW = 1_000_000;
const HOUR = 3_600_000;
const grant = (o: { pages?: string[]; until?: number; scope?: string } = {}) => ({
  pair: "p1",
  label: "main lane",
  scope: o.scope ?? "eval",
  until: o.until ?? NOW + 8 * HOUR,
  ...(o.pages ? { pages: o.pages } : {}),
});

describe("remote code on this page", () => {
  const at = (socket: "opening" | "open" | "closed", sessions = [grant()], debug = true) =>
    evalLink({ debug, socket, sessions, self: "tab-here", now: NOW });

  it("all four states", () => {
    expect(EVAL_LINK_STATES).toEqual(["off", "connecting", "connected", "disconnected"]);
    expect(at("open", [grant()], false)).toBe("off");
    expect(at("open", [])).toBe("off");
    expect(at("opening")).toBe("connecting");
    expect(at("open")).toBe("connected");
    expect(at("closed")).toBe("disconnected");
  });

  it("a live grant that leaves this page out reads disconnected (the reload case)", () => {
    expect(at("open", [grant({ pages: ["tab-before-restart"] })])).toBe("disconnected");
    expect(at("open", [grant({ pages: ["tab-here"] })])).toBe("connected");
    // An expired grant or a chat grant does not count.
    expect(at("open", [grant({ until: NOW - 1 })])).toBe("off");
    expect(at("open", [grant({ scope: "chat" })])).toBe("off");
  });

  it("lists the eval grants with whether each reaches this page", () => {
    const list = evalSessions(
      [grant(), grant({ pages: ["x"] }), grant({ scope: "chat" })],
      "tab-here",
      NOW,
    );
    expect(list.map((s) => s.here)).toEqual([true, false]);
    expect(evalSessions(undefined, undefined, NOW)).toEqual([]);
    expect(evalSessions([grant({ pages: ["x"] })], undefined, NOW)[0]?.here).toBe(false);
  });
});

describe("the page selection", () => {
  const line = (from: string, at: number, context?: unknown) => ({ from, at, context });
  const sel = { selection: "some text" };

  it("all four states", () => {
    expect(SELECTION_STATES).toEqual(["none", "pending", "seen", "failed"]);
    expect(selectionState({ attached: false, lines: [], listeners: 1 })).toBe("none");
    expect(selectionState({ attached: true, lines: [], listeners: 1 })).toBe("pending");
    const sent = [line("owner", 10, sel)];
    expect(selectionState({ attached: false, lines: sent, listeners: 1 })).toBe("pending");
    expect(selectionState({ attached: false, lines: sent, listeners: 0 })).toBe("failed");
    expect(
      selectionState({ attached: false, lines: [...sent, line("agent", 11)], listeners: 0 }),
    ).toBe("seen");
    expect(selectionState({ attached: false, lines: sent, beatAt: 12, listeners: 1 })).toBe("seen");
    expect(selectionState({ attached: true, lines: sent, sendFailed: true, listeners: 1 })).toBe(
      "failed",
    );
  });

  it("only the newest line carrying a selection counts", () => {
    const lines = [line("owner", 10, sel), line("agent", 11), line("owner", 12, sel)];
    expect(selectionState({ attached: false, lines, beatAt: 11, listeners: 1 })).toBe("pending");
    // An agent line before it, or a plain owner line after it, does not see it.
    expect(
      selectionState({
        attached: false,
        lines: [line("agent", 5), line("owner", 10, sel), line("owner", 11)],
        listeners: 1,
      }),
    ).toBe("pending");
  });

  it("names the shared delivery nouns", () => {
    expect(DELIVERY).toEqual(["sent", "delivered", "seen", "handled", "failed"]);
  });
});

describe("the chip's words", () => {
  it("time left", () => {
    expect(timeLeft(HOUR, UI_EN)).toBe("1 hour");
    expect(timeLeft(5 * HOUR, UI_EN)).toBe("5 hours");
    expect(timeLeft(30 * 24 * HOUR - 1000, UI_EN)).toBe("30 days");
    expect(timeLeft(29.6 * 24 * HOUR, UI_ZH)).toBe("30 天");
    expect(timeLeft(-5, UI_EN)).toBe("1 hour");
  });

  it("every locale has every state's word and tip, and keeps {time}", () => {
    for (const loc of CHAT_LOCALES) {
      const s = uiStrings(loc);
      for (const k of [
        "linkChip",
        "linkEval",
        "linkSel",
        "evalOff",
        "evalConnecting",
        "evalConnected",
        "evalDisconnected",
        "evalOffTip",
        "evalConnectingTip",
        "evalConnectedTip",
        "evalDisconnectedTip",
        "selNone",
        "selPending",
        "selSeen",
        "selFailed",
        "selNoneTip",
        "selPendingTip",
        "selSeenTip",
        "selFailedTip",
        "linkReachAll",
        "linkReachHere",
        "linkReachOther",
        "linkEnd",
      ] as const)
        expect(s[k].trim().length).toBeGreaterThan(0);
      expect(s.linkLeft).toContain("{time}");
    }
  });

  it("the chip's colours are theme tokens in oklch, and End revokes", () => {
    const src = readFileSync("packages/debug-chat/src/LinkChip.tsx", "utf8");
    expect(src).not.toMatch(/#[0-9a-fA-F]{3,6}\b|rgba?\(/);
    expect(src).toContain("var(--lk-primary");
    expect(src).toContain("var(--lk-seal-off");
    const host = readFileSync("app/components/DebugEval.tsx", "utf8");
    expect(host).toContain("onEnd: (pair) => {");
    expect(host).toContain('answer("revoke", s)');
  });
});
