import { describe, expect, it } from "bun:test";
import {
  type UttMarks,
  breakdown,
  createLatency,
  latencyRows,
  pickTiming,
  secs,
  voiceLatency,
} from "@lianki/debug-chat/latency";
import { voice } from "@lianki/debug-chat/voice";
import { RATE, type VadEvents, createMic } from "@lianki/debug-chat/mic";
import { UI_EN } from "@lianki/debug-chat/ui-strings";
import { cleanTiming } from "@lianki/debug-chat/wire";
import { parsePageMessage } from "@/lib/dev-eval";

/** A clock the test moves. */
const clock = (t = 1_000) => {
  const c = { t, now: () => c.t, at: (x: number) => (c.t = x) };
  return c;
};

describe("breakdown", () => {
  it("splits the path into stages on one clock", () => {
    const b = breakdown({
      timing: {
        t_lastVoice: 1_000,
        t_speechEnd: 2_400,
        t_uploadStart: 2_410,
        t_sttDone: 3_300,
        t_shown: 3_305,
        t_sent: 3_306,
        sttServerMs: 700,
      },
      t_echo: 3_400,
      t_ack: 3_500,
      t_reply: 9_400,
      t_audible: 9_700,
    });
    expect(b).toEqual({
      vadMs: 1_400,
      encodeMs: 10,
      sttMs: 890,
      sttServerMs: 700,
      sttNetMs: 190,
      waitMs: 5,
      sendMs: 1,
      hubMs: 94,
      ackMs: 194,
      agentMs: 6_000,
      voiceMs: 300,
      replyMs: 8_400,
      totalMs: 8_700,
    });
  });

  it("leaves out what it cannot know, and never goes negative", () => {
    // The energy VAD (no t_lastVoice), no echo, the reply not read aloud.
    const b = breakdown({
      timing: { t_speechEnd: 100, t_uploadStart: 90, t_sttDone: 500, t_sent: 520 },
      t_reply: 2_520,
    });
    expect(b).toEqual({ sttMs: 410, sendMs: 20, agentMs: 2_000, replyMs: 2_420, totalMs: 2_420 });
    expect("vadMs" in b || "encodeMs" in b || "voiceMs" in b).toBe(false);
  });
});

describe("pickTiming", () => {
  it("takes the latest-spoken utterance that made it, and every one before it", () => {
    const marks = new Map<number, UttMarks>([
      [0, { t_speechEnd: 100, t_sttDone: 300, t_shown: 300 }],
      [1, { t_speechEnd: 200, t_sttDone: 400, dropped: true }],
      [2, { t_speechEnd: 250, t_sttDone: 500, t_shown: 500, sttServerMs: 80 }],
      [3, { t_speechEnd: 900 }], // still out
    ]);
    expect(pickTiming(marks, 600)).toEqual({
      timing: { t_speechEnd: 250, t_sttDone: 500, t_shown: 500, sttServerMs: 80, t_sent: 600 },
      used: [0, 1, 2],
    });
    expect(pickTiming(new Map([[0, { t_speechEnd: 1, dropped: true, t_sttDone: 2 }]]), 3)).toBe(
      undefined,
    );
  });
});

describe("createLatency", () => {
  it("one record per voice line: marks → take → sent → echo → ack → reply → audible", () => {
    const c = clock();
    const logs: Record<string, unknown>[] = [];
    const s = createLatency({ now: c.now, log: (e) => logs.push(e) });
    s.mark(7, { t_lastVoice: 1_000, t_speechEnd: 2_400, audioMs: 2_000 });
    s.mark(7, { t_uploadStart: 2_410 });
    s.mark(7, { sttServerMs: 700 });
    s.mark(7, { t_sttDone: 3_300, dropped: false });
    c.at(3_305);
    s.shown();
    c.at(3_306);
    const timing = s.take();
    expect(timing).toMatchObject({ t_speechEnd: 2_400, t_shown: 3_305, t_sent: 3_306 });
    expect(s.take()).toBe(undefined); // consumed
    s.sent("abc", "你好。", timing!);
    c.at(3_400);
    s.heard({ id: "zzz", from: "owner", at: 1 }); // another line: ignored
    s.heard({ id: "abc", from: "owner", at: 5 });
    c.at(3_500);
    s.ack();
    c.at(3_600);
    s.heard({ id: "n1", from: "agent", at: 6, to: "/words" }); // a node's line: not the reply
    c.at(9_400);
    s.heard({ id: "r1", from: "agent", at: 7 }, true);
    expect(logs).toHaveLength(0); // waits for the voice
    c.at(9_700);
    s.audible();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      ev: "voice-latency",
      id: "abc",
      chars: 3,
      replied: true,
      vadMs: 1_400,
      hubMs: 94,
      ackMs: 194,
      agentMs: 6_000,
      voiceMs: 300,
      totalMs: 8_700,
      hubAt: 5,
    });
    expect(s.latest()?.breakdown.totalMs).toBe(8_700);
    s.audible(); // nothing open: no second record
    expect(logs).toHaveLength(1);
  });

  it("an unspoken reply closes at once; a new line closes an unanswered one", () => {
    const c = clock();
    const logs: Record<string, unknown>[] = [];
    const s = createLatency({ now: c.now, log: (e) => logs.push(e) });
    let told = 0;
    s.subscribe(() => told++);
    s.sent("a", "one", { t_speechEnd: 900, t_sent: 1_000 });
    c.at(1_200);
    s.heard({ id: "r", from: "agent", at: 1 }, false);
    expect(logs[0]).toMatchObject({ id: "a", replied: true, agentMs: 200, totalMs: 300 });
    s.sent("b", "two", { t_sent: 2_000 });
    s.sent("c", "three", { t_sent: 3_000 });
    expect(logs[1]).toMatchObject({ id: "b", replied: false });
    expect(s.open()?.id).toBe("c");
    expect(told).toBe(2);
    expect(s.records().map((r) => r.id)).toEqual(["a", "b"]);
    const off = s.subscribe(() => told++);
    off();
    s.sent("d", "four", { t_sent: 4_000 });
    expect(told).toBe(3); // the first subscriber only
  });

  it("drops a patch for an utterance it never saw start, and forgets old marks", () => {
    const c = clock();
    const s = createLatency({ now: c.now });
    s.mark(1, { t_sttDone: 5 });
    expect(s.take()).toBe(undefined);
    s.mark(2, { t_speechEnd: 1_000 });
    s.mark(2, { t_sttDone: 1_500 });
    c.at(1_000 + 121_000);
    s.mark(3, { t_speechEnd: c.t }); // prunes seq 2
    expect(s.take()).toBe(undefined);
  });
});

describe("the mic's marks (createMic timing)", () => {
  it("stamps the last voiced frame, the VAD's end, the upload and its answer", async () => {
    const c = clock(0);
    const marks: [number, UttMarks][] = [];
    let ev: VadEvents | null = null;
    let answer: (t: string) => void = () => {};
    const mic = createMic({
      load: async (e) => {
        ev = e;
        return { start() {}, pause() {}, flush() {}, destroy() {} };
      },
      upload: () => new Promise((r) => (answer = r)),
      onState() {},
      onText() {},
      onPending() {},
      timing: (seq, m) => marks.push([seq, m]),
      now: c.now,
      partials: false,
      setTimer: () => 0,
      clearTimer() {},
    });
    await mic.toggle();
    const v = ev as unknown as VadEvents;
    v.onSpeechStart();
    c.at(100);
    v.onFrame?.(new Float32Array(512), 0.9);
    c.at(600);
    v.onFrame?.(new Float32Array(512), 0.95);
    c.at(2_000);
    v.onFrame?.(new Float32Array(512), 0.05); // silence: not voiced
    v.onSpeechEnd(new Float32Array(RATE));
    c.at(2_900);
    answer("hello");
    await new Promise((r) => setTimeout(r, 0));
    expect(marks).toEqual([
      [0, { t_lastVoice: 600, t_speechEnd: 2_000, audioMs: 1_000 }],
      [0, { t_uploadStart: 2_000 }],
      [0, { t_sttDone: 2_900, dropped: false }],
    ]);
  });
});

describe("the menu row and the wire", () => {
  it("latencyRows: the total and the known stages in path order", () => {
    expect(
      latencyRows(
        { vadMs: 1_400, sttMs: 890, encodeMs: 10, sendMs: 1, agentMs: 6_000, totalMs: 8_700 },
        UI_EN,
      ),
    ).toEqual({
      total: "8.7",
      parts: [
        ["silence", "1.4"],
        ["STT", "0.9"],
        ["send", "0.0"],
        ["reply", "6.0"],
      ],
    });
    expect(latencyRows({}, UI_EN)).toEqual({ parts: [] });
    expect(secs(1_250)).toBe("1.3");
  });

  it("cleanTiming keeps known, sane numbers only", () => {
    expect(cleanTiming({ t_sent: 5.4, t_speechEnd: -1, junk: 3, sttServerMs: "9" })).toEqual({
      t_sent: 5,
    });
    expect(cleanTiming({ t_sent: Number.NaN })).toBe(undefined);
    expect(cleanTiming(null)).toBe(undefined);
    expect(cleanTiming([1])).toBe(undefined);
  });

  it("the hub's parser keeps a voice line's timing, and drops it on a typed line", () => {
    const raw = {
      type: "chat",
      id: "x",
      text: "hi",
      source: "stt",
      timing: { t_sent: 9, evil: 1 },
    };
    expect(parsePageMessage(JSON.stringify(raw))).toMatchObject({ timing: { t_sent: 9 } });
    expect(parsePageMessage(JSON.stringify({ ...raw, source: undefined }))).not.toHaveProperty(
      "timing",
    );
  });
});

describe("voiceLatency(): the page's store, shared on globalThis", () => {
  it("is one store, logging through the voice session's log", () => {
    const g = globalThis as Record<string, unknown>;
    delete g.__lkLatency;
    const logs: Record<string, unknown>[] = [];
    voice().setLog((e) => logs.push(e));
    const s = voiceLatency();
    expect(voiceLatency()).toBe(s);
    s.sent("v1", "hi", { t_sent: 1 });
    s.heard({ id: "r", from: "agent", at: 2 });
    expect(logs.at(-1)).toMatchObject({ ev: "voice-latency", id: "v1", replied: true });
    delete g.__lkLatency;
  });
});
