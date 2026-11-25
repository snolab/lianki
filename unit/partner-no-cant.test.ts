import { describe, expect, it } from "bun:test";
import {
  OwnerAi,
  holdsWord,
  isDevLine,
  isStudyLine,
  namesAgent,
  type OwnerLine,
} from "@/workers/push/src/owner-ai";
import {
  OWNER_AGENT_NAMES_KEY,
  OWNER_DEV_WORDS_KEY,
  OWNER_STUDY_WORDS_KEY,
  PARTNER_SYSTEM_PROMPT,
  PARTNER_SYSTEM_PROMPT_KEY,
} from "@/lib/partner-ai-config";
import { buildMessages, rulesOf, staticPrompt, SYSTEM_PROMPT } from "@/lib/partner-ai";
import { rosterSection } from "@/packages/debug-chat/src/roster";
import { CONFIG, defaultConfig } from "@/lib/config";

/**
 * Owner, 2026-11-26: Li never says it cannot; a line for another agent, or a
 * dev/ops request, gets no reply from Li (the agents handle it; Li only
 * polishes it); Li answers his study lines.
 */

/** Refusal / limit phrasing that must never be in Li's rules (any language). */
const REFUSAL =
  /\bcannot\b|can't|can not|\bunable\b|not my (job|role|task)|not able|不是我的活|做不到|不能|无法|没办法|我只(能|会|帮)|只帮你|できません/i;

function harness(config: Record<string, unknown> = {}) {
  const live = new Map<number, () => void>();
  let n = 0;
  const replies: string[] = [];
  const logs: string[] = [];
  const ai = new OwnerAi<null>({
    now: () => 1_000_000,
    timer: {
      set: (f: () => void) => {
        live.set(++n, f);
        return n;
      },
      clear: (h: unknown) => void live.delete(h as number),
    },
    flag: async () => true,
    config: async (k) => config[k],
    aiOn: async () => true,
    agentAt: () => 0,
    laneAt: () => 0,
    log: (s) => void logs.push(s),
    reply: async (l) => void replies.push(l.id),
    present: async () => {},
  });
  const say = async (id: string, text: string, extra: Partial<OwnerLine> = {}) => {
    await ai.line({ id, text, at: 1, ...extra }, null);
    for (const f of [...live.values()]) f();
    live.clear();
  };
  const reason = (id: string) =>
    logs
      .map((s) => JSON.parse(s) as { msg: string; id: string; reason?: string })
      .find((o) => o.id === id)?.reason;
  return { say, replies, reason };
}

describe("Li's reply gate in the owner's thread", () => {
  it("a line naming 吉米 with a dev request: Li stays silent", async () => {
    const h = harness();
    await h.say("j1", "这个语音同步实验和 Cloudflare 计费，吉米你看一下");
    await h.say("j2", "让吉米把这个部署了");
    expect(h.replies).toEqual([]);
    expect(h.reason("j2")).toBe("names-agent");
  });

  it("every other agent's name keeps Li silent, Latin names as whole words", async () => {
    for (const t of [
      "哈基米帮我查一下",
      "coco 看看这个页面",
      "问问 codex",
      "小克在吗",
      "claude, check this",
      "mimiai 你来",
      "agy 去做",
    ])
      expect(namesAgent(t)).toBe(true);
    expect(namesAgent("今天的单词表")).toBe(false);
    // Not inside a longer word.
    expect(holdsWord("I like coconuts", ["coco"])).toBe(false);
  });

  it("a dev/ops request naming nobody: silent (polish only), not a refusal", async () => {
    const h = harness();
    await h.say("d1", "把 worker 重新部署一下");
    await h.say("d2", "Cloudflare 这个月计费多少");
    await h.say("d3", "fix the bug in the PR");
    expect(h.replies).toEqual([]);
    expect(h.reason("d1")).toBe("dev-request");
    expect(isDevLine("print this")).toBe(false);
  });

  it("study lines get an answer: 今日目标, 单词表, due cards, language questions", async () => {
    const h = harness();
    await h.say("s1", "今日目标是什么");
    await h.say("s2", "我的单词表还剩多少没背");
    await h.say("s3", "how many cards are due today?");
    await h.say("s4", "「さっそく」是什么意思");
    expect(h.replies).toEqual(["s1", "s2", "s3", "s4"]);
  });

  it("any other unaddressed line: polish only, no reply; addressed to Li: answered", async () => {
    const h = harness();
    await h.say("o1", "今天天气不错");
    expect(h.replies).toEqual([]);
    expect(h.reason("o1")).toBe("off-topic");
    await h.say("o2", "Li，你好");
    expect(h.replies).toEqual(["o2"]);
    // Even addressed to Li, a dev request or another agent's line is theirs.
    await h.say("o3", "Li，帮我部署一下");
    await h.say("o4", "Li，叫吉米来");
    expect(h.replies).toEqual(["o2"]);
  });

  it("the lists are live config (partner.otherAgentNames, devWords, studyWords)", async () => {
    const h = harness({
      [OWNER_AGENT_NAMES_KEY]: ["小镀"],
      [OWNER_DEV_WORDS_KEY]: ["上架"],
      [OWNER_STUDY_WORDS_KEY]: ["听写"],
    });
    await h.say("c1", "小镀你来");
    await h.say("c2", "这个包上架了吗");
    await h.say("c3", "来一轮听写");
    expect(h.replies).toEqual(["c3"]);
    for (const k of [OWNER_AGENT_NAMES_KEY, OWNER_DEV_WORDS_KEY, OWNER_STUDY_WORDS_KEY])
      expect(k in CONFIG).toBe(true);
    expect(isStudyLine("来一轮听写")).toBe(false);
  });
});

describe("Li's rules: no refusal phrasing, aware of the others", () => {
  it("the default prompt never lists limits or says it cannot", () => {
    expect(SYSTEM_PROMPT).toBe(PARTNER_SYSTEM_PROMPT);
    expect(SYSTEM_PROMPT).not.toMatch(REFUSAL);
    expect(staticPrompt({ owner: true })).not.toMatch(REFUSAL);
  });

  it("it knows others are in the chat and hands off in one line", () => {
    expect(SYSTEM_PROMPT).toContain("shared chat");
    expect(SYSTEM_PROMPT).toContain("closest workable option");
    expect(SYSTEM_PROMPT).toContain("say who handles it");
  });

  it("the presence context (roster) goes in with no refusal phrasing", () => {
    const roster = rosterSection(
      [
        { name: "哈基米", id: "agy", mode: "live" },
        { name: "coco", id: "codex" },
      ] as never,
      [{ id: "agy", role: "frontend and deploys" }],
    );
    expect(roster).not.toMatch(REFUSAL);
    const sys = buildMessages(
      { userId: "u", owner: true, history: [{ role: "user", text: "单词表" }] } as never,
      { wordLists: [], pageCards: { total: 0, due: 0 }, plans: [] },
      0,
      [],
    )[0]!.content;
    expect(sys).toContain("<roster>");
    expect(sys).not.toMatch(REFUSAL);
  });

  it("the prompt is live config (partner.systemPrompt), bounded, default otherwise", () => {
    expect(
      defaultConfig()[PARTNER_SYSTEM_PROMPT_KEY as keyof ReturnType<typeof defaultConfig>],
    ).toBe(PARTNER_SYSTEM_PROMPT);
    expect(rulesOf("Be kind.")).toBe("Be kind.");
    expect(rulesOf("")).toBe(SYSTEM_PROMPT);
    expect(rulesOf(undefined)).toBe(SYSTEM_PROMPT);
    const m = buildMessages(
      { userId: "u", history: [{ role: "user", text: "hi" }] } as never,
      { wordLists: [], pageCards: { total: 0, due: 0 }, plans: [] },
      0,
      [],
      "Be kind.",
    );
    expect(m[0]!.content.startsWith("Be kind.")).toBe(true);
  });
});
