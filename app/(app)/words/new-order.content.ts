import { t, type DeclarationContent } from "intlayer";
import { describeKeys } from "@/lib/i18n-context";

/**
 * "How new words come": the settings a parent list (a group with lists under
 * it) uses to share new words among its children, with the live preview
 * (docs/new-word-scheduler.md). Shown on the owner-only simulator
 * /dev/new-order now, and later in a group row's ⋯ menu on /words. English,
 * Chinese and Japanese for now; the other locales fall back to English until
 * `intlayer fill` runs with the context below.
 */
const dictionary = {
  key: "new-order",
  content: {
    title: t({ en: "New-word order", zh: "新词顺序", ja: "新しい単語の順番" }),
    intro: t({
      en: "Try how new words are shared among the lists. Nothing is saved, and the real study order does not change.",
      zh: "试试新词在各个列表之间怎么分配。什么都不会保存，真正的学习顺序也不会变。",
      ja: "新しい単語がリストの間でどう配られるかを試せます。何も保存されず、実際の学習順も変わりません。",
    }),
    treeLabel: t({ en: "Lists", zh: "列表", ja: "リスト" }),
    presetFull: t({
      en: "Japanese N5–N1 + French top 500 / 1000 / 5000",
      zh: "日语 N5–N1 + 法语前 500 / 1000 / 5000",
      ja: "日本語 N5–N1 + フランス語 上位 500 / 1000 / 5000",
    }),
    presetJa: t({ en: "Japanese N5–N1 only", zh: "只有日语 N5–N1", ja: "日本語 N5–N1 のみ" }),
    presetFlat: t({
      en: "Lists at the top level, no language groups",
      zh: "列表都在最上层，没有语言分组",
      ja: "リストが最上位に並ぶ（言語グループなし）",
    }),
    myLists: t({
      en: "My lists (read-only)",
      zh: "我的列表（只读）",
      ja: "自分のリスト（読み取りのみ）",
    }),
    loading: t({ en: "Loading your lists…", zh: "正在读取你的列表…", ja: "リストを読み込み中…" }),
    allLists: t({ en: "All lists", zh: "所有列表", ja: "すべてのリスト" }),
    howNew: t({ en: "How new words come", zh: "新词怎么来", ja: "新しい単語の出し方" }),
    inherit: t({
      en: "Same as above ({mode})",
      zh: "跟上一级一样（{mode}）",
      ja: "上と同じ（{mode}）",
    }),
    modeSeq: t({ en: "In order", zh: "按顺序", ja: "順番に" }),
    modeRr: t({ en: "Take turns", zh: "轮流", ja: "交互に" }),
    modeStagger: t({ en: "Staggered", zh: "错开", ja: "ずらして重ねる" }),
    modeWeighted: t({ en: "By weight", zh: "按权重", ja: "重みで" }),
    modeSeqHint: t({
      en: "The next list opens when this one passes ({pct}% progress).",
      zh: "这一个及格（进度 {pct}%）后，下一个才开始。",
      ja: "このリストが合格（進み具合 {pct}%）したら次が始まります。",
    }),
    modeWeightedHint: t({
      en: "All lists at once; more weight, more new words.",
      zh: "所有列表同时进行；权重越大，新词越多。",
      ja: "すべて同時に。重いほど新しい単語が多く出ます。",
    }),
    modeRrHint: t({
      en: "The lists take turns, one new word each.",
      zh: "各列表轮流，每次一个新词。",
      ja: "リストが交互に一語ずつ出します。",
    }),
    modeStaggerHint: t({
      en: "Opens like In order, then the open lists overlap; earlier lists get more.",
      zh: "和按顺序一样及格才开，之后已开的列表并行；靠前的分得更多。",
      ja: "開き方は「順番に」と同じ。開いたリストは重なって進み、前のほど多く出ます。",
    }),
    passAt: t({
      en: "Pass mark: {pct}% progress",
      zh: "及格线：进度 {pct}%",
      ja: "合格ライン：進み具合 {pct}%",
    }),
    ratio: t({
      en: "Each list gets ×{r} the share of the next",
      zh: "每个列表的份额是下一个的 ×{r}",
      ja: "各リストは次のリストの ×{r} の割合",
    }),
    weight: t({ en: "Weight", zh: "权重", ja: "重み" }),
    weightOf: t({ en: "Weight of {name}", zh: "{name} 的权重", ja: "{name} の重み" }),
    stats: t({
      en: "{seen}/{size} seen · progress {pct}%",
      zh: "已看 {seen}/{size} · 进度 {pct}%",
      ja: "{seen}/{size} 出た · 進み具合 {pct}%",
    }),
    passed: t({ en: "passed", zh: "已及格", ja: "合格" }),
    mastered: t({ en: "mastered", zh: "已掌握", ja: "習得済み" }),
    seenOf: t({ en: "Words seen in {name}", zh: "{name} 已看的词", ja: "{name} の出た単語" }),
    progressOf: t({ en: "Progress of {name}", zh: "{name} 的进度", ja: "{name} の進み具合" }),
    etaHeading: t({
      en: "When the next level opens",
      zh: "下一级什么时候开",
      ja: "次のレベルが開く時期",
    }),
    etaNote: t({
      en: "An estimate from your cards and your pace over the last 14 days, with every review answered Good, so real dates come later. Information only; nothing changes.",
      zh: "根据你的卡片和最近 14 天的速度估算，假设每次复习都答 Good，所以实际会更晚。仅供参考，不会改变任何东西。",
      ja: "あなたのカードと直近 14 日のペースから、毎回 Good と答えた場合で見積もっています。実際はもっと遅くなります。参考情報で、何も変わりません。",
    }),
    etaOpen: t({ en: "{next} is open", zh: "{next} 已经开了", ja: "{next} は開いています" }),
    etaAround: t({
      en: "{next} opens around {date} (in {days} days)",
      zh: "{next} 大约 {date} 开（{days} 天后）",
      ja: "{next} は {date} ごろ開きます（{days} 日後）",
    }),
    etaNever: t({
      en: "{next}: not within two years at this pace",
      zh: "{next}：按这个速度两年内开不了",
      ja: "{next}：このペースでは 2 年以内に開きません",
    }),
    pace: t({
      en: "{n} new words a day, {r} reviews a day",
      zh: "每天 {n} 个新词、{r} 次复习",
      ja: "1 日に新しい単語 {n} 語、復習 {r} 回",
    }),
    moveUp: t({ en: "Move {name} up", zh: "把 {name} 上移", ja: "{name} を上へ" }),
    moveDown: t({ en: "Move {name} down", zh: "把 {name} 下移", ja: "{name} を下へ" }),
    menu: t({ en: "Options for {name}", zh: "{name} 的选项", ja: "{name} のオプション" }),
    nextN: t({
      en: "Next {n} new words:",
      zh: "接下来 {n} 个新词：",
      ja: "次の新しい単語 {n} 語：",
    }),
    noneLeft: t({
      en: "No new words left.",
      zh: "没有新词了。",
      ja: "新しい単語はもうありません。",
    }),
    sequence: t({ en: "First {n} new words", zh: "前 {n} 个新词", ja: "最初の新しい単語 {n} 語" }),
    sharesOver: t({
      en: "Share of the first {n}",
      zh: "前 {n} 个里的份额",
      ja: "最初の {n} 語での割合",
    }),
    reset: t({ en: "Reset", zh: "重置", ja: "リセット" }),
    bucketNote: t({
      en: "Lists of one language at the top level count as one language here.",
      zh: "最上层同一种语言的列表，在这里算作一个语言。",
      ja: "最上位にある同じ言語のリストは、ここでは一つの言語として扱います。",
    }),
  },
};

const context: Record<keyof typeof dictionary.content, string> = {
  title: "Page heading (h1) of the owner-only simulator of how new words are ordered. Noun phrase.",
  intro:
    "Paragraph under that heading: the page only simulates; it saves nothing and leaves the real study order alone.",
  treeLabel:
    "Label of the drop-down choosing which tree of word lists the simulator uses. A plural noun.",
  presetFull:
    "Option in that drop-down: a sample tree with Japanese JLPT levels N5 to N1 and French by frequency (top 500, 1000, 5000 words). Keep N5–N1 and the numbers.",
  presetJa:
    "Option in that drop-down: a sample tree with only the Japanese JLPT levels N5 to N1. Keep N5–N1.",
  presetFlat:
    "Option in that drop-down: sample lists all at the top level, as most learners have them today, without a parent group per language.",
  myLists:
    "Option in that drop-down: the signed-in learner's real word lists, shown but never changed.",
  loading: "Status text while the learner's own word lists are being fetched.",
  allLists:
    "Name of the top of the tree (every list together), shown as the root row. Noun phrase.",
  howNew:
    "Heading of the settings of one parent group (a ⋯ menu on /words later): how its new words are shared among the lists under it.",
  inherit:
    "Radio option: use the same mode as the parent group; {mode} is that mode's name (e.g. 'Staggered'). Keep {mode}.",
  modeSeq:
    "Radio option, a mode name: all new words of the first list before any of the next one (depth-first). Short adverbial phrase.",
  modeRr:
    "Radio option, a mode name: the lists alternate, one new word each (breadth-first). Not the jargon 'round robin'.",
  modeStagger:
    "Radio option, a mode name: lists start one after another but overlap, the earlier ones getting more. An adjective, not a verb.",
  modeWeighted:
    "Radio option, a mode name: every list gives new words at once, in proportion to a number set per list.",
  modeSeqHint:
    "Line under the 'In order' option; {pct} is the pass mark (60 by default). 'Passes' = its progress reaches the pass mark.",
  modeWeightedHint: "Line under the 'By weight' option describing what it does.",
  modeRrHint: "Line under the 'Take turns' option describing what it does.",
  modeStaggerHint:
    "Line under the 'Staggered' option: lists open as in 'In order' (on passing), then the open ones run at the same time.",
  passAt:
    "Label of the slider setting the pass mark: the list progress at which the next list opens; {pct} is its value (60 by default).",
  ratio:
    "Label of the slider setting how much more an earlier list gets than the one after it; {r} is a number like 2. Keep ×{r}.",
  weight:
    "Column heading over the number field next to each child list setting its relative share (e.g. 3 against 1).",
  weightOf: "Screen-reader label of that number field for one list; {name} is the list's name.",
  stats:
    "Small text on a list's row: {seen} of {size} words shown at least once, and the list's progress {pct} (the ring on /words; 100% = mastered).",
  passed:
    "Tag on a list whose progress reached the pass mark, so the next list may open. Past participle, lowercase.",
  mastered:
    "Tag on a list at 100% progress: every word known for about a year. Past participle, lowercase.",
  seenOf:
    "Screen-reader label of the slider setting how many words of a list have been seen; {name} is the list.",
  progressOf:
    "Screen-reader label of the slider setting a list's progress (0–100%, never above its seen share); {name} is the list.",
  etaHeading:
    "Heading of the section estimating, from the learner's real cards, when each next level (e.g. N4 after N5) opens.",
  etaNote:
    "Note under that heading: how the estimate is made, that it is optimistic, and that it is only information.",
  etaOpen: "Line in that section: the next list {next} is already open (its predecessor passed).",
  etaAround:
    "Line in that section: when {next} is expected to open; {date} is a written-out date, {days} a number of days.",
  etaNever:
    "Line in that section when {next} would not open within two years at the learner's current pace.",
  pace: "Small text under a list in that section: the learner's recent pace; {n} new words and {r} reviews per day (decimals allowed).",
  moveUp:
    "Screen-reader label of the ↑ button that moves a list earlier among its siblings (raises its priority); {name} is the list.",
  moveDown:
    "Screen-reader label of the ↓ button that moves a list later among its siblings; {name} is the list.",
  menu: "Screen-reader label of the ⋯ button on a parent row that opens its 'How new words come' settings; {name} is the group.",
  nextN:
    "Start of the live preview line, followed by counts like 'N5×6, N4×3'; {n} is how many words (e.g. 10).",
  noneLeft: "Preview text when every list has been fully seen and no new word can come.",
  sequence:
    "Heading over a strip of coloured cells, one per new word, coloured by the list it comes from; {n} is the count.",
  sharesOver:
    "Heading over a table of how many of the first {n} new words each list gives, with percentages.",
  reset:
    "Button that puts the sample tree and all settings back to their defaults. Imperative verb.",
  bucketNote:
    "Note under the tree when lists of the same language sit at the top level and are treated as one language for taking turns.",
};

const newOrderContent = {
  ...dictionary,
  title: "New-word order: settings and preview (simulator, later the group ⋯ menu)",
  description: describeKeys(
    "Strings of the 'How new words come' settings in Lianki, a spaced-repetition app for languages: a parent group of word lists (e.g. Japanese with JLPT N5…N1 under it) chooses how its new words are shared among its lists. Reviews are not affected. Keep {placeholders}, ×, ⋯ and N5–N1 exactly. Labels sit on a phone screen: keep them about as short as the English.",
    context,
  ),
} satisfies DeclarationContent;

export default newOrderContent;
