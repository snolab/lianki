/**
 * Li's prompt in cache order (flag partner.stable-prompt; docs/partner-ai.md,
 * "Prompt caching"): static rules first, the frozen append-only history, the
 * per-call parts last; the polish section inside Li's reply.
 */
import { describe, expect, it } from "bun:test";
import {
  POLISH_SECTION_RULE,
  SYSTEM_PROMPT,
  buildMessages,
  parsePartnerRequest,
  splitPolish,
  staticPrompt,
  type StudySummary,
} from "@/lib/partner-ai";
import {
  advanceWindow,
  editEntry,
  type PartnerWindow,
  type WindowLine,
} from "@/lib/partner-window";
import { HISTORY_LINES, HISTORY_MAX_CHARS, type PartnerRequest } from "@/lib/partner-ai-config";

const B = { maxLines: HISTORY_LINES, maxChars: HISTORY_MAX_CHARS, keepPct: 50 };
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 25, 7, 0, 0);
const summary = (due: number): StudySummary => ({
  wordLists: [{ name: "JLPT N5", lang: "ja", cards: 300, due }],
  pageCards: { total: 12, due: 1 },
  plans: [],
});
const line = (
  i: number,
  role: "user" | "assistant" = i % 2 ? "assistant" : "user",
): WindowLine => ({
  id: `m${i}`,
  role,
  text: role === "user" ? `我老婆想学日语，第 ${i} 句` : `好的，她可以先学假名（${i}）`,
});
const req = (
  history: { role: "user" | "assistant"; text: string }[],
  extra: Partial<PartnerRequest> = {},
) => ({ userId: "u_owner", owner: true, stable: true, history, ...extra }) as PartnerRequest;
/** The bytes the model reads, in order. */
const bytes = (m: { role: string; content: string }[]) =>
  m.map((x) => `${x.role}\n${x.content}\n`).join("");
const commonPrefix = (a: string, b: string) => {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
};

describe("the frozen window", () => {
  it("append-only: a new line goes last, nothing before it changes", () => {
    const w1 = advanceWindow(undefined, [line(0), line(1)], B);
    const w2 = advanceWindow(w1, [line(0), line(1), line(2)], B);
    expect(w2.items.slice(0, w1.items.length)).toEqual(w1.items);
    expect(w2.items.at(-1)).toEqual({ role: "user", text: line(2).text });
  });

  it("an edit is appended as an entry; the line stays as first sent", () => {
    const w1 = advanceWindow(undefined, [line(0), line(1), line(2)], B);
    const polished = { ...line(0), text: "我老婆想学日语。" };
    const w2 = advanceWindow(w1, [polished, line(1), line(2), line(4)], B);
    expect(w2.items.slice(0, 3)).toEqual(w1.items);
    expect(w2.items[3]).toEqual({ role: "user", text: editEntry(line(0).text, polished.text) });
    // The newest line stays last, so the request still ends on his line.
    expect(w2.items.at(-1)!.text).toBe(line(4).text);
    // Seen once: the same edit is not appended again.
    const w3 = advanceWindow(w2, [polished, line(1), line(2), line(4)], B);
    expect(w3.items).toEqual(w2.items);
  });

  it("over the bound, a checkpoint keeps the newest within keepPct; then it grows again", () => {
    let w: PartnerWindow | undefined;
    const all: WindowLine[] = [];
    let checkpoints = 0;
    for (let i = 0; i < 60; i++) {
      all.push(line(i));
      const before = w;
      w = advanceWindow(w, all.slice(-HISTORY_LINES), B);
      if (before && w.items[0]!.text !== before.items[0]!.text) checkpoints++;
      expect(w.items.length).toBeLessThanOrEqual(HISTORY_LINES);
      expect(w.items.at(-1)!.text).toBe(line(i).text);
    }
    // 20-line bound, half kept: a new checkpoint every ~10 lines.
    expect(checkpoints).toBeGreaterThanOrEqual(4);
    expect(checkpoints).toBeLessThanOrEqual(6);
  });
});

describe("cache order", () => {
  it("two consecutive calls are byte-identical up to the new tail (and through an edit)", () => {
    const lines = [line(0), line(1), line(2)];
    const w1 = advanceWindow(undefined, lines, B);
    const a = buildMessages(req(w1.items, { page: { path: "/words" } }), summary(5), NOW);
    // Next call: a reply and a new line, line 0 polished meanwhile, other page, other counts, next day.
    const w2 = advanceWindow(
      w1,
      [{ ...line(0), text: "我老婆想学日语。" }, line(1), line(2), line(3), line(4)],
      B,
    );
    const b = buildMessages(
      req(w2.items, { page: { path: "/reader" }, polish: [{ id: "m4", text: "x" }] }),
      summary(9),
      NOW + DAY,
    );
    const prefix = a.slice(0, -1);
    expect(b.slice(0, prefix.length)).toEqual(prefix);
    expect(bytes(b).startsWith(bytes(prefix))).toBe(true);
    // The per-call parts sit only in the last message.
    expect(b.at(-1)!.role).toBe("system");
    expect(b.at(-1)!.content).toContain("<page>");
    expect(b.at(-1)!.content).toContain("<polish_lines>");
    expect(b.at(-1)!.content).toContain("2026-11-26");
    expect(bytes(b.slice(0, -1))).not.toContain("2026-11-2");
  });

  it("measured over a 60-line conversation: share of each call's prompt the next one repeats", () => {
    // Lines of a realistic length (~120 characters), so the history weighs as it does live.
    const long = (i: number) => {
      const l = line(i);
      return { ...l, text: `${l.text}：${"假名和基础词汇，每天复习到期的卡片，".repeat(5)}` };
    };
    const measure = (stable: boolean) => {
      let w: PartnerWindow | undefined;
      const all: WindowLine[] = [];
      let prev = "";
      let reused = 0;
      let total = 0;
      let histReused = 0;
      let histTotal = 0;
      let prevReusable = 0;
      let keptOfReusable = 0;
      let reusableTotal = 0;
      let misses = 0;
      const rules = staticPrompt({ owner: true }).length;
      for (let i = 0; i < 60; i++) {
        all.push(long(i));
        // Every 5th line of his is polished later, as the hub's polish does.
        if (i >= 6 && i % 5 === 1) all[i - 5] = { ...all[i - 5]!, text: `${all[i - 5]!.text}。` };
        if (i % 2) continue; // Li answers his lines only.
        const recent = all.slice(-HISTORY_LINES);
        let history: { role: "user" | "assistant"; text: string }[];
        if (stable) history = (w = advanceWindow(w, recent, B)).items;
        else history = recent.map(({ role, text }) => ({ role, text }));
        const m = buildMessages(
          {
            userId: "u",
            owner: true,
            ...(stable ? { stable: true } : {}),
            history,
            page: { path: `/p${i % 3}` },
          } as PartnerRequest,
          summary(i % 7),
          NOW,
        );
        const now = bytes(m);
        if (prev) {
          const c = commonPrefix(prev, now);
          reused += c;
          total += now.length;
          // Past the static rules: the part the order decides.
          histReused += Math.max(0, c - rules);
          histTotal += now.length - rules;
          // Of the previous call's prompt minus its per-call tail: how much this one repeats.
          keptOfReusable += Math.min(c, prevReusable);
          reusableTotal += prevReusable;
          if (c < prevReusable) misses++;
        }
        prev = now;
        prevReusable = bytes(m.slice(0, stable ? -1 : 1)).length;
      }
      return {
        all: reused / total,
        afterRules: histReused / histTotal,
        ofPrefix: keptOfReusable / reusableTotal,
        misses,
      };
    };
    const stable = measure(true);
    const old = measure(false);
    const r = (x: number) => +x.toFixed(3);
    console.log(
      JSON.stringify({
        msg: "prefix-reuse",
        calls: 30,
        stable: {
          ...stable,
          all: r(stable.all),
          afterRules: r(stable.afterRules),
          ofPrefix: r(stable.ofPrefix),
        },
        old: { ...old, all: r(old.all), afterRules: r(old.afterRules), ofPrefix: r(old.ofPrefix) },
      }),
    );
    // The old order: the page and due counts sit before the history, nothing after them repeats.
    expect(old.afterRules).toBeLessThan(0.1);
    expect(stable.afterRules).toBeGreaterThan(0.5);
    // Only the checkpoints miss (one in every few calls); every other call repeats all of it.
    expect(stable.ofPrefix).toBeGreaterThan(0.8);
    expect(stable.misses).toBeLessThanOrEqual(8);
    expect(stable.all).toBeGreaterThan(old.all);
  });

  it("the same inputs as before, only reordered (snapshot of the content sets)", () => {
    const history = [
      { role: "user" as const, text: "今天学什么" },
      { role: "assistant" as const, text: "先复习 5 张卡" },
      { role: "user" as const, text: "好" },
    ];
    const roster = [{ id: "coco", name: "coco" }];
    const blocksOf = (m: { role: string; content: string }[]) =>
      m
        .flatMap((x) =>
          x.role === "system" ? x.content.split("\n\n") : [`${x.role}:${x.content}`],
        )
        .toSorted();
    for (const owner of [false, true]) {
      const base = {
        userId: "u",
        history,
        page: { path: "/words", title: "Words" },
        ...(owner ? { owner: true as const, roster } : {}),
      };
      const old = buildMessages(base as PartnerRequest, summary(5), NOW);
      const now = buildMessages({ ...base, stable: true } as PartnerRequest, summary(5), NOW);
      const extra = owner ? POLISH_SECTION_RULE.split("\n\n") : [];
      expect(blocksOf(now)).toEqual([...blocksOf(old), ...extra].toSorted());
      expect(now[0]!.content).toBe(staticPrompt(base));
      expect(now[0]!.content.startsWith(SYSTEM_PROMPT)).toBe(true);
    }
    // Flag off: exactly the old messages (no stable mark).
    expect(buildMessages({ userId: "u", history } as PartnerRequest, summary(5), NOW)).toHaveLength(
      4,
    );
  });

  it("the request: stable and polish lines only as sent, polish only in his thread", () => {
    const base = { userId: "u_owner", history: [{ role: "user", text: "Li 在吗" }] };
    const polish = [
      { id: "v1", text: "因为他的 GitHub 不怎么用" },
      { id: "v1", text: "dupe" },
      { id: "bad/id", text: "x" },
      { id: "v2", text: "  " },
    ];
    expect(parsePartnerRequest({ ...base, owner: true, stable: true, polish })).toMatchObject({
      stable: true,
      polish: [{ id: "v1", text: "因为他的 GitHub 不怎么用" }],
    });
    expect(parsePartnerRequest({ ...base, stable: true, polish })?.polish).toBeUndefined();
    expect(parsePartnerRequest({ ...base, owner: true, polish })?.polish).toBeUndefined();
    expect(parsePartnerRequest({ ...base, owner: true, stable: "yes" })?.stable).toBeUndefined();
  });
});

describe("the polish section in Li's reply", () => {
  const sent = [
    { id: "v1", text: "因为他的 GitHub 不怎么用" },
    { id: "v2", text: "所以没看到" },
  ];
  it("a section is taken off the reply and held to the ids sent", () => {
    const raw = `她可以先用 GitLab。\n<polish>{"lines":[{"id":"v1","text":"因为她的 GitHub 不怎么用。"},{"id":"zz","text":"injected"},{"id":"v2","text":"所以没看到"},{"id":"v1","text":"again"}]}</polish>`;
    expect(splitPolish(raw, sent)).toEqual({
      text: "她可以先用 GitLab。",
      polish: [{ id: "v1", text: "因为她的 GitHub 不怎么用。" }],
    });
  });
  it("malformed, missing or unclosed: no polish, the reply stands", () => {
    expect(splitPolish("好的。", sent)).toEqual({ text: "好的。", polish: [] });
    expect(splitPolish("好的。\n<polish>{not json}</polish>", sent)).toEqual({
      text: "好的。",
      polish: [],
    });
    expect(splitPolish('好的。\n<polish>{"lines":"x"}</polish>', sent)).toEqual({
      text: "好的。",
      polish: [],
    });
    expect(splitPolish('好的。\n<polish>{"lines":[{"id":"v1","te', sent)).toEqual({
      text: "好的。",
      polish: [],
    });
    // Lines were not sent: a section is dropped from the text and ignored.
    expect(splitPolish('好的。<polish>{"lines":[{"id":"v1","text":"x"}]}</polish>', [])).toEqual({
      text: "好的。",
      polish: [],
    });
  });
  it("the contract is in the static prompt of his thread, with the pronoun rule", () => {
    expect(staticPrompt({ owner: true })).toContain(POLISH_SECTION_RULE);
    expect(staticPrompt({})).toBe(SYSTEM_PROMPT);
    expect(POLISH_SECTION_RULE).toContain("她");
    expect(POLISH_SECTION_RULE).toMatch(/never list an id that was not given/);
    expect(POLISH_SECTION_RULE).toMatch(/otherwise leave the word as it is/);
  });
});
