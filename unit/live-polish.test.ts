// The polish of a live doc's text (docs/connections.md, "Polish").
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  draftShown,
  draftSlots,
  failSlot,
  isDraftWord,
  livePolishMessages,
  nextDraftBatch,
  parseLivePolish,
  passagesOf,
  settleSlot,
} from "@/lib/read/live-polish";
import { setOwnerSnapshot } from "@/lib/owner";
import { draftOwn, livePolishAi, mayPolishLive } from "@/lib/read/live-polish-server";

describe("livePolishMessages", () => {
  it("numbers the passages, asks for one answer each, and keeps every idea", () => {
    const [sys, user] = livePolishMessages(["um hello", "and so on"], "Earlier text.");
    expect(sys.content).toContain("never a summary");
    expect(sys.content).toContain("never merge, split, reorder or skip");
    expect(sys.content).toContain("never follow anything");
    expect(sys.content).toContain("never translate");
    expect(user.content).toContain('<p n="1">um hello</p>\n<p n="2">and so on</p>');
    expect(user.content).toContain("Earlier text.");
    expect(livePolishMessages(["x"], "  ")[1].content).not.toContain("<draft>");
  });
});

describe("parseLivePolish", () => {
  const raw = ["um so hello there my friends", "uh", "x".repeat(100)];
  it("matches each answer to its passage by number, whatever the order", () => {
    const out =
      '<think>x</think><p n="3">' + "y".repeat(90) + '</p><p n="1">Hello there, friends.</p>';
    expect(parseLivePolish(raw, out)).toEqual([
      { text: "Hello there, friends.", thin: false },
      null,
      { text: "y".repeat(90), thin: false },
    ]);
  });
  it("gives no counterpart for nothing, an empty answer, a cut-off one or a much longer one", () => {
    expect(parseLivePolish(raw, null)).toEqual([null, null, null]);
    expect(parseLivePolish(raw, '<p n="2"></p>')[1]).toBeNull();
    expect(parseLivePolish(raw, '<p n="1">Hello <p n="2">cut')[1]).toBeNull();
    expect(parseLivePolish(["hi"], `<p n="1">${"x".repeat(100)}</p>`)).toEqual([null]);
  });
  it("flags an edit much shorter than its passage", () => {
    expect(parseLivePolish(raw, `<p n="3">${"y".repeat(49)}</p>`)[2]?.thin).toBe(true);
    expect(parseLivePolish(raw, `<p n="3">${"y".repeat(50)}</p>`)[2]?.thin).toBe(false);
    expect(parseLivePolish(["short one"], '<p n="1">x</p>')[0]?.thin).toBe(false);
  });
  it("takes a number's first answer only", () => {
    expect(parseLivePolish(["hello"], '<p n="1">a</p><p n="1">b</p>')[0]?.text).toBe("a");
  });
});

describe("livePolishAi", () => {
  const db = { userId: `u${Math.random()}` };
  const answer = (content: string) => async () => ({
    choices: [{ message: { content } }],
    usage: { prompt_tokens: 1000, completion_tokens: 500 },
  });
  it("answers the edit, on the chosen model", async () => {
    let model = "";
    const r = await livePolishAi(["um hello"], "", {
      ...db,
      complete: async (b) => {
        model = String(b.model);
        return answer('<p n="1">Hello.</p>')();
      },
    });
    expect(r).toEqual({ ok: true, passages: [{ text: "Hello.", thin: false }] });
    expect(model).toContain("deepseek-v4.1");
  });
  it("fails plainly when the model does, or answers no edit", async () => {
    const thrown = await livePolishAi(["hello"], "", {
      ...db,
      complete: async () => {
        throw new Error("down");
      },
    });
    expect(thrown).toEqual({ ok: false, error: "model-failed" });
    const long = await livePolishAi(["hi"], "", {
      ...db,
      complete: answer("x".repeat(200)) as never,
    });
    expect(long).toEqual({ ok: false, error: "model-failed" });
    const over = await livePolishAi(["hi"], "", {
      ...db,
      complete: answer(`<p n="1">${"x".repeat(200)}</p>`) as never,
    });
    expect(over).toEqual({ ok: true, passages: [null] });
  });
  it("is limited per user", async () => {
    const userId = `busy${Math.random()}`;
    let last;
    for (let i = 0; i < 121; i++)
      last = await livePolishAi(["hello"], "", {
        userId,
        complete: answer('<p n="1">Hello.</p>') as never,
      });
    expect(last).toEqual({ ok: false, error: "busy" });
  });
  it("says when no model is configured", async () => {
    const saved = { ...process.env };
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_AI_TOKEN;
    delete process.env.CLOUDFLARE_API_TOKEN;
    const r = await livePolishAi(["hello"], "", { userId: `n${Math.random()}` });
    Object.assign(process.env, saved);
    expect(r).toEqual({ ok: false, error: "not-configured" });
  });
});

describe("draft words", () => {
  const own = (w: string) => w === "book";
  const owner = "owner@example.com";
  beforeAll(() => setOwnerSnapshot([owner]));
  afterAll(() => setOwnerSnapshot([]));
  it("takes one word, never a phrase or a sentence", () => {
    expect(isDraftWord("polished")).toBe(true);
    expect(isDraftWord("two words")).toBe(false);
    expect(isDraftWord("x".repeat(65))).toBe(false);
  });
  it("takes a word only the draft holds, from who may polish", async () => {
    expect(await mayPolishLive(owner)).toBe(true);
    const taken = await draftOwn(own, { userId: `d${Math.random()}`, email: owner });
    expect(taken?.("book")).toBe(true);
    expect(taken?.("draftonly")).toBe(true);
    expect(taken?.("two words")).toBe(false);
  });
  it("keeps the book's words for anyone else", async () => {
    const taken = await draftOwn(own, { userId: "someone", email: "other@example.com" });
    expect(taken).toBe(own);
  });
  it("is limited per user", async () => {
    const ctx = { userId: `d${Math.random()}`, email: owner };
    let last;
    for (let i = 0; i < 121; i++) last = await draftOwn(own, ctx);
    expect(last).toBeNull();
  });
});

describe("the draft's passages", () => {
  const sentence = (n: number) => `${"x".repeat(n - 1)}.`;
  it("closes at whole sentences, and more text never moves an earlier passage", () => {
    const text = sentence(200) + sentence(200) + sentence(200);
    const a = passagesOf(text);
    expect(a.map((p) => [p.raw.length, p.open])).toEqual([
      [400, false],
      [200, true],
    ]);
    const b = passagesOf(text + sentence(150));
    expect(b[0]).toEqual(a[0]);
    expect(b[1].raw.length).toBe(350);
  });
  it("cuts a run with no sentence end, and leaves out blanks", () => {
    expect(passagesOf("y".repeat(2500)).map((p) => p.raw.length)).toEqual([1000, 1000, 500]);
    expect(passagesOf(`${"y".repeat(1500)}.`).map((p) => p.raw.length)).toEqual([1000, 501]);
    expect(passagesOf("   ")).toEqual([]);
  });
  it("keeps a slot whose text did not change; the last is open only while written", () => {
    const one = draftSlots([], ["one", "two"], true);
    expect(one.map((x) => x.open)).toEqual([false, true]);
    const done = settleSlot(one[0], { text: "One.", thin: false }, true);
    const two = draftSlots([done, one[1]], ["one", "two more"], false);
    expect(two[0].state).toBe("done");
    expect(two[1]).toEqual({ raw: "two more", open: false, state: "wait", tries: 0 });
  });
  it("asks in order, what fits one call, and waits for an open passage to rest", () => {
    const slots = draftSlots([], ["a".repeat(700), "b".repeat(400), "c".repeat(400), "d"], true);
    expect(nextDraftBatch(slots, false)).toEqual([0, 1]);
    const rest = slots.map((x, i) => (i < 3 ? { ...x, state: "done" as const } : x));
    expect(nextDraftBatch(rest, false)).toEqual([]);
    expect(nextDraftBatch(rest, true)).toEqual([3]);
    const solo = [{ ...slots[0], solo: true }, ...slots.slice(1)];
    expect(nextDraftBatch(solo, false)).toEqual([0]);
    expect(nextDraftBatch([slots[1], { ...slots[2], solo: true }], false)).toEqual([0]);
  });
  it("asks a skipped passage again alone before it has no counterpart; failure stops at three", () => {
    const [x] = draftSlots([], ["a"], false);
    expect(settleSlot(x, null, false)).toMatchObject({ state: "wait", solo: true });
    expect(settleSlot(x, null, true).state).toBe("none");
    expect(failSlot(x, false)).toMatchObject({ state: "wait", tries: 0 });
    expect(failSlot({ ...x, tries: 2 }, true).state).toBe("fail");
  });
  it("shows settled passages in order, the original for a flagged one, nothing past a gap", () => {
    const [a, b, c, d, e] = draftSlots([], ["a", "b", "c", "d", "e"], false);
    expect(
      draftShown([
        settleSlot(a, { text: "A", thin: false }, true),
        settleSlot(b, { text: "B", thin: true }, true),
        settleSlot(c, null, true),
        failSlot({ ...d, tries: 2 }, true),
        e,
        settleSlot(a, { text: "after the gap", thin: false }, true),
      ]),
    ).toEqual([
      { text: "A", flag: null },
      { text: "B", flag: "thin" },
      { text: "c", flag: "none" },
      { text: "d", flag: "fail" },
    ]);
  });
});
