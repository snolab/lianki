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
  MERGE_REOPEN_KEY,
  REOPEN_EDITS,
  joinVerdict,
  mergeLines,
  mergeVerdict,
  passageSpeakers,
  reopenMsOf,
  reopenVerdict,
  splitLine,
  textEnd,
} from "@lianki/debug-chat/voice-merge";
import { MAX_UTTERANCE_MS } from "@lianki/debug-chat/mic";
import { CONFIG } from "@/lib/config";
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

describe("reopen: a posted line takes the speech that follows (stt.mergeReopenSec)", () => {
  const W = 20_000;
  const ok = (v: ReturnType<typeof reopenVerdict>) => (v.ok ? v.signal : v.reason);
  /** His posted line: settled, Whisper re-read, then the hub's own polish. */
  const posted = (over: Partial<ChatMessage> = {}) =>
    prev("我想把按钮放到右边。", {
      settled: true,
      raw: "我想把按钮放到右边。",
      text: "我想把按钮放到右边。",
      edited: { at: 2, by: "auto", count: 1 },
      ...over,
    });

  it("the key, its default and bounds, and the value as read", () => {
    expect(MERGE_REOPEN_KEY).toBe("stt.mergeReopenSec");
    expect(CONFIG[MERGE_REOPEN_KEY]).toMatchObject({ default: 20, min: 0, max: 120, unit: "s" });
    expect(reopenMsOf(20)).toBe(20_000);
    expect(reopenMsOf(0.5)).toBe(500);
    for (const off of [0, -1, 121, Number.NaN, Infinity, "20", undefined, null]) {
      expect(reopenMsOf(off)).toBe(0);
    }
  });

  it("within the window, a settled, re-listened or hub-polished line reopens", () => {
    expect(ok(reopenVerdict(posted(), next("然后把颜色改成红色。", 8000), W))).toBe("reopen");
    expect(ok(reopenVerdict(posted(), next("然后。。改成红色", W), W))).toBe("reopen");
    for (const by of REOPEN_EDITS)
      expect(
        ok(reopenVerdict(posted({ edited: { at: 2, by, count: 0 } }), next("再来。", 5000), W)),
      ).toBe("reopen");
    expect(ok(reopenVerdict(posted({ edited: undefined }), next("再来。", 5000), W))).toBe(
      "reopen",
    );
    // His voiceprint on both, or on neither (no print on the device).
    const me = { decision: "me" as const };
    expect(
      ok(reopenVerdict(posted({ speaker: me }), { ...next("再来。", 5000), speaker: me }, W)),
    ).toBe("reopen");
    // The hub's own clock, when given, may run a whole utterance past the window.
    expect(ok(reopenVerdict(posted(), next("再来。", 5000), W, W + MAX_UTTERANCE_MS))).toBe(
      "reopen",
    );
  });

  it("closed: off, past the window, or by the hub's clock", () => {
    expect(ok(reopenVerdict(posted(), next("再来。", 5000), 0))).toBe("reopen-off");
    expect(ok(reopenVerdict(posted(), next("再来。", W + 1), W))).toBe("gap");
    expect(ok(reopenVerdict(posted(), next("再来。", 5000), W, W + MAX_UTTERANCE_MS + 1))).toBe(
      "gap",
    );
    expect(ok(reopenVerdict(posted({ timing: undefined }), next("再来。", 5000), W))).toBe(
      "no-timing",
    );
    expect(ok(reopenVerdict(posted(), { text: "再来。" }, W))).toBe("no-timing");
  });

  it("closed: not his voice line, not stamped, superseded, or edited by hand", () => {
    const n = next("再来。", 5000);
    expect(ok(reopenVerdict(posted({ from: "agent" }), n, W))).toBe("not-voice");
    expect(ok(reopenVerdict(posted({ source: undefined }), n, W))).toBe("not-voice");
    expect(ok(reopenVerdict(posted({ mergeable: undefined }), n, W))).toBe("not-mergeable");
    const passage = { at: 1, by: "main", ids: ["a", "b"] };
    const summary = { at: 1, by: "main", ids: ["a", "b"] } as ChatMessage["summary"];
    const echo = {
      at: 1,
      by: "auto",
      reason: "echo",
      kind: "read-aloud",
      of: "x",
      sim: 1,
    } as const;
    for (const over of [
      { removed: true as const },
      { collapsedInto: "z" },
      { passage },
      { summary },
      { echo },
    ])
      expect(ok(reopenVerdict(posted(over), n, W))).toBe("superseded");
    expect(ok(reopenVerdict(posted({ edited: { at: 2, by: "main", count: 1 } }), n, W))).toBe(
      "edited",
    );
  });

  it("closed by what any merge refuses, and by a voice the Mac did not sign as his", () => {
    expect(
      ok(
        reopenVerdict(
          posted({ text: "这样可以吗？", raw: "这样可以吗？" }),
          next("再来。", 5000),
          W,
        ),
      ),
    ).toBe("ended");
    expect(ok(reopenVerdict(posted(), { ...next("再来。", 5000), to: "/words" }, W))).toBe(
      "other-node",
    );
    expect(ok(reopenVerdict(posted(), next("行。", 5000), W))).toBe("short-answer");
    const me = { decision: "me" as const };
    expect(ok(reopenVerdict(posted({ speaker: me }), next("再来。", 5000), W))).toBe("unverified");
    expect(
      ok(reopenVerdict(posted(), { ...next("再来。", 5000), speaker: { decision: "unknown" } }, W)),
    ).toBe("unverified");
  });

  it("joinVerdict: a live merge first, then a reopen; both reasons when neither", () => {
    const live = prev("那你能不能给，");
    expect(joinVerdict(live, next("给我。", 1000), W)).toEqual({ ok: true, signal: "open" });
    expect(joinVerdict(live, next("给我。", 5000), 0)).toEqual({ ok: false, reason: "gap" });
    expect(joinVerdict(live, next("给我。", 5000), W)).toEqual({ ok: true, signal: "reopen" });
    expect(joinVerdict(posted(), next("再来。", W + 1), W)).toEqual({
      ok: false,
      reason: "settled; reopen: gap",
    });
  });

  it("the reopened line: heard text again, not settled, its reading gone; undo gives the parts", () => {
    const line = mergeLines(
      prev("我想把按钮。", { timing: { t_speechStart: -900, t_speechEnd: 0 } }),
      { id: "b", at: 2, text: "放到右边。", timing: { t_speechStart: 500, t_speechEnd: 1500 } },
      2,
    );
    const done: ChatMessage = {
      ...line,
      text: "我想把按钮放到右边。",
      raw: "我想把按钮放到右边。",
      settled: true,
      recheck: { at: 3, engine: "mlx-whisper", heard: line.text, text: "我想把按钮放到右边。" },
    };
    const polished = {
      ...done,
      text: "我想把按钮放在右边。",
      edited: { at: 4, by: "auto", count: 1 },
    };
    const cur = {
      id: "c",
      at: 9,
      text: "然后改成红色。",
      timing: { t_speechStart: 9000, t_speechEnd: 10_000 },
    };
    expect(reopenVerdict(polished, cur, W).ok).toBe(true);
    const re = mergeLines(polished, cur, 9);
    expect(re.text).toBe("我想把按钮。放到右边。然后改成红色。");
    expect(re.raw).toBe(re.text);
    expect(re.settled).toBeUndefined();
    expect(re.recheck).toBeUndefined();
    expect(re.edited).toEqual({ at: 9, by: "merge", count: 1 });
    expect(re.parts?.map((p) => p.id)).toEqual(["a", "b", "c"]);
    expect(splitLine(re).map((x) => x.text)).toEqual([
      "我想把按钮。",
      "放到右边。",
      "然后改成红色。",
    ]);
    // A single posted line the hub polished: its part is the text as heard.
    const one = mergeLines(posted({ text: "我想把按钮放在右边。" }), cur, 9);
    expect(one.parts?.map((p) => p.text)).toEqual(["我想把按钮放到右边。", "然后改成红色。"]);
  });
});
