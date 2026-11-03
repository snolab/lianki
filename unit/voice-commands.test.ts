import { describe, expect, it } from "bun:test";
import {
  GRAMMAR,
  MAX_COMMAND_CHARS,
  VOICE_COMMANDS,
  type VoiceCommand,
  addressesAgent,
  editDistance,
  isCardEcho,
  matchCommand,
  normalizeUtterance,
  slack,
  toSimplified,
} from "@/lib/words/voice-commands";
import {
  COMMAND_ACTIONS,
  type VoiceActions,
  handleUtterance,
  isShown,
  voiceTap,
} from "@/lib/words/voice-dispatch";
import { levelRating } from "@/lib/words/swipe";

const cmd = (t: string) => matchCommand(t)?.cmd ?? null;

describe("voice grammar", () => {
  it("every phrase belongs to exactly one command, and matches it exactly", () => {
    const owner = new Map<string, VoiceCommand>();
    for (const c of VOICE_COMMANDS)
      for (const p of GRAMMAR[c]) {
        const n = normalizeUtterance(p);
        expect(n.length).toBeGreaterThan(0);
        expect([...n].length).toBeLessThanOrEqual(MAX_COMMAND_CHARS);
        const had = owner.get(n);
        if (had && had !== c) throw new Error(`"${p}" is in both ${had} and ${c}`);
        owner.set(n, c);
        expect(matchCommand(p)).toEqual({ cmd: c, phrase: n, distance: 0 });
      }
  });

  it("covers the owner's list: directions, previous/next, grades, answer, read, undo, exit", () => {
    const want: [string, VoiceCommand][] = [
      ["上", "prev"],
      ["下", "next"],
      ["左", "left"],
      ["右", "right"],
      ["上一张", "prev"],
      ["下一张", "next"],
      ["重来", "again"],
      ["困难", "hard"],
      ["良好", "good"],
      ["简单", "easy"],
      ["显示答案", "show"],
      ["再读一遍", "read"],
      ["撤销", "undo"],
      ["退出语音模式", "exit"],
    ];
    for (const [t, c] of want) expect(cmd(t)).toBe(c);
  });

  it("takes English and Japanese synonyms", () => {
    expect(cmd("Next.")).toBe("next");
    expect(cmd("Previous")).toBe("prev");
    expect(cmd("Show answer")).toBe("show");
    expect(cmd("Read again!")).toBe("read");
    expect(cmd("Exit voice mode")).toBe("exit");
    expect(cmd("Again")).toBe("again");
    expect(cmd("Easy.")).toBe("easy");
    expect(cmd("次へ")).toBe("next");
    expect(cmd("もう一度")).toBe("again");
    expect(cmd("難しい")).toBe("hard");
    expect(cmd("正解")).toBe("good");
    expect(cmd("簡単")).toBe("easy");
    expect(cmd("答えを見せて")).toBe("show");
    expect(cmd("もう一回")).toBe("read");
    expect(cmd("元に戻す")).toBe("undo");
    expect(cmd("音声モード終了")).toBe("exit");
  });

  it("folds Traditional onto Simplified", () => {
    expect(toSimplified("下一張")).toBe("下一张");
    expect(cmd("下一張")).toBe("next");
    expect(cmd("上一個")).toBe("prev");
    expect(cmd("顯示答案")).toBe("show");
    expect(cmd("再讀一遍")).toBe("read");
    expect(cmd("撤銷")).toBe("undo");
    expect(cmd("退出語音模式")).toBe("exit");
    expect(cmd("困難")).toBe("hard");
    expect(cmd("簡單")).toBe("easy");
    expect(cmd("重來")).toBe("again");
  });

  it("strips punctuation, SenseVoice tags and spoken padding", () => {
    expect(normalizeUtterance("<|zh|><|NEUTRAL|>下一张。")).toBe("下一张");
    expect(cmd("嗯，下一张吧。")).toBe("next");
    expect(cmd("请显示答案")).toBe("show");
    expect(cmd("Okay, next please")).toBe("next");
    expect(cmd("答えを表示してください")).toBe("show");
    // Only padding: itself, matching nothing.
    expect(normalizeUtterance("啊")).toBe("啊");
    expect(cmd("啊")).toBeNull();
    expect(cmd("")).toBeNull();
    expect(cmd("。")).toBeNull();
  });

  it("forgives one STT slip on longer phrases", () => {
    expect(matchCommand("再读一边")).toEqual({ cmd: "read", phrase: "再读一遍", distance: 1 });
    expect(cmd("显示答按")).toBe("show");
    expect(cmd("退出语音魔式")).toBe("exit");
    expect(cmd("previus")).toBe("prev");
    expect(cmd("show the answer")).toBe("show");
  });

  it("never fuzzes short phrases, Latin words under 7 letters, or a negation", () => {
    expect(slack("下")).toBe(0);
    expect(slack("简单")).toBe(0);
    expect(slack("下一张")).toBe(1);
    expect(slack("right")).toBe(0);
    expect(slack("previous")).toBe(1);
    expect(slack("showanswer")).toBe(2);
    expect(cmd("night")).toBeNull();
    expect(cmd("light")).toBeNull();
    expect(cmd("goods")).toBeNull();
    expect(cmd("简")).toBeNull();
    expect(cmd("我记得")).toBeNull(); // not 不记得 (Again)
    expect(cmd("我认识")).toBeNull(); // not 不认识
    expect(cmd("记得了吗")).toBeNull();
  });

  it("never takes an added word or a question as a slip (review, 2026-11-02)", () => {
    expect(cmd("no show answer")).toBeNull();
    expect(cmd("don't show answer")).toBeNull();
    expect(cmd("未记住了")).toBeNull();
    expect(cmd("很简单吗")).toBeNull();
    expect(cmd("简单吗")).toBeNull();
    expect(cmd("下一张吗")).toBeNull();
    expect(cmd("下一张？")).toBeNull();
    expect(cmd("Next?")).toBeNull();
    expect(cmd("簡単ですか")).toBeNull();
    expect(cmd("答えを表示しない")).toBeNull();
    // A lost character is still a slip.
    expect(cmd("显示答")).toBe("show");
  });

  it("takes a grade only exactly as said (review of 8f57caa8)", () => {
    expect(cmd("有点累")).toBeNull(); // not 有点难 (Hard)
    expect(cmd("很简短")).toBeNull(); // not 很简单 (Easy)
    expect(cmd("太简丹")).toBeNull();
    expect(cmd("有点难")).toBe("hard");
  });

  it("refuses a slip equally close to two commands", () => {
    // 啥一张: one edit from both 上一张 (prev) and 下一张 (next).
    expect(cmd("啥一张")).toBeNull();
    expect(cmd("上一站")).toBeNull(); // 上一张 (prev) / 下一站 (next)
  });

  it("never acts on a command inside a longer sentence", () => {
    expect(cmd("我觉得下一张更难")).toBeNull();
    expect(cmd("这个单词很简单但是我总是忘记")).toBeNull();
    expect(cmd("please show me the answer to this one now")).toBeNull();
    expect(cmd("今天的复习先到这里退出语音模式吧好不好")).toBeNull();
    expect(cmd("next time")).toBeNull();
    expect(cmd("is it easy")).toBeNull();
    expect(cmd("x".repeat(MAX_COMMAND_CHARS + 1))).toBeNull();
  });

  it("measures edits by code point", () => {
    expect(editDistance("", "abc")).toBe(3);
    expect(editDistance("下一张", "下一章")).toBe(1);
    expect(editDistance("kitten", "sitting")).toBe(3);
  });

  it("knows a line for the agent", () => {
    expect(addressesAgent("Linky, what's next?")).toBe(true);
    expect(addressesAgent("林琪，下一张")).toBe(true);
    expect(addressesAgent("リンキー")).toBe(true);
    expect(addressesAgent("下一张")).toBe(false);
  });

  it("knows a card's own text, read aloud or practised", () => {
    const card = ["easy", undefined, "容易的；简单的", "It was easy."];
    expect(isCardEcho("Easy.", card)).toBe(true);
    expect(isCardEcho("简单的", card)).toBe(true);
    expect(isCardEcho("简单", card)).toBe(false); // the command, not the meaning
    expect(isCardEcho("下一张", card)).toBe(false);
    expect(isCardEcho("", card)).toBe(false);
    expect(isCardEcho("上", ["上", "うえ", "up; above"])).toBe(true);
    expect(isCardEcho("下一章", ["下一章"])).toBe(true);
    expect(isCardEcho("下一张", ["下一章节"])).toBe(false);
    expect(isCardEcho("显示答按", ["显示答案"])).toBe(true); // within a slip
    expect(isCardEcho("next", ["", "。"])).toBe(false);
  });

  it("knows a piece of what the focused card reads aloud (review, 2026-11-02)", () => {
    expect(isCardEcho("easy", [], ["easy (not difficult)"])).toBe(true);
    expect(isCardEcho("Good.", [], ["Good. See you tomorrow!"])).toBe(true);
    expect(isCardEcho("简单", [], ["简单的；容易的"])).toBe(true);
    expect(isCardEcho("up", [], ["a cup of tea"])).toBe(false); // whole words only
    expect(isCardEcho("previous", [], ["the-previous-day"])).toBe(true);
    expect(isCardEcho("下一张", [], [undefined, "猫"])).toBe(false);
    // A run of its words, within a slip (review of 7e2dedff).
    expect(isCardEcho("go down", [], ["go down the street"])).toBe(true);
    expect(isCardEcho("Go back.", [], ["Go back home!"])).toBe(true);
    expect(isCardEcho("previus", [], ["the previous day"])).toBe(true);
    expect(isCardEcho("show answer", [], ["Show your answer"])).toBe(false);
    expect(isCardEcho("next", [], ["context"])).toBe(false);
    // CJK within a slip (review of 8f57caa8).
    expect(isCardEcho("下一章", [], ["请看下一张图片"])).toBe(true);
    expect(isCardEcho("再读一边", [], ["请再读一遍这个句子"])).toBe(true);
    expect(isCardEcho("撤销", [], ["撤回"])).toBe(false); // two characters: exact only
  });
});

function fakeActions() {
  const calls: string[] = [];
  const actions: VoiceActions = {
    move: (d) => void calls.push(`move ${d}`),
    grade: (r) => void calls.push(`grade ${r}`),
    show: () => void calls.push("show"),
    read: () => void calls.push("read"),
    undo: () => void calls.push("undo"),
    exit: () => void calls.push("exit"),
  };
  return { calls, actions };
}

describe("voice commands → the study view's actions", () => {
  it("maps each command to one action; ← and → are the one-level swipe grades", () => {
    const want: Record<VoiceCommand, string> = {
      next: "move 1",
      prev: "move -1",
      left: `grade ${levelRating(-1)}`,
      right: `grade ${levelRating(1)}`,
      again: "grade 1",
      hard: "grade 2",
      good: "grade 3",
      easy: "grade 4",
      show: "show",
      read: "read",
      undo: "undo",
      exit: "exit",
    };
    for (const c of VOICE_COMMANDS) {
      const f = fakeActions();
      COMMAND_ACTIONS[c](f.actions);
      expect(f.calls).toEqual([want[c]]);
    }
    expect(levelRating(-1)).toBe(2);
    expect(levelRating(1)).toBe(3);
  });

  it("左/右 follow the visible side: mirrored, 左 is Good and 右 is Hard", () => {
    for (const [mirror, left, right] of [
      [false, 2, 3],
      [true, 3, 2],
    ] as const) {
      for (const [said, want] of [
        ["左", left],
        ["右滑", right],
      ] as const) {
        const f = fakeActions();
        const o = handleUtterance(said, {
          actions: f.actions,
          cardTexts: [],
          hasCard: true,
          mirror,
        });
        expect(o.kind).toBe("done");
        expect(f.calls).toEqual([`grade ${want}`]);
      }
      // The named grades never move: 容易 is Easy either way.
      const f = fakeActions();
      handleUtterance("容易", { actions: f.actions, cardTexts: [], hasCard: true, mirror });
      expect(f.calls).toEqual(["grade 4"]);
    }
  });

  it("runs a command and reports it", () => {
    const f = fakeActions();
    const o = handleUtterance(" 下一张。 ", {
      actions: f.actions,
      cardTexts: ["猫"],
      hasCard: true,
    });
    expect(o).toEqual({ kind: "done", cmd: "next", heard: "下一张。" });
    expect(f.calls).toEqual(["move 1"]);
    expect(isShown(o)).toBe(true);
  });

  it("does nothing on what is not a command, and shows nothing", () => {
    const f = fakeActions();
    const o = handleUtterance("我觉得这个很难", {
      actions: f.actions,
      cardTexts: [],
      hasCard: true,
    });
    expect(o).toEqual({ kind: "unknown", heard: "我觉得这个很难" });
    expect(f.calls).toEqual([]);
    expect(isShown(o)).toBe(false);
  });

  it("does nothing on a card's own word read aloud", () => {
    const f = fakeActions();
    const o = handleUtterance("Easy", {
      actions: f.actions,
      cardTexts: ["easy", "容易的"],
      hasCard: true,
    });
    expect(o).toEqual({ kind: "echo", cmd: "easy", heard: "Easy" });
    expect(f.calls).toEqual([]);
  });

  it("does nothing when the focused card's read-aloud holds the command", () => {
    const f = fakeActions();
    const o = handleUtterance("easy", {
      actions: f.actions,
      cardTexts: [],
      spoken: ["easy (not difficult)"],
      hasCard: true,
    });
    expect(o.kind).toBe("echo");
    expect(f.calls).toEqual([]);
  });

  it("always lets voice mode be left, even when it echoes a card", () => {
    const f = fakeActions();
    const o = handleUtterance("退出语音模式", {
      actions: f.actions,
      cardTexts: ["退出语音模式"],
      hasCard: false,
    });
    expect(o.kind).toBe("done");
    expect(f.calls).toEqual(["exit"]);
  });

  it("needs a card for grades, the answer and reading; not for moving or undo", () => {
    for (const [t, kind] of [
      ["良好", "no-card"],
      ["显示答案", "no-card"],
      ["再读一遍", "no-card"],
      ["右", "no-card"],
      ["下一张", "done"],
      ["撤销", "done"],
    ] as const) {
      const f = fakeActions();
      expect(handleUtterance(t, { actions: f.actions, cardTexts: [], hasCard: false }).kind).toBe(
        kind,
      );
      expect(f.calls.length).toBe(kind === "done" ? 1 : 0);
    }
  });

  it("hands a line for the agent back to the chat", () => {
    const f = fakeActions();
    const o = handleUtterance("Linky, 下一张", {
      actions: f.actions,
      cardTexts: [],
      hasCard: true,
    });
    expect(o).toEqual({ kind: "agent" });
    expect(isShown(o)).toBe(false);
    expect(f.calls).toEqual([]);
  });

  it("reaches nothing but the six actions", () => {
    // The surface voice can touch: no delete, settings or account action exists to call.
    expect(Object.keys(fakeActions().actions).sort()).toEqual(
      ["exit", "grade", "move", "read", "show", "undo"].sort(),
    );
  });
});

describe("voice mode never stands between him and the chat (2026-11-03)", () => {
  /** One final transcript through the screen's tap: what ran, what showed, and whether the chat gets it. */
  const route = (t: string, hasCard = true, actions?: Partial<VoiceActions>) => {
    const f = fakeActions();
    const shown: string[] = [];
    const tap = voiceTap(
      (text) =>
        handleUtterance(text, { actions: actions ?? f.actions, cardTexts: ["猫", "cat"], hasCard }),
      (o) => void shown.push(o.kind),
    );
    const kept = tap(t);
    return { ran: f.calls, shown, toChat: !kept };
  };

  it("sends a sentence to the chat and runs nothing, even when it holds a command word", () => {
    for (const t of [
      "把左边那个改一下",
      "左边那个按钮太小了",
      "那个左边",
      "下一张卡片的读音不对",
      "我觉得下一张更难",
      "右边的字看不清楚",
      "这个太简单了，换难一点的",
      "撤销按钮在哪里",
      "简单吗？",
      "上面那行字有点大",
      "答案的字体能不能大一点",
      "重复的单词太多了",
      "please make the left button bigger",
      "the next card is wrong",
      "is this easy?",
      "undo the last change in the chat",
      "go back to the previous page and fix the font",
      "左のボタンをもう少し大きくして",
      "次のカードの読み方が違う",
      "あの右のやつ",
      "簡単ですか",
      "答えの文字が小さい",
    ]) {
      expect([t, route(t)]).toEqual([t, { ran: [], shown: [], toChat: true }]);
    }
  });

  it("runs a short utterance that is exactly a command, and keeps it from the chat (no agent turn)", () => {
    for (const [t, call] of [
      ["下一张", "move 1"],
      ["下一张。", "move 1"],
      ["嗯，下一张", "move 1"],
      ["下一张吧", "move 1"],
      ["左！", `grade ${levelRating(-1)}`],
      ["右。", `grade ${levelRating(1)}`],
      ["简单", "grade 4"],
      ["Easy.", "grade 4"],
      ["Next", "move 1"],
      ["um, next", "move 1"],
      ["previous", "move -1"],
      ["Show answer", "show"],
      ["次へ", "move 1"],
      ["えーと、次", "move 1"],
      ["簡単", "grade 4"],
      ["答えを表示してください", "show"],
      ["撤销", "undo"],
      ["<|zh|><|NEUTRAL|>下一张。", "move 1"],
    ] as const) {
      expect([t, route(t)]).toEqual([t, { ran: [call], shown: ["done"], toChat: false }]);
    }
  });

  it("confirms a command that did nothing (a card's own word, no card yet), kept from the chat", () => {
    const f = fakeActions();
    const shown: string[] = [];
    const tap = voiceTap(
      (t) => handleUtterance(t, { actions: f.actions, cardTexts: ["easy"], hasCard: true }),
      (o) => void shown.push(o.kind),
    );
    expect(tap("easy")).toBe(true);
    expect([shown, f.calls]).toEqual([["echo"], []]);
    expect(route("良好", false)).toEqual({ ran: [], shown: ["no-card"], toChat: false });
  });

  it("hands every line for the agent to the chat, and runs nothing", () => {
    for (const t of ["Linky, 下一张", "林琪，把左边那个改一下", "linky next"])
      expect(route(t)).toEqual({ ran: [], shown: [], toChat: true });
  });

  it("runs only what the current screen registered: /review has the grades and exit", () => {
    const calls: string[] = [];
    const review: Partial<VoiceActions> = {
      grade: (r) => void calls.push(`grade ${r}`),
      exit: () => void calls.push("exit"),
    };
    for (const t of ["良好", "右", "下一张", "显示答案", "撤销", "退出语音模式"])
      route(t, true, review);
    expect(calls).toEqual(["grade 3", `grade ${levelRating(1)}`, "exit"]);
    // Unregistered commands are plain lines for the chat, with nothing shown.
    expect(route("下一张", true, review)).toEqual({ ran: [], shown: [], toChat: true });
    // A screen that registers nothing: everything is the chat's.
    for (const t of ["下一张", "良好", "退出语音模式"])
      expect(route(t, true, {})).toEqual({ ran: [], shown: [], toChat: true });
  });
});

describe("who gets the voice mode switch", () => {
  it("everyone with the flag on; only the owner (a preview) with it off", async () => {
    const { voiceAccess } = await import("@/lib/words/voice-access");
    expect(voiceAccess({ "words.voice-mode": true }, false)).toBe("on");
    expect(voiceAccess({ "words.voice-mode": true }, true)).toBe("on");
    expect(voiceAccess({}, true)).toBe("preview");
    expect(voiceAccess({}, false)).toBe("off");
    expect(voiceAccess(null, false)).toBe("off");
    expect(voiceAccess({ "words.voice-mode": false }, true)).toBe("preview");
  });
});
