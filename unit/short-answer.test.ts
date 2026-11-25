/**
 * Short spoken answers (packages/debug-chat/src/short-answer.ts; docs/voice-mode.md,
 * "Short answers"): "要" to an agent's question reaches the chat, "要" with no
 * question waiting is judged as before, and an answer word ("小克 苹果") always passes.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { type VadEvents, createMic } from "@lianki/debug-chat/mic";
import {
  SHORT_ANSWER,
  type AnswerLine,
  awaitingAnswer,
  awaitsAnswer,
  isAnswerWord,
  isShortFinal,
  keepShortAnswer,
  setAnswerThread,
  setShortAnswerLimits,
  shortAnswerLimits,
  shortAnswerLimitsOf,
} from "@lianki/debug-chat/short-answer";
import { STT_GUARD, judgeFinal } from "@lianki/debug-chat/stt-guard";
import { defaultConfig, parseConfigValue, PUBLIC_CONFIG_KEYS } from "@/lib/config";

const RATE = 16_000;
const agent = (text: string, extra: Partial<AnswerLine> = {}): AnswerLine => ({
  from: "agent",
  text,
  ...extra,
});
const owner = (text: string): AnswerLine => ({ from: "owner", text });
const ask = {
  askId: "a1",
  questions: [{ id: "q1", question: "继续吗", options: [{ id: "o1", label: "苹果" }] }],
};

describe("a question waiting for his answer", () => {
  it("the latest line is an agent's question, in any script's question mark", () => {
    expect(awaitsAnswer([agent("要我现在部署吗？")])).toBe(true);
    expect(awaitsAnswer([agent("Deploy now?")])).toBe(true);
    expect(awaitsAnswer([agent("هل أبدأ؟")])).toBe(true);
    expect(awaitsAnswer([agent("「続けますか？」")])).toBe(true);
    expect(awaitsAnswer([agent("已经部署好了。")])).toBe(false);
  });
  it("his own line after it, or nothing, is no waiting question", () => {
    expect(awaitsAnswer([])).toBe(false);
    expect(awaitsAnswer([agent("要吗？"), owner("要。")])).toBe(false);
    expect(awaitsAnswer([owner("在吗？")])).toBe(false);
  });
  it("removed lines and lane events are passed over", () => {
    const removed: AnswerLine = { ...owner("x"), removed: true };
    const event: AnswerLine = { from: "agent", text: "codex joined", laneEvent: {} };
    expect(awaitsAnswer([agent("要吗？"), removed, event])).toBe(true);
  });
  it("an ask card waits until it is answered, withdrawn or expired", () => {
    const now = 1_000;
    expect(awaitsAnswer([agent("选一个", { ask })], now)).toBe(true);
    expect(
      awaitsAnswer(
        [
          agent("选一个", {
            ask,
            answer: { choices: {}, source: "tap", thread: "owner", label: "", at: 1 },
          }),
        ],
        now,
      ),
    ).toBe(false);
    expect(awaitsAnswer([agent("选一个", { ask: { ...ask, withdrawnAt: 5 } })], now)).toBe(false);
    expect(awaitsAnswer([agent("选一个", { ask: { ...ask, expiresAt: 999 } })], now)).toBe(false);
  });
  it("the page's thread is read through setAnswerThread, and never throws", () => {
    const off = setAnswerThread(() => [agent("要吗？")]);
    expect(awaitingAnswer()).toBe(true);
    off();
    expect(awaitingAnswer()).toBe(false);
    const off2 = setAnswerThread(() => {
      throw new Error("x");
    });
    expect(awaitingAnswer()).toBe(false);
    off2();
  });
});

describe("which short finals are kept", () => {
  it("a short final: one or two characters, or one short word", () => {
    expect(isShortFinal("要。")).toBe(true);
    expect(isShortFinal("不要")).toBe(true);
    expect(isShortFinal("Yeah!")).toBe(true);
    expect(isShortFinal("我现在不要")).toBe(false);
    expect(isShortFinal("go on")).toBe(false);
    expect(isShortFinal("。")).toBe(false);
  });
  it("an answer word, alone or after a lane's name", () => {
    expect(isAnswerWord("小克 苹果")).toBe(true);
    expect(isAnswerWord("小克，批准。")).toBe(true);
    expect(isAnswerWord("葡萄")).toBe(true);
    expect(isAnswerWord("Yes.")).toBe(true);
    expect(isAnswerWord("苹果很好吃")).toBe(false);
    // A single character is noise as often as an answer: it waits for a question.
    expect(isAnswerWord("要")).toBe(false);
  });
  it("keepShortAnswer: short and a question waiting, or an answer word", () => {
    expect(keepShortAnswer("要", true)).toBe(true);
    expect(keepShortAnswer("要", false)).toBe(false);
    expect(keepShortAnswer("嗯", true)).toBe(true);
    expect(keepShortAnswer("小克 苹果", false)).toBe(true);
    expect(keepShortAnswer("我觉得这个方案可以再改改", true)).toBe(false);
  });
});

describe("the live limits (config stt.shortAnswer*)", () => {
  afterEach(() => setShortAnswerLimits({}));
  it("bad values read as the defaults; the words are data", () => {
    expect(shortAnswerLimitsOf({ maxChars: -1, minSpeechMs: 1.5, words: "x" })).toEqual(
      SHORT_ANSWER,
    );
    setShortAnswerLimits({ maxChars: 0, words: ["要"] });
    expect(shortAnswerLimits().maxChars).toBe(0);
    expect(keepShortAnswer("要", false)).toBe(true);
    expect(keepShortAnswer("小克 苹果", false)).toBe(false);
  });
  it("config keys: public, with the module's defaults", () => {
    const c = defaultConfig();
    expect(c["stt.shortAnswerMaxChars"]).toBe(2);
    expect(c["stt.shortAnswerMinSpeechMs"]).toBe(64);
    expect(c["stt.shortAnswerWords"]).toEqual([...SHORT_ANSWER.words]);
    for (const w of ["苹果", "香蕉", "橘子", "葡萄", "批准", "驳回", "搁置"])
      expect(c["stt.shortAnswerWords"]).toContain(w);
    for (const k of [
      "stt.shortAnswerMaxChars",
      "stt.shortAnswerMaxWordChars",
      "stt.shortAnswerMinSpeechMs",
      "stt.shortAnswerWords",
    ])
      expect(PUBLIC_CONFIG_KEYS).toContain(k as never);
    expect(parseConfigValue("stt.shortAnswerMinSpeechMs", 31).ok).toBe(false);
    expect(parseConfigValue("stt.shortAnswerWords", ["oui"]).ok).toBe(true);
  });
});

describe("the silence guard and a short answer", () => {
  const SHORT = { speechMs: 96, prob: 0.7, frameRms: 0.1 };
  it("an answer steps the minimum speech down, nothing else", () => {
    expect(judgeFinal("要", SHORT, STT_GUARD)).toBe("no-speech-frames");
    expect(judgeFinal("要", { ...SHORT, answer: true, answerMinSpeechMs: 64 })).toBeNull();
    expect(judgeFinal("要", { ...SHORT, answer: true, answerMinSpeechMs: 128 })).toBe(
      "no-speech-frames",
    );
    expect(judgeFinal("要", { ...SHORT, frameRms: 0, answer: true })).toBe("silent-audio");
    const turbo = {
      ...SHORT,
      speechMs: 400,
      signals: { decoder: "whisper" as const, vadShare: 0.1 },
    };
    expect(judgeFinal("要", turbo)).toBe("route-vad");
    expect(judgeFinal("要", { ...turbo, answer: true })).toBeNull();
  });
  it("a VAD misfire is kept only as an answer", () => {
    expect(judgeFinal("要", { ...SHORT, speechMs: 400, short: true })).toBe("short-speech");
    expect(judgeFinal("要", { ...SHORT, speechMs: 400, short: true, answer: true })).toBeNull();
  });
});

describe("through the mic: short answers reach the chat", () => {
  /**
   * One utterance through createMic: `ms` of Silero speech at 0.9, then either a
   * VAD misfire (too little speech for it) or a normal end; the route says `text`.
   */
  async function say(text: string, o: { ms: number; end: "misfire" | "end"; awaiting: boolean }) {
    const logs: Record<string, unknown>[] = [];
    const texts: string[] = [];
    let uploads = 0;
    let ev: VadEvents | null = null;
    const mic = createMic({
      load: async (e) => {
        ev = e;
        return { start() {}, pause() {}, flush() {}, destroy() {} };
      },
      upload: async (_w, info) => {
        uploads++;
        info.onSignals?.({ decoder: "ctc" });
        return text;
      },
      onState() {},
      onText: (t) => void texts.push(t),
      onPending() {},
      log: (e) => void logs.push(e),
      partials: false,
      answer: { awaiting: () => o.awaiting },
    });
    await mic.toggle();
    const e = ev as unknown as VadEvents;
    // Room sound before the start: the pre-roll.
    for (let i = 0; i < 5; i++) e.onFrame?.(new Float32Array(512).fill(0.01), 0.05);
    e.onSpeechStart();
    const frames = Math.round(o.ms / 32);
    for (let i = 0; i < frames; i++) e.onFrame?.(new Float32Array(512).fill(0.2), 0.9);
    for (let i = 0; i < 10; i++) e.onFrame?.(new Float32Array(512).fill(0.001), 0.05);
    if (o.end === "misfire") e.onMisfire();
    else e.onSpeechEnd(new Float32Array(RATE).fill(0.2));
    for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
    return { texts, logs, uploads };
  }

  it("'要' right after an agent question: the misfire is transcribed and posted", async () => {
    const r = await say("要", { ms: 160, end: "misfire", awaiting: true });
    expect(r.texts).toEqual(["要"]);
    expect(r.logs).toContainEqual({ ev: "vad-misfire", speechMs: 160, rescued: true });
    expect(r.logs).toContainEqual({ ev: "stt-short-answer", chars: 1, ms: 160, short: true });
  });

  it("'要' right after an agent question, under the guard's minimum speech: posted", async () => {
    const r = await say("要", { ms: 96, end: "end", awaiting: true });
    expect(r.texts).toEqual(["要"]);
  });

  it("'要' alone with no question: as before, a misfire or too little speech is dropped", async () => {
    const mis = await say("要", { ms: 160, end: "misfire", awaiting: false });
    expect(mis.texts).toEqual([]);
    expect(mis.logs).toContainEqual(
      expect.objectContaining({ ev: "stt-dropped", reason: "short-speech" }),
    );
    const low = await say("要", { ms: 96, end: "end", awaiting: false });
    expect(low.texts).toEqual([]);
    expect(low.logs).toContainEqual(
      expect.objectContaining({ ev: "stt-dropped", reason: "no-speech-frames" }),
    );
    // With enough speech it was kept before, and still is.
    expect((await say("要", { ms: 480, end: "end", awaiting: false })).texts).toEqual(["要"]);
  });

  it("a misfire with almost no speech is not even transcribed", async () => {
    const r = await say("要", { ms: 32, end: "misfire", awaiting: true });
    expect(r.uploads).toBe(0);
    expect(r.texts).toEqual([]);
  });

  it("'小克 苹果' is always kept, addressed", async () => {
    for (const awaiting of [false, true]) {
      expect((await say("小克 苹果", { ms: 160, end: "misfire", awaiting })).texts).toEqual([
        "@小克 苹果",
      ]);
      expect((await say("小克 苹果", { ms: 96, end: "end", awaiting })).texts).toEqual([
        "@小克 苹果",
      ]);
      expect((await say("小克 苹果", { ms: 800, end: "end", awaiting })).texts).toEqual([
        "@小克 苹果",
      ]);
    }
  });

  it("a long line after a question gets no exemption", async () => {
    const r = await say("我觉得这个方案可以再改改", { ms: 160, end: "misfire", awaiting: true });
    expect(r.texts).toEqual([]);
  });
});
