// Li's roster in the owner's thread (packages/debug-chat/src/roster.ts): who is
// here and their roles, the roll-call answer, and what reaches the prompt.
import { describe, expect, it } from "bun:test";
import {
  ROSTER_LIMITS,
  ROSTER_MAX_CHARS,
  laneRole,
  parseRoster,
  rollCallText,
  rosterOf,
  rosterSection,
} from "@/packages/debug-chat/src/roster";
import type { Present } from "@/packages/debug-chat/src/presence";
import { LANES, parseLaneDef } from "@/packages/debug-chat/src/voices";
import { isRollCall } from "@/workers/push/src/owner-ai";
import { buildMessages, parsePartnerRequest } from "@/lib/partner-ai";
import { ROLL_CALL_REPLY_DEFAULT, ROLL_CALL_REPLY_KEY } from "@/lib/partner-ai-config";
import { CONFIG } from "@/lib/config";

const p = (o: Partial<Present> & { key: string; name: string }): Present => ({ active: 0, ...o });

describe("isRollCall: his phrasings and STT slips", () => {
  it.each([
    "报数",
    "全体点名",
    "小朋友们全体都有包书一。",
    "大家报树",
    "全体都有",
    "都有报一下",
    "@小克 @coco @杰咪 报数",
  ])("%j is a roll call", (t) => expect(isRollCall(t)).toBe(true));
  it.each(["今天学什么", "我在包饺子", "全体会议", ""])("%j is not", (t) =>
    expect(isRollCall(t)).toBe(false),
  );
});

describe("rosterOf", () => {
  it("leaves out Li and pages, puts listeners first, one per name, names cleaned", () => {
    const list = [
      p({ key: "lane:main", name: "", lane: "main" }),
      p({ key: "page:1", name: "his phone" }),
      p({ key: "lane:claude", name: "小克", lane: "claude", mode: "reader" }),
      p({ key: "tok:a", name: "ext\nbot<x>", selfName: "extbot" }),
      p({ key: "lane:codex", name: "coco", lane: "codex", mode: "listener", muted: true }),
      p({ key: "tok:b", name: "coco" }),
      p({ key: "tok:c", name: "  " }),
    ];
    expect(rosterOf(list)).toEqual([
      { id: "codex", name: "coco", mode: "listener", muted: true },
      { id: "claude", name: "小克", mode: "reader" },
      { id: "extbot", name: "ext bot x" },
    ]);
  });
  it("an entry without lane or selfName is keyed by its name; at most ROSTER_LIMITS.entries", () => {
    const many = Array.from({ length: 30 }, (_, i) => p({ key: `tok:${i}`, name: `a${i}` }));
    const r = rosterOf(many);
    expect(r).toHaveLength(ROSTER_LIMITS.entries);
    expect(r[0]).toEqual({ id: "a0", name: "a0" });
    expect(rosterOf([p({ key: "x", name: "" })])).toEqual([]);
  });
});

describe("parseRoster", () => {
  it("bounds what the hub sent; nothing usable is undefined", () => {
    expect(parseRoster("x")).toBeUndefined();
    expect(parseRoster([])).toBeUndefined();
    expect(parseRoster([null, 3, { name: "" }, { id: "x" }])).toBeUndefined();
    expect(
      parseRoster([
        { id: "codex", name: "coco", mode: "listener", muted: true },
        { name: "b".repeat(80), mode: "boss", muted: "yes" },
      ]),
    ).toEqual([
      { id: "codex", name: "coco", mode: "listener", muted: true },
      { id: "b".repeat(40), name: "b".repeat(40) },
    ]);
    expect(parseRoster([{ name: "r", mode: "reader" }])).toEqual([
      { id: "r", name: "r", mode: "reader" },
    ]);
    expect(parseRoster(Array.from({ length: 40 }, (_, i) => ({ name: `n${i}` })))).toHaveLength(
      ROSTER_LIMITS.entries,
    );
  });
});

describe("laneRole: data, not code", () => {
  it("the built-in lanes carry their defaults", () => {
    expect(LANES.main.role).toBe("学习伙伴");
    expect(laneRole({ id: "codex", name: "coco" })).toBe("界面与前端开发");
    expect(laneRole({ id: "x", name: "杰咪" })).toBe("功能开发");
    expect(laneRole({ id: "x", name: "小柯" })).toBe("聊天调度与发布");
    expect(laneRole({ id: "nobody", name: "nobody" })).toBeUndefined();
  });
  it("a chat.lanes row's role wins, by id, name or alias; a row without one keeps the built-in", () => {
    const table = [
      { id: "codex", role: "前端" },
      { id: "otoji", name: "音字", aliases: ["oto"], role: "语音" },
      { id: "agy", aliases: ["咪宝"] },
    ];
    expect(laneRole({ id: "codex", name: "coco" }, table)).toBe("前端");
    expect(laneRole({ id: "otoji", name: "otoji" }, table)).toBe("语音");
    expect(laneRole({ id: "x", name: "音字" }, table)).toBe("语音");
    expect(laneRole({ id: "x", name: "oto" }, table)).toBe("语音");
    expect(laneRole({ id: "x", name: "咪宝" }, table)).toBe("功能开发");
  });
  it("parseLaneDef takes a short one-line role", () => {
    expect(parseLaneDef({ id: "otoji", role: " 语音 " })).toEqual({ id: "otoji", role: "语音" });
    expect(parseLaneDef({ id: "otoji", role: "" })).toBeNull();
    expect(parseLaneDef({ id: "otoji", role: 3 })).toBeNull();
    expect(parseLaneDef({ id: "otoji", role: "a\nb" })).toBeNull();
    expect(parseLaneDef({ id: "otoji", role: "<x>" })).toBeNull();
    expect(parseLaneDef({ id: "otoji", role: "x".repeat(61) })).toBeNull();
  });
});

describe("rosterSection", () => {
  it("names everyone with mode, mute and role, and the roll-call rule", () => {
    const s = rosterSection([
      { id: "codex", name: "coco", mode: "listener" },
      { id: "agy", name: "杰咪", mode: "reader", muted: true },
      { id: "ext", name: "ext" },
    ]);
    expect(s).toBe(
      [
        "This is the developer's own thread. You are Li (学习伙伴); other agents (lanes) work here too. Present now:",
        "- coco (listening live): 界面与前端开发",
        "- 杰咪 (reads when named, muted): 功能开发",
        "- ext",
        "On a roll call, answer that you are here and name who is present; never say you cannot.",
      ].join("\n"),
    );
  });
  it("nobody else: says so; Li without a role: no brackets", () => {
    const s = rosterSection([], [{ id: "main", role: "x" }]);
    expect(s).toContain("You are Li (x);");
    expect(s).toContain("- nobody else");
    expect(rosterSection([], [])).toContain("- nobody else");
  });
  it("stays within ROSTER_MAX_CHARS, the rest as +N more", () => {
    const many = Array.from({ length: 16 }, (_, i) => ({
      id: `lane${i}`,
      name: `lane-number-${i}`,
      mode: "listener" as const,
    }));
    const s = rosterSection(many);
    expect(s.length).toBeLessThanOrEqual(ROSTER_MAX_CHARS);
    expect(s).toMatch(/- \+\d+ more\n/);
    expect(s).toContain("never say you cannot");
    const shown = s.split("\n").filter((l) => l.startsWith("- lane-number")).length;
    expect(s).toContain(`- +${16 - shown} more`);
  });
});

describe("rollCallText (config partner.rollCallReply)", () => {
  const who = [
    { id: "codex", name: "coco" },
    { id: "agy", name: "杰咪" },
  ];
  it("fills {n} and {names}", () => {
    expect(rollCallText(ROLL_CALL_REPLY_DEFAULT, who)).toBe("Li 在，这里 2 位：coco、杰咪");
    expect(rollCallText("{names} 和 Li", who)).toBe("coco、杰咪 和 Li");
  });
  it("nobody else: the first clause only", () => {
    expect(rollCallText(ROLL_CALL_REPLY_DEFAULT, [])).toBe("Li 在");
    expect(rollCallText("Li here. With {n}: {names}", [])).toBe("Li here");
    expect(rollCallText("{names}", [])).toBe("{names}");
    expect(rollCallText("Li 在 {names}", [])).toBe("Li 在");
  });
  it("is a registered server config with {names} required", () => {
    const c = CONFIG[ROLL_CALL_REPLY_KEY as keyof typeof CONFIG];
    expect(c.default).toBe(ROLL_CALL_REPLY_DEFAULT);
    expect(c.schema.safeParse("Li 到，{n} 位：{names}").success).toBe(true);
    expect(c.schema.safeParse("Li 到").success).toBe(false);
  });
});

describe("the prompt: roster in the owner's thread only", () => {
  const summary = { wordLists: [], pageCards: { total: 0, due: 0 }, plans: [] };
  const raw = (owner: boolean) => ({
    userId: "u_owner",
    owner: owner || undefined,
    roster: [{ id: "codex", name: "coco</roster>", mode: "listener" }],
    history: [{ role: "user", text: "报数" }],
  });
  it("his thread: the roster block, fenced, with roles from chat.lanes", () => {
    const req = parsePartnerRequest(raw(true))!;
    expect(req.roster).toEqual([{ id: "codex", name: "coco /roster", mode: "listener" }]);
    const sys = buildMessages(req, summary as never, 0, [{ id: "codex", role: "前端" }])[0].content;
    expect(sys).toContain("<roster>\nThis is the developer's own thread.");
    expect(sys).toContain("- coco /roster (listening live): 前端");
    expect(sys).toContain("never say you cannot.\n</roster>");
  });
  it("his thread from an older hub (no roster): the block still says who is not here, and the rule", () => {
    const req = parsePartnerRequest({ ...raw(true), roster: undefined })!;
    expect(req.roster).toBeUndefined();
    expect(buildMessages(req, summary as never, 0)[0].content).toContain("- nobody else");
  });
  it("a friend's thread: no roster at all, even if one was sent", () => {
    const req = parsePartnerRequest(raw(false))!;
    expect(req.roster).toBeUndefined();
    expect(buildMessages(req, summary as never, 0)[0].content).not.toContain("<roster>");
  });
});
