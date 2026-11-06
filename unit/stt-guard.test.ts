/**
 * The silence guard (packages/debug-chat/src/stt-guard.ts, docs/workers-ai.md,
 * "Silence guard"): known hallucinations dropped, real sentences kept, and a
 * dropped line reaching nothing: not the chat, not a command, not a send cue.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { type MicDeps, createMicSession } from "@lianki/debug-chat/mic-session";
import { micTaps } from "@lianki/debug-chat/mic-taps";
import { type VadEvents, cleanTranscript, createMic } from "@lianki/debug-chat/mic";
import { localSignals } from "@lianki/debug-chat/local-stt";
import {
  droppedLines,
  forgetDropped,
  keepDroppedLines,
  noteDropped,
} from "../packages/debug-chat/src/stt-dropped";
import {
  STOCK_PHRASES,
  STT_GUARD,
  judgeFinal,
  loudestFrameRms,
  phraseKey,
  stockPhraseKind,
} from "@lianki/debug-chat/stt-guard";
import { readStt } from "@/lib/stt";

const RATE = 16_000;
/** Clearly speech, by every gate but the words. */
const CLEAR = { speechMs: 3_000, prob: 0.9, frameRms: 0.2 };
const WHISPER = {
  ...CLEAR,
  signals: { decoder: "whisper" as const, vadShare: 0.9, logprob: -0.3 },
};
const CTC = { ...CLEAR, signals: { decoder: "ctc" as const } };

describe("the phrase list", () => {
  it("matches what the models really wrote, whatever the spacing, script or case", () => {
    for (const t of [
      // The owner's line of 2026-11-06, and the turbo outputs measured on noise.
      "明镜需要您的支持",
      "明镜需要您的支持。",
      "明鏡需要您的支持",
      "请不吝点赞 订阅 转发 打赏支持明镜与点点栏目",
      "请不吝点赞,订阅,转发,打赏支持明镜与点点栏目",
      "请不吝点赞 订阅 订阅 订阅 订阅 订阅 转发 打赏支持明镜与点点栏目",
      "請不吝點贊 訂閱 轉發 打賞支持明鏡與點點欄目",
      "中文字幕志愿者 李宗盛",
      "文字幕志愿者 李宗盛。",
      "字幕提供者 李宗盛",
      "字幕作成者 李宗盛",
      "字幕由Amara.org社区提供",
    ])
      expect(stockPhraseKind(t)).toBe("credit");
    for (const t of [
      "Thanks for watching!",
      "THANK YOU SO MUCH FOR WATCHING.",
      "thank you for watching",
      "ご視聴ありがとうございました!",
      "謝謝觀看",
      "感謝收看！",
      "チャンネル登録をお願いいたします",
      "Subtitles by the community",
      "Sous-titres réalisés par la communauté",
    ])
      expect(stockPhraseKind(t)).toBe("courtesy");
  });

  it("every phrase in the data matches itself, and none opens with a slot", () => {
    for (const p of STOCK_PHRASES) {
      expect(p.text.startsWith("…")).toBe(false);
      expect(stockPhraseKind(p.text.replaceAll("…", "x"))).toBeDefined();
      expect(phraseKey(p.text).length).toBeGreaterThan(2);
    }
  });

  it("a real sentence holding a phrase is not the phrase", () => {
    for (const t of [
      "他说感谢观看这个视频的人",
      "什么是明镜与点点栏目",
      "我今天看了明镜与点点栏目的视频",
      "明镜需要您的支持这句话是哪来的",
      "Thanks for watching my talk yesterday",
      "I said thanks for watching",
      "Why does it say thanks for watching",
      "この動画のご視聴ありがとうございましたって何",
      "中文字幕怎么打开",
      "这个视频有中文字幕吗",
      "李宗盛",
      "我喜欢李宗盛",
      "Thank you",
      "Thank you very much",
      "谢谢",
    ])
      expect(stockPhraseKind(t)).toBeUndefined();
  });

  it("a very long line is no stock phrase, however it starts", () => {
    expect(stockPhraseKind(`请不吝点赞${"订阅".repeat(100)}`)).toBeUndefined();
  });
});

describe("judgeFinal", () => {
  it("a credit from Whisper goes on its words, even with clear speech behind it", () => {
    // Measured: 3 of 5 请不吝… on café noise had 3.9–4.9 s of "speech" at over 0.6.
    expect(judgeFinal("明镜需要您的支持", WHISPER)).toBe("stock-credit");
    expect(judgeFinal("明镜需要您的支持", { ...CLEAR })).toBe("stock-credit");
  });

  it("a credit from a ctc decoder needs weak evidence: it makes none up, so he said it", () => {
    expect(judgeFinal("明镜需要您的支持", CTC)).toBeNull();
    expect(judgeFinal("明镜需要您的支持", { ...CTC, speechMs: 300 })).toBe("stock-credit");
  });

  it("a courtesy needs weak evidence: he may really say it", () => {
    expect(judgeFinal("Thanks for watching", WHISPER)).toBeNull();
    expect(judgeFinal("Thanks for watching", { ...WHISPER, speechMs: 500 })).toBe("stock-courtesy");
    expect(judgeFinal("Thanks for watching", { ...WHISPER, prob: 0.3 })).toBe("stock-courtesy");
    // At the limits it is kept.
    expect(
      judgeFinal("Thanks for watching", {
        ...WHISPER,
        speechMs: STT_GUARD.shortSpeechMs,
        prob: STT_GUARD.faintProb,
      }),
    ).toBeNull();
  });

  it("a real sentence with a phrase in it passes on the faintest evidence that passes the gates", () => {
    const faint = { speechMs: 200, prob: 0.2, frameRms: 0.05, signals: WHISPER.signals };
    expect(judgeFinal("他说感谢观看这个视频的人", faint)).toBeNull();
    expect(judgeFinal("I said thanks for watching", faint)).toBeNull();
  });

  it("silent audio: dropped whatever it says, by the loudest frame", () => {
    expect(judgeFinal("今天天气不错", { ...CLEAR, frameRms: STT_GUARD.minFrameRms / 2 })).toBe(
      "silent-audio",
    );
    expect(judgeFinal("今天天气不错", { ...CLEAR, frameRms: STT_GUARD.minFrameRms })).toBeNull();
  });

  it("no frame looked like speech: dropped; the energy VAD counts no frames, so it passes", () => {
    expect(judgeFinal("今天天气不错", { ...CLEAR, speechMs: 0, prob: 0.3 })).toBe(
      "no-speech-frames",
    );
    // A short word with one good frame is kept: short answers are real.
    expect(judgeFinal("好", { ...CLEAR, speechMs: STT_GUARD.minSpeechMs, prob: 0.3 })).toBeNull();
    expect(judgeFinal("今天天气不错", { speechMs: 2_000, frameRms: 0.2 })).toBeNull();
  });

  it("the route's own VAD kept almost nothing: dropped; a route without it is not judged by it", () => {
    const vad = (vadShare: number) => ({
      ...CLEAR,
      signals: { decoder: "whisper" as const, vadShare },
    });
    expect(judgeFinal("今天天气不错", vad(STT_GUARD.minVadShare - 0.01))).toBe("route-vad");
    expect(judgeFinal("今天天气不错", vad(STT_GUARD.minVadShare))).toBeNull();
    expect(judgeFinal("今天天气不错", { ...CLEAR, signals: { decoder: "whisper" } })).toBeNull();
  });

  it("logprob alone drops nothing: speech and noise overlap on it", () => {
    expect(
      judgeFinal("今天天气不错", { ...CLEAR, signals: { decoder: "whisper", logprob: -3.7 } }),
    ).toBeNull();
  });

  it("empty text is not judged", () => {
    expect(judgeFinal("", { speechMs: 0, prob: 0, frameRms: 0 })).toBeNull();
    expect(judgeFinal("。。", { speechMs: 0, prob: 0, frameRms: 0 })).toBeNull();
  });

  it("the loudest frame, not the mean: one word in a quiet clip is loud", () => {
    const a = new Float32Array(RATE);
    a.fill(0.5, 512 * 16, 512 * 17);
    expect(loudestFrameRms(a)).toBeCloseTo(0.5, 3);
    expect(loudestFrameRms(new Float32Array(RATE))).toBe(0);
    expect(loudestFrameRms(new Float32Array(0))).toBe(0);
  });
});

describe("cleanTranscript and the decoder", () => {
  it("Whisper: a stock clause goes; a sentence ending in the words stays", () => {
    expect(cleanTranscript("明天见。谢谢观看").text).toBe("明天见。");
    expect(cleanTranscript("他说感谢观看").text).toBe("他说感谢观看");
  });
  it("ctc: nothing is cut, it does not append credits", () => {
    expect(cleanTranscript("明天见。谢谢观看", undefined, false).text).toBe("明天见。谢谢观看");
  });
});

describe("what each route gives the guard", () => {
  it("turbo: VAD share and logprob, weighted by segment; no no-speech", () => {
    expect(
      readStt("@cf/openai/whisper-large-v3-turbo", {
        text: " a ",
        transcription_info: { language: "en", duration: 4, duration_after_vad: 1 },
        segments: [
          { start: 0, end: 1, avg_logprob: -1, no_speech_prob: 0 },
          { start: 1, end: 4, avg_logprob: -0.2, no_speech_prob: 0 },
        ],
      }),
    ).toEqual({
      text: "a",
      language: "en",
      signals: { decoder: "whisper", vadShare: 0.25, logprob: -0.4 },
    });
  });
  it("the fallback: text and word_count, so the decoder alone", () => {
    expect(readStt("@cf/openai/whisper", { text: "a", word_count: 1 }).signals).toEqual({
      decoder: "whisper",
    });
  });
  it("Nova-3: none", () => {
    expect(readStt("@cf/deepgram/nova-3", null).signals).toBeUndefined();
  });
  it("the Mac: its decoder (an older server is SenseVoice, ctc), numbers only", () => {
    expect(localSignals(undefined)).toEqual({ decoder: "ctc" });
    expect(localSignals({ decoder: "ctc" })).toEqual({ decoder: "ctc" });
    expect(localSignals({ decoder: "whisper", logprob: -0.4, text: "no" })).toEqual({
      decoder: "whisper",
      logprob: -0.4,
    });
    expect(localSignals({ decoder: "whisper", logprob: "x" })).toEqual({ decoder: "whisper" });
  });
});

describe("a dropped line reaches nothing", () => {
  /** One utterance through createMic: the audio's level, frames at `prob`, the route's answer. */
  async function say(text: string, o: { sec?: number; prob?: number; level?: number } = {}) {
    const { sec = 3, prob = 0.9, level = 0.2 } = o;
    const logs: Record<string, unknown>[] = [];
    const texts: string[] = [];
    const dropped: [string, string][] = [];
    let ev: VadEvents | null = null;
    const mic = createMic({
      load: async (e) => {
        ev = e;
        return { start() {}, pause() {}, flush() {}, destroy() {} };
      },
      upload: async (_w, info) => {
        info.onSignals?.({ decoder: "whisper", vadShare: 0.9 });
        return text;
      },
      onState() {},
      onText: (t) => void texts.push(t),
      onPending() {},
      log: (e) => void logs.push(e),
      dropped: (t, r) => void dropped.push([t, r]),
      partials: false,
    });
    await mic.toggle();
    const e = ev as unknown as VadEvents;
    e.onSpeechStart();
    for (let i = 0; i < sec * 10; i++) e.onFrame?.(new Float32Array(RATE / 10), prob);
    e.onSpeechEnd(new Float32Array(sec * RATE).fill(level));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    return { texts, logs, dropped };
  }

  it("the owner's line: no text out; its reason and counts logged, never its words", async () => {
    const r = await say("明镜需要您的支持");
    expect(r.texts).toEqual([]);
    expect(r.logs).toEqual([
      {
        ev: "stt-dropped",
        reason: "stock-credit",
        chars: 8,
        ms: 3000,
        prob: 0.9,
        decoder: "whisper",
        logprob: undefined,
        vadShare: 0.9,
      },
    ]);
    expect(JSON.stringify(r.logs)).not.toContain("明镜");
    // The on-device view is the only one that gets the text.
    expect(r.dropped).toEqual([["明镜需要您的支持", "stock-credit"]]);
  });

  it("a cleaned phrase is logged by length too", async () => {
    const r = await say("明天见。谢谢观看");
    expect(r.texts).toEqual(["明天见。"]);
    expect(JSON.stringify(r.logs)).not.toContain("谢谢");
    expect(r.logs[0]).toMatchObject({ ev: "stt-cleaned", phrase: 1, removedChars: 4 });
  });

  it("silent audio with any words is dropped; real speech with a phrase inside is kept", async () => {
    expect((await say("今天天气不错", { level: 0 })).texts).toEqual([]);
    const kept = await say("他说感谢观看这个视频的人");
    expect(kept.texts).toEqual(["他说感谢观看这个视频的人"]);
    expect(kept.dropped).toEqual([]);
  });

  /** Through the page's session: the taps first, then the chat's sink. */
  async function session(text: string, level: number) {
    let events: VadEvents | null = null;
    const deps: MicDeps = {
      getStream: async () => ({ id: "s", getTracks: () => [{ readyState: "live", stop() {} }] }),
      load: async (ev) => {
        events = ev;
        return { start() {}, pause() {}, flush() {}, destroy() {} };
      },
      upload: async () => text,
    };
    const s = createMicSession(deps);
    const offered: string[] = [];
    const un = micTaps().tap((t) => {
      offered.push(t);
      return false;
    });
    const sent: string[] = [];
    s.attach({ onText: (t: string) => void sent.push(t), onPending() {} });
    await s.toggle();
    const e = events as unknown as VadEvents;
    e.onSpeechStart();
    for (let i = 0; i < 20; i++) e.onFrame?.(new Float32Array(RATE / 10), 0.9);
    e.onSpeechEnd(new Float32Array(2 * RATE).fill(level));
    await new Promise((r) => setTimeout(r, 5));
    un();
    await s.retire();
    return { offered, sent };
  }

  it("not a command, not a chat line: so no send and no send cue, which only a chat line starts", async () => {
    // A stock phrase that is also what a tap would hear, and silent audio that says a command.
    expect(await session("明镜需要您的支持", 0.2)).toEqual({ offered: [], sent: [] });
    expect(await session("下一张", 0)).toEqual({ offered: [], sent: [] });
    // The same path with a real line: offered first, then the chat.
    expect(await session("下一张", 0.2)).toEqual({ offered: ["下一张"], sent: ["下一张"] });
  });
});

describe("the on-device view", () => {
  afterEach(() => keepDroppedLines(false));

  it("keeps nothing unless an owner page turned it on", () => {
    keepDroppedLines(false);
    noteDropped("x", "stock-credit");
    expect(droppedLines()).toEqual([]);
  });
  it("keeps the newest, in memory, and forgets on demand or when turned off", () => {
    keepDroppedLines(true);
    for (let i = 0; i < 30; i++) noteDropped(`line ${i}`, "silent-audio", () => i);
    expect(droppedLines()).toHaveLength(20);
    expect(droppedLines()[0].text).toBe("line 29");
    forgetDropped(droppedLines()[0]);
    expect(droppedLines()[0].text).toBe("line 28");
    keepDroppedLines(false);
    expect(droppedLines()).toEqual([]);
  });
});
