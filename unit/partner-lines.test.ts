import { afterEach, describe, expect, it } from "bun:test";
import { memberNames, partnerHistoryLine, senderName, stripLeadTags } from "@/lib/partner-lines";
import { PARTNER_AI_LABEL } from "@/lib/partner-ai-config";
import { setLaneTable } from "@/packages/debug-chat/src/voices";

/** Li speaks only as itself (lib/partner-lines.ts; docs/partner-ai.md, "Speaking as itself"). */
afterEach(() => setLaneTable([]));

describe("stripLeadTags", () => {
  it("2026-11-17: Li's reply opening with 【claude】 loses the tag", () => {
    expect(
      stripLeadTags(
        "【claude】Happy to build it, but it's a lot for one go — I'd split it: 1. **M1 (today):** …",
      ),
    ).toBe("Happy to build it, but it's a lot for one go — I'd split it: 1. **M1 (today):** …");
  });

  it("any leading 【…】, several, in bold, with punctuation after; not one in the middle", () => {
    expect(stripLeadTags("【unknown-token】 hi")).toBe("hi");
    expect(stripLeadTags(" 【Li】【coco】：你好")).toBe("你好");
    expect(stripLeadTags("**【小克】** — ok")).toBe("ok");
    expect(stripLeadTags("看【这个】词")).toBe("看【这个】词");
    expect(stripLeadTags("【】")).toBe("");
  });

  it("[name] and name: only for a member's name", () => {
    expect(stripLeadTags("[claude] ok")).toBe("ok");
    expect(stripLeadTags("[哈基米]：好的")).toBe("好的");
    expect(stripLeadTags("Coco: sure")).toBe("sure");
    expect(stripLeadTags("**Li:** hi")).toBe("hi");
    expect(stripLeadTags("Learning Partner AI: hi")).toBe("hi");
    expect(stripLeadTags("[1] first point")).toBe("[1] first point");
    expect(stripLeadTags("Note: this is fine")).toBe("Note: this is fine");
    expect(stripLeadTags("plain text")).toBe("plain text");
  });

  it("config rows and the live table add names", () => {
    expect(stripLeadTags("[robo] hi")).toBe("[robo] hi");
    expect(stripLeadTags("[robo] hi", [{ id: "robo" }])).toBe("hi");
    expect(stripLeadTags("Robby: hi", [{ id: "robo", name: "Robby" }])).toBe("hi");
    expect(stripLeadTags("rb: hi", [{ id: "robo", aliases: ["rb"] }])).toBe("hi");
    setLaneTable([{ id: "zed" }]);
    expect(stripLeadTags("[zed] hi")).toBe("hi");
  });

  it("stops after a bounded number of tags", () => {
    expect(stripLeadTags("【a】".repeat(10) + "x")).toBe("【a】【a】x");
  });
});

describe("memberNames", () => {
  it("built-in ids, names and aliases, and Li's own, lower case", () => {
    const n = memberNames();
    for (const x of ["claude", "小克", "codex", "coco", "agy", "哈基米", "main", "li"])
      expect(n.has(x)).toBe(true);
    expect(n.has(PARTNER_AI_LABEL.toLowerCase())).toBe(true);
    expect(n.has("")).toBe(false);
  });
});

describe("partnerHistoryLine", () => {
  it("his and a friend's lines as user, unchanged", () => {
    expect(partnerHistoryLine({ from: "owner", text: "【claude】hi" })).toEqual({
      role: "user",
      text: "【claude】hi",
    });
    expect(partnerHistoryLine({ from: "friend", text: "hello" })).toEqual({
      role: "user",
      text: "hello",
    });
  });

  it("Li's own as assistant, a stray tag taken off", () => {
    expect(
      partnerHistoryLine({
        from: "agent",
        label: PARTNER_AI_LABEL,
        lane: "main",
        text: "【claude】ok",
      }),
    ).toEqual({ role: "assistant", text: "ok" });
  });

  it("2026-11-17: a 【claude】 lane line is attributed as user, never as Li's", () => {
    expect(
      partnerHistoryLine({ from: "agent", label: "main lane", text: "【claude】PR #990 merged." }),
    ).toEqual({ role: "user", text: "(agent 小克 said: PR #990 merged.)" });
    expect(partnerHistoryLine({ from: "agent", label: "x", lane: "codex", text: "done" })).toEqual({
      role: "user",
      text: "(agent coco said: done)",
    });
  });

  it("senderName: token lane, lane, label, else agent", () => {
    expect(senderName({ from: "agent", text: "【bot】hi", tokenLane: "bot" })).toBe("bot");
    expect(senderName({ from: "agent", text: "hi", lane: "main" })).toBe("main");
    expect(senderName({ from: "agent", text: "hi", label: "ETA timer (automatic)" })).toBe(
      "ETA timer (automatic)",
    );
    expect(senderName({ from: "agent", text: "hi" })).toBe("agent");
    expect(senderName({ from: "agent", text: "hi", label: "  " })).toBe("agent");
  });
});
