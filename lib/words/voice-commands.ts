/**
 * The /words voice mode's grammar and matcher (docs/voice-mode.md): a whole
 * short utterance → one command, or nothing.
 *
 * Rules:
 * - **No questions.** A "?" or a closing 吗/呢/か is never a command.
 * - **Whole utterances only.** The transcript, normalized, must BE a command
 *   phrase (or one STT slip away from a long enough one). A command word
 *   inside a longer sentence never matches: "我觉得下一张更难" is nothing.
 * - **Chinese first**, with English and Japanese synonyms. Simplified and
 *   Traditional both match (toSimplified), and so do the usual STT slips.
 * - **Fuzzy, but never a guess.** One edit is forgiven on CJK phrases of 3+
 *   characters and Latin ones of 7+ letters (2 from 10). Shorter phrases
 *   match exactly. A slip never adds or drops a negation (不/没). Two
 *   commands equally close: no match.
 * - **Only navigation and grading.** Nothing here deletes, changes a
 *   setting or touches the account; the one setting it reaches is turning
 *   voice mode itself off (`exit`).
 *
 * Pure: unit/voice-commands.test.ts.
 */

export type VoiceCommand =
  | "next"
  | "prev"
  | "left"
  | "right"
  | "again"
  | "hard"
  | "good"
  | "easy"
  | "show"
  | "read"
  | "undo"
  | "exit";

export const VOICE_COMMANDS: readonly VoiceCommand[] = [
  "next",
  "prev",
  "left",
  "right",
  "again",
  "hard",
  "good",
  "easy",
  "show",
  "read",
  "undo",
  "exit",
];

/**
 * The grammar: every phrase that means each command, as spoken. zh first
 * (Simplified; Traditional is folded onto it), then en, then ja. 上/下 are
 * the list's up/down (the previous and next card); 左/右 are a one-level
 * swipe (← Hard, → Good), as on the touch slip.
 */
export const GRAMMAR: Record<VoiceCommand, readonly string[]> = {
  next: [
    "下一张",
    "下一个",
    "下一条",
    "下一页",
    "下一题",
    "下一词",
    "下一个词",
    "下个",
    "下张",
    "下",
    "向下",
    "往下",
    "下面",
    "下一章", // STT: 张 → 章
    "下一站",
    "next",
    "nextone",
    "nextcard",
    "down",
    "godown",
    "次",
    "次へ",
    "つぎ",
    "下へ",
    "した",
  ],
  prev: [
    "上一张",
    "上一个",
    "上一条",
    "上一页",
    "上一题",
    "上一词",
    "上一个词",
    "上个",
    "上张",
    "上",
    "向上",
    "往上",
    "上面",
    "上一章",
    "previous",
    "previouscard",
    "back",
    "goback",
    "up",
    "goup",
    "前",
    "前へ",
    "まえ",
    "上へ",
    "うえ",
  ],
  left: ["左", "向左", "往左", "左边", "左滑", "left", "swipeleft", "ひだり"],
  right: ["右", "向右", "往右", "右边", "右滑", "right", "swiperight", "みぎ"],
  again: [
    "重来",
    "从来", // STT: chóng → cóng
    "再来",
    "忘了",
    "忘记了",
    "不记得",
    "不认识",
    "不会",
    "again",
    "もう一度",
    "忘れた",
    "わからない",
  ],
  hard: ["困难", "难", "很难", "有点难", "模糊", "hard", "難しい", "むずかしい"],
  good: ["良好", "记得", "记住了", "认识", "good", "正解", "覚えた", "グッド"],
  easy: ["简单", "容易", "太简单", "很简单", "easy", "簡単", "かんたん"],
  show: [
    "显示答案",
    "答案",
    "看答案",
    "翻面",
    "翻开",
    "揭晓",
    "showanswer",
    "showtheanswer",
    "answer",
    "reveal",
    "flip",
    "答え",
    "答えを見せて",
    "答えを表示",
    "答え表示",
  ],
  read: [
    "再读一遍",
    "再读一次",
    "再读",
    "重读",
    "再念一遍",
    "再说一遍",
    "再听一遍",
    "在读一遍", // STT: 再 → 在
    "再度一遍", // STT: 读 → 度
    "重复",
    "readagain",
    "repeat",
    "sayagain",
    "sayitagain",
    "もう一回",
    "もう一回読んで",
    "読んで",
    "もう一度読んで",
  ],
  undo: ["撤销", "撤回", "回退", "undo", "元に戻す", "取り消し", "とりけし"],
  exit: [
    "退出语音模式",
    "退出语音",
    "关闭语音模式",
    "关闭语音",
    "结束语音模式",
    "停止语音模式",
    "语音模式关闭",
    "exitvoicemode",
    "stopvoicemode",
    "leavevoicemode",
    "voicemodeoff",
    "音声モード終了",
    "音声モードを終了",
    "音声モードオフ",
  ],
};

/**
 * Traditional (and Japanese shinjitai) characters folded onto the Simplified
 * ones the grammar uses: only the ones in or near its phrases. He speaks a mix,
 * and the STT writes either.
 */
const TO_SIMPLIFIED: Record<string, string> = {
  張: "张",
  個: "个",
  条: "条",
  條: "条",
  頁: "页",
  題: "题",
  詞: "词",
  顯: "显",
  顕: "显",
  讀: "读",
  読: "读",
  說: "说",
  説: "说",
  聽: "听",
  銷: "销",
  消: "销",
  語: "语",
  簡: "简",
  單: "单",
  単: "单",
  難: "难",
  來: "来",
  記: "记",
  認: "认",
  識: "识",
  會: "会",
  關: "关",
  閉: "闭",
  結: "结",
  復: "复",
  複: "复",
  開: "开",
  後: "后",
  邊: "边",
  這: "这",
  遍: "遍",
  唸: "念",
  從: "从",
  點: "点",
  章: "章",
  站: "站",
  模: "模",
};

/** Simplified Chinese for the characters the grammar cares about. */
export const toSimplified = (s: string) => [...s].map((c) => TO_SIMPLIFIED[c] ?? c).join("");

/** SenseVoice's `<|zh|><|NEUTRAL|>`-style tags, if any slip through. */
const TAGS = /<\|[^|]*\|>/g;
/** Spoken padding around a command: never part of one. */
const LEAD =
  /^(?:嗯+|啊+|呃+|哦+|噢+|诶+|欸+|哎+|那个|请|麻烦|please|uh+|um+|ok(?:ay)?|えーと|ええと|あの)+/u;
const TRAIL = /(?:吧|呀|啊|啦|嘛|哦|please|ください|して)+$/u;
/** A question is never a command ("下一张吗？", "简单吗", "簡単ですか"). */
const QUESTION = /(?:吗|嗎|么|麼|呢|か|かな)$/u;

/** NFKC, lowercase, Simplified, no tags, punctuation, spaces or padding. */
export function normalizeUtterance(text: string): string {
  const flat = toSimplified(
    text
      .replace(TAGS, "")
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[\p{P}\p{S}\s]/gu, ""),
  );
  const cut = flat.replace(LEAD, "").replace(TRAIL, "");
  // A phrase that is only padding ("啊") stays itself; it matches nothing anyway.
  return cut || flat;
}

/**
 * The longest utterance that can still be a command, normalized: the longest
 * phrase plus one slip. Anything longer is a sentence, never a command.
 */
export const MAX_COMMAND_CHARS = 16;

/** Levenshtein distance (small strings only), by code point. */
export function editDistance(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const row = [i];
    for (let j = 1; j <= y.length; j++)
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[y.length];
}

const isLatin = (s: string) => /^[a-z]+$/.test(s);

/**
 * How many edits a phrase forgives: none under 3 characters, and none on a
 * Latin word under 7 letters ("right" must not take "night" or "light").
 */
export function slack(phrase: string): number {
  const n = [...phrase].length;
  if (isLatin(phrase)) return n >= 10 ? 2 : n >= 7 ? 1 : 0;
  return n >= 3 ? 1 : 0;
}

/** Negations: a slip may never add or drop one ("我记得" is not "不记得"). */
const NEGATION = /不|没|沒|未|別|别|无|無|莫|no|not|dont|never|ない|ません|ず/gu;
const negations = (s: string) => s.match(NEGATION)?.length ?? 0;

/** Each normalized phrase and its command. A phrase in two commands is a bug (tested). */
const PHRASES: readonly { phrase: string; cmd: VoiceCommand }[] = VOICE_COMMANDS.flatMap((cmd) =>
  GRAMMAR[cmd].map((p) => ({ phrase: normalizeUtterance(p), cmd })),
);
const EXACT = new Map(PHRASES.map((p) => [p.phrase, p.cmd]));

export type VoiceMatch = {
  cmd: VoiceCommand;
  /** The grammar phrase it matched (normalized). */
  phrase: string;
  /** Edits between what was heard and that phrase: 0 for an exact match. */
  distance: number;
};

/**
 * The command a whole utterance is, or null: not a command, too long, or
 * equally close to two commands.
 */
export function matchCommand(text: string): VoiceMatch | null {
  const n = normalizeUtterance(text);
  if (!n || [...n].length > MAX_COMMAND_CHARS) return null;
  if (/[?？]/u.test(text) || QUESTION.test(n)) return null;
  const exact = EXACT.get(n);
  if (exact) return { cmd: exact, phrase: n, distance: 0 };
  let best: VoiceMatch | null = null;
  let tie = false;
  for (const { phrase, cmd } of PHRASES) {
    const s = slack(phrase);
    // A slip may change or lose a character, never add one: an added word is
    // a different sentence ("no show answer", "未记住了"), not an STT error.
    if (!s || [...n].length > [...phrase].length || [...phrase].length - [...n].length > s)
      continue;
    // A Latin phrase is matched only by Latin text, and CJK only by CJK.
    if (isLatin(phrase) !== isLatin(n)) continue;
    if (negations(phrase) !== negations(n)) continue;
    const d = editDistance(n, phrase);
    if (d > s) continue;
    if (!best || d < best.distance) {
      best = { cmd, phrase, distance: d };
      tie = false;
    } else if (d === best.distance && cmd !== best.cmd) tie = true;
  }
  return tie ? null : best;
}

/**
 * The utterance starts with the wake word: it is for the agent, so the voice
 * mode lets the chat have it (docs/wake-word.md spellings, as STT writes them).
 */
export function addressesAgent(text: string): boolean {
  const n = toSimplified(
    text
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[\p{P}\p{S}\s]/gu, ""),
  );
  return /^(?:linky|linkie|linki|lenky|林琪|林奇|林基|林其|リンキー|リンキ)/u.test(n);
}

/** The most words a Latin command has ("exit voice mode", "say it again"). */
const MAX_RUN_WORDS = 4;

/** Separators inside a card's meaning ("easy; simple", "简单的，容易的"). */
const PARTS = /[;；,，、/|·・()（）[\]【】「」\n]+/u;

/**
 * The utterance is (nearly) a text of the cards around the focus: the word,
 * its reading or a meaning, as read aloud or as he practises saying it. Such
 * a line is never a command, so an English list's "easy" read aloud does not
 * grade Easy, and a Japanese list's 上 does not move the cursor.
 */
export function isCardEcho(
  text: string,
  cardTexts: readonly (string | undefined)[],
  /**
   * What was just read aloud or is under the focus: here the utterance only
   * has to be IN one of them ("easy" in "easy (not difficult)", 简单 in
   * 简单的), since STT may catch a piece of a longer read.
   */
  spoken: readonly (string | undefined)[] = [],
): boolean {
  const n = normalizeUtterance(text);
  if (!n) return false;
  for (const t of spoken) {
    if (!t) continue;
    const flat = toSimplified(t.normalize("NFKC").toLowerCase());
    // Latin: a run of whole words of it ("go down" in "go down the street",
    // but "up" is not in "cup"), within a slip; CJK: anywhere in it.
    if (/^[a-z]+$/.test(n)) {
      const words = flat.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
      for (let k = 1; k <= MAX_RUN_WORDS; k++)
        for (let i = 0; i + k <= words.length; i++) {
          const run = words.slice(i, i + k).join("");
          if (run === n) return true;
          const sl = Math.min(slack(run), slack(n));
          if (sl && Math.abs(run.length - n.length) <= sl && editDistance(run, n) <= sl)
            return true;
        }
    } else if (flat.replace(/[\p{P}\p{S}\s]/gu, "").includes(n)) return true;
  }
  for (const t of cardTexts) {
    if (!t) continue;
    for (const part of [t, ...t.split(PARTS)]) {
      const p = normalizeUtterance(part);
      if (!p) continue;
      if (p === n) return true;
      const s = Math.min(slack(p), slack(n));
      if (s && Math.abs([...p].length - [...n].length) <= s && editDistance(p, n) <= s) return true;
    }
  }
  return false;
}
