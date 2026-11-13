import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { type Fold, type FoldEvent, foldNext } from "@lianki/debug-chat/fold";
import {
  type ChatViewer,
  CHAT_VIEWER_ATTR,
  chatViewerOf,
  chatWanted,
  partnerEntryShown,
  readChatViewer,
} from "@/lib/partner-entry";

// The Learning Partner is always findable (owner, 2026-11-14; docs/dev-debug-widget.md,
// "Always findable"): it can fold, never disappear, and the sidebar always has its row.

const src = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
const ON = { "partner.ai-reply": true };
const OFF = { "partner.ai-reply": false };

describe("chatViewerOf (the root layout's data-chat-viewer)", () => {
  it("a guest is nobody to the chat, flag on or off", () => {
    expect(chatViewerOf(ON, false, false)).toBeNull();
    expect(chatViewerOf(OFF, false, false)).toBeNull();
    expect(chatViewerOf(null, false, false)).toBeNull();
  });
  it("a signed-in user is a partner user only while partner.ai-reply is on", () => {
    expect(chatViewerOf(ON, true, false)).toBe("partner");
    expect(chatViewerOf(OFF, true, false)).toBe("member");
    expect(chatViewerOf({}, true, false)).toBe("member");
  });
  it("a dev holder keeps debug mode as his developer switch", () => {
    expect(chatViewerOf(ON, true, true)).toBe("member");
  });
});

describe("chatWanted: closing never removes a partner user's chat", () => {
  it("debug mode off (the hidden 7/10-tap toggles) leaves the partner's chat on", () => {
    expect(chatWanted(false, true)).toBe(true);
    expect(chatWanted(true, true)).toBe(true);
  });
  it("without the partner, debug mode alone decides (the developer switch, unchanged)", () => {
    expect(chatWanted(true, false)).toBe(true);
    expect(chatWanted(false, false)).toBe(false);
  });
  it("is what DebugEval's chatOn uses", () => {
    expect(src("app/components/DebugEval.tsx")).toContain(
      "const chatOn = () => chatWanted(debugOn(), openRef.current);",
    );
  });
});

describe("no fold step hides the chat", () => {
  const events: FoldEvent[] = [
    { type: "mark" },
    { type: "restore" },
    { type: "minimize" },
    { type: "handle" },
    { type: "dropped", nearest: "left", against: "left" },
    { type: "dropped", nearest: "right", against: null },
  ];
  it("from open or the pill, every event leaves the bar or its pill on screen", () => {
    // Breadth-first over every reachable state: only open and pill, never gone.
    const seen = new Set<string>();
    const queue = [
      { fold: "open" as Fold, edge: "right" as const },
      { fold: "pill" as Fold, edge: "left" as const },
    ];
    while (queue.length) {
      const s = queue.shift()!;
      const key = `${s.fold}:${s.edge}`;
      if (seen.has(key)) continue;
      seen.add(key);
      expect(["open", "pill"]).toContain(s.fold);
      for (const ev of events) queue.push(foldNext(s, ev) as typeof s);
    }
    expect(seen.size).toBe(4);
  });
  it("the menu's Minimize folds to the pill, never further", () => {
    expect(foldNext({ fold: "open", edge: "right" }, { type: "minimize" }).fold).toBe("pill");
    expect(foldNext({ fold: "pill", edge: "right" }, { type: "minimize" }).fold).toBe("pill");
  });
});

describe("the sidebar's Learning Partner row", () => {
  const cases: [ChatViewer, boolean, boolean][] = [
    // viewer, debug mode, shown
    ["partner", false, true],
    ["partner", true, true],
    ["member", true, true],
    ["member", false, false],
    [null, true, false],
    [null, false, false],
  ];
  for (const [viewer, debug, shown] of cases)
    it(`${viewer ?? "guest"}, debug ${debug ? "on" : "off"}: ${shown ? "shown" : "absent"}`, () => {
      expect(partnerEntryShown(viewer, debug)).toBe(shown);
    });

  it("follows partner.ai-reply end to end: on → every signed-in user, off → nothing new", () => {
    expect(partnerEntryShown(chatViewerOf(ON, true, false), false)).toBe(true);
    expect(partnerEntryShown(chatViewerOf(OFF, true, false), false)).toBe(false);
    expect(partnerEntryShown(chatViewerOf(ON, false, false), false)).toBe(false);
  });

  it("reads the attribute back strictly", () => {
    expect(readChatViewer("partner")).toBe("partner");
    expect(readChatViewer("member")).toBe("member");
    expect(readChatViewer("")).toBeNull();
    expect(readChatViewer(null)).toBeNull();
    expect(readChatViewer("owner")).toBeNull();
  });

  it("is wired: the root layout sets the attribute, the drawer rows read it", () => {
    expect(CHAT_VIEWER_ATTR).toBe("data-chat-viewer");
    expect(src("app/layout.tsx")).toContain("data-chat-viewer={viewer ?? undefined}");
    const rows = src("lib/nav/islands/NavRows.tsx");
    expect(rows).toContain("usePartnerEntry()");
    expect(rows).toContain("data-nav-partner");
    expect(rows).not.toContain("useDebugMode");
  });
});
