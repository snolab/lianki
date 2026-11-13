/**
 * Continuous speech amends the last line: the verdict, on recorded fixtures only.
 * The transcripts and gaps below are from ~/lianki-voice-clips (his own lines and
 * what the mic measured); nothing here plays or records anything.
 */
import { describe, expect, it } from "bun:test";
import { createMicTaps } from "@lianki/debug-chat/mic-taps";
import { pickTiming } from "@lianki/debug-chat/latency";
import {
  MAX_MERGE_PARTS,
  mergeLines,
  mergeVerdict,
  passageSpeakers,
  splitLine,
  textEnd,
} from "@lianki/debug-chat/voice-merge";
import { isBlip, isShortAnswer } from "@lianki/debug-chat/voice-tune";
import { type ChatMessage, applyEditTo, cleanTiming } from "@lianki/debug-chat/wire";
import { FLAGS } from "@/lib/flags";
import { parsePageMessage } from "@/lib/dev-eval";

const ENDPOINT = 600;
/** A line whose speech ended at 0 on the page's clock; `over`: its own fields. */
const prev = (text: string, over: Partial<ChatMessage> = {}): ChatMessage =>
  ({
    id: "a",
    from: "owner",
    text,
    at: 1,
    source: "stt",
    mergeable: true,
    timing: { t_lastVoice: -ENDPOINT, t_speechEnd: 0 },
    ...over,
  }) as ChatMessage;
/** The next utterance, starting this long after the last one ended. */
const next = (text: string, since: number) => ({ text, timing: { t_speechStart: since } });

describe("textEnd reads punctuation classes, for any script", () => {
  it.each([
    ["这是什么？", "final"],
    ["Is it?", "final"],
    ["行！", "final"],
    ["「本当ですか？」", "final"],
    ["那你能不能给。", "stop"],
    ["Fix it.", "stop"],
    ["きたされですよね。", "stop"],
    ["你翻一下，", "open"],
    ["等一下这要去洗澡了，。", "open"],
    ["and then...", "open"],
    ["no mark at all", "open"],
  ] as const)("%s → %s", (text, end) => expect(textEnd(text)).toBe(end));
});

describe("the verdict on his recorded pairs", () => {
  const me = { speaker: { decision: "me" as const } };
  // gap: speech end → next start, as the clips measured it (with the 800 ms pad).
  const pairs: [string, string, number, boolean][] = [
    // Heard as one thought, resumed inside the VAD's own silence, both signed as him.
    ["甚至你之前一直让我。", "写的那个一同意用打字来发", 700, true],
    ["我觉得你需要有一个小盒子。", "然后每一个月清理一次的小票。", 700, true],
    [
      "在这回到现在的这个项目，你帮我加一个背景音乐的功能。",
      "这样我就可以边听歌边学习了。",
      700,
      true,
    ],
    // A clause mark at the end: the wider window.
    ["等一下这要去洗澡了，。", "该去洗澡吧。", 1800, true],
    // A plain stop and over a second of real pause: stays two lines, the conservative side.
    ["现在这几个agent。", "的权限都是很大的。", 1100, false],
    ["我看到了 Y INZAI。", "那个是用来记账的，你翻一下他是哪个仓库。", 2800, false],
    // A question ended it, however soon the next one came.
    ["他是內置知識多語言的嗎?", "語音識別模型是Whisper", 700, false],
    ["我们现在用的是流失传输吗？", "是什么模型？", 4000, false],
    // Separate thoughts, long pauses.
    ["你再好好想想，我是开发者。", "我要求你申请，你就显示一个申请界面。", 4500, false],
    ["我要求你申请，你就显示一个申请界面。", "没有必要麻烦我去打字。", 10800, false],
  ];
  it.each(pairs)("%s | %s (%d ms) → %p", (a, b, since, merge) => {
    expect(mergeVerdict(prev(a, me), { ...next(b, since), ...me }).ok).toBe(merge);
  });

  it("the owner's example merges when he goes straight on, signed as him", () => {
    const b = next("给我显示一个按钮。", 500);
    expect(mergeVerdict(prev("那你能不能给。", me), { ...b, ...me })).toEqual({
      ok: true,
      signal: "quick",
    });
    // Unsigned, or one side not sure: it stays two lines.
    const no = { ok: false as const, reason: "unverified" };
    expect(mergeVerdict(prev("那你能不能给。"), b)).toEqual(no);
    expect(mergeVerdict(prev("那你能不能给。", me), b)).toEqual(no);
    expect(
      mergeVerdict(prev("那你能不能给。", me), { ...b, speaker: { decision: "unknown" } }),
    ).toEqual(no);
  });

  it("room talk restarting the VAD at once does not join a request (recorded, a real miss)", () => {
    const a = prev("从le点comm这个 app这里跳转过去。");
    expect(mergeVerdict(a, next("谁给你咖啡放名箱吗。", 700)).ok).toBe(false);
  });

  it("a capture cut by the cap gets the wider window, whatever its text says", () => {
    const cut = { t_lastVoice: -ENDPOINT, t_speechEnd: 0, t_cut: -1 };
    expect(mergeVerdict(prev("很长的一段。", { timing: cut }), next("接着说。", 2400))).toEqual({
      ok: true,
      signal: "cut",
    });
    expect(mergeVerdict(prev("很长的一段。", { timing: cut }), next("接着说。", 2600)).ok).toBe(
      false,
    );
  });

  it("what the verdict refuses", () => {
    const go = next("接着说。", 500);
    const why = (m: ChatMessage, c = go as Parameters<typeof mergeVerdict>[1]) => {
      const v = mergeVerdict(m, c);
      return v.ok ? "ok" : v.reason;
    };
    expect(why(prev("x。", { source: undefined }))).toBe("not-voice");
    expect(why(prev("x。", { from: "agent" }))).toBe("not-voice");
    expect(why(prev("x。", { mergeable: undefined }))).toBe("not-mergeable");
    expect(why(prev("x。", { settled: true }))).toBe("settled");
    expect(why(prev("x。", { to: "/words" }))).toBe("other-node");
    expect(why(prev("x。", { wake: "passive" }))).toBe("wake");
    expect(why(prev("x。"), { ...go, wake: "passive" })).toBe("wake");
    expect(why(prev("x。"), { ...go, context: { selection: "s" } } as never)).toBe("attached");
    expect(why(prev("x。", { speaker: { decision: "other" } }))).toBe("speaker");
    expect(why(prev("x。"), { ...go, speaker: { decision: "other" } })).toBe("speaker");
    expect(why(prev("yes."))).toBe("short-answer");
    expect(why(prev("x。"), next("是。", 500))).toBe("short-answer");
    expect(why(prev("x。", { timing: undefined }))).toBe("no-timing");
    expect(why(prev("x。"), { text: "y。" })).toBe("no-timing");
    expect(why(prev("x。"))).toBe("unverified");
    expect(why(prev("字".repeat(3999)))).toBe("long");
    const parts = Array.from({ length: MAX_MERGE_PARTS }, (_, i) => ({
      id: String(i),
      text: "x。",
      at: i,
      timing: { t_lastVoice: -ENDPOINT, t_speechEnd: 0 },
    }));
    expect(why(prev("x。", { parts }))).toBe("parts");
  });
});

describe("merging and splitting", () => {
  it("raw only: a polish of the first part is dropped, its raw kept", () => {
    const line = prev("Hello, world.", {
      raw: "hello world.",
      edited: { at: 2, by: "lane", count: 1 },
    });
    const m = mergeLines(line, { id: "b", at: 3, text: "and more." }, 3);
    expect(m).toMatchObject({
      id: "a",
      at: 1,
      text: "hello world. and more.",
      raw: "hello world. and more.",
      edited: { at: 3, by: "merge", count: 1 },
    });
    expect(m.parts?.map((p) => p.text)).toEqual(["hello world.", "and more."]);
    const again = mergeLines(m, { id: "c", at: 4, text: "and more still." }, 4);
    expect(again.parts?.map((p) => p.id)).toEqual(["a", "b", "c"]);
    expect(again.raw).toBe("hello world. and more. and more still.");
  });

  it("the speaker tag: weakest of the parts, and an unverified part leaves none", () => {
    const line = prev("x，", { speaker: { decision: "me" } });
    expect(mergeLines(line, { id: "b", at: 2, text: "y" }, 2).speaker).toBeUndefined();
    expect(
      mergeLines(line, { id: "b", at: 2, text: "y", speaker: { decision: "unknown" } }, 2).speaker
        ?.decision,
    ).toBe("unknown");
    expect(
      mergeLines(line, { id: "b", at: 2, text: "y", speaker: { decision: "me" } }, 2).speaker
        ?.decision,
    ).toBe("me");
  });

  it("CJK joins with no space; split gives back each line as sent, with no stamp", () => {
    const m = mergeLines(
      prev("那你能不能给。"),
      { id: "b", at: 3, text: "给我显示一个按钮。", timing: { t_speechStart: 500 } },
      3,
    );
    expect(m.text).toBe("那你能不能给。给我显示一个按钮。");
    const back = splitLine(m);
    expect(back.map((x) => [x.id, x.text, x.at])).toEqual([
      ["a", "那你能不能给。", 1],
      ["b", "给我显示一个按钮。", 3],
    ]);
    for (const x of back) {
      expect(x.mergeable).toBeUndefined();
      expect(x.edited).toBeUndefined();
      expect(x.parts).toBeUndefined();
      expect(x.source).toBe("stt");
    }
    expect(back[1].timing).toEqual({ t_speechStart: 500 });
  });
});

describe("a page applying the events", () => {
  const line = prev("那你能不能给，");
  const reply = { id: "r", from: "agent", text: "ok", at: 9, label: "" } as ChatMessage;
  const merged = mergeLines(line, { id: "b", at: 3, text: "给我。" }, 3);
  const mark = merged.edited as NonNullable<ChatMessage["edited"]>;

  it("a merge changes the line in place, carrying its parts", () => {
    const out = applyEditTo([{ ...line, thread: "owner" }, reply], {
      id: "a",
      thread: "owner",
      text: merged.text,
      raw: merged.text,
      edited: mark,
      parts: merged.parts,
    });
    expect(out.map((m) => m.id)).toEqual(["a", "r"]);
    expect(out[0].text).toBe("那你能不能给，给我。");
    expect(out[0].parts).toHaveLength(2);
  });

  it("an undo puts the split lines where the line was, before the reply", () => {
    const out = applyEditTo([{ ...merged, thread: "owner" }, reply], {
      id: "a",
      thread: "owner",
      text: "那你能不能给，",
      raw: "那你能不能给，",
      edited: mark,
      split: splitLine(merged),
    });
    expect(out.map((m) => m.id)).toEqual(["a", "b", "r"]);
    expect(out[0].parts).toBeUndefined();
  });
});

describe("what the merge relies on", () => {
  it("a line's start is its first utterance's; marks survive the wire", () => {
    const marks = new Map([
      [1, { t_speechStart: 100, t_speechEnd: 200, t_sttDone: 250 }],
      [2, { t_speechStart: 300, t_speechEnd: 400, t_sttDone: 450, t_cut: 390 }],
    ]);
    const p = pickTiming(marks, 500);
    expect(p?.timing.t_speechStart).toBe(100);
    expect(p?.timing.t_cut).toBe(390);
    expect(cleanTiming(p?.timing)).toMatchObject({ t_speechStart: 100, t_cut: 390 });
  });

  it("a command kept by a tap counts, so it keeps two lines apart", () => {
    const taps = createMicTaps();
    taps.tap((t) => t === "下一张");
    expect(taps.kept()).toBe(0);
    expect(taps.offer("给我显示一个按钮")).toBe(false);
    expect(taps.kept()).toBe(0);
    expect(taps.offer("下一张")).toBe(true);
    expect(taps.kept()).toBe(1);
  });

  it("the wire: `continues` only on a voice line; the two new page messages parse", () => {
    const chat = (o: object) =>
      parsePageMessage(JSON.stringify({ type: "chat", id: "b", text: "x", ...o }));
    expect(chat({ source: "stt", continues: "a" })).toMatchObject({ continues: "a" });
    expect(chat({ continues: "a" })).not.toHaveProperty("continues");
    expect(parsePageMessage(JSON.stringify({ type: "passage-end" }))).toEqual({
      type: "passage-end",
    });
    expect(parsePageMessage(JSON.stringify({ type: "unmerge", id: "a" }))).toEqual({
      type: "unmerge",
      id: "a",
    });
    expect(parsePageMessage(JSON.stringify({ type: "unmerge" }))).toBeNull();
  });

  it("the blip guard is unchanged by the short-answer split", () => {
    expect(isBlip("yes")).toBe(false);
    expect(isBlip("hmm")).toBe(true);
    expect(isBlip("嗯")).toBe(true);
    expect(isShortAnswer("Yes.")).toBe(true);
    expect(isShortAnswer("好的那就这样")).toBe(false);
  });

  it("the flag is registered, default off", () => {
    expect(FLAGS["stt.merge"].default).toBe(false);
  });
});

describe("passageSpeakers: a merged passage keeps one speaker (owner, 2026-11-13)", () => {
  const line = (id: string, decision?: "me" | "other" | "unknown") => ({
    id,
    ...(decision ? { speaker: { decision } } : {}),
  });

  it("his verified lines merge; so do lines none of which is verified", () => {
    expect(passageSpeakers([line("a", "me"), line("b", "me")])).toBeUndefined();
    expect(
      passageSpeakers([line("a", "unknown"), line("b"), line("c", "unknown")]),
    ).toBeUndefined();
  });

  it("never someone else's line, and never his ✓ over a line not verified as his", () => {
    // A final split by speaker: her part, then his. The polish must not join them again.
    expect(passageSpeakers([line("her", "other"), line("his", "me")])).toContain("message her");
    expect(passageSpeakers([line("a", "other"), line("b", "other")])).toContain("someone else's");
    expect(passageSpeakers([line("a", "me"), line("b", "unknown")])).toContain("message b");
    expect(passageSpeakers([line("a"), line("b", "me")])).toContain("message a");
  });
});
