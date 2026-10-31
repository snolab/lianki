/**
 * The widget's own strings in Chinese or Japanese, picked by the page's
 * language (`<html lang="zh…">`, `"ja"`), until the host passes localized
 * ones. English otherwise. The tree's strings (StateTree.tsx TreeStrings) included.
 */
import type { TreeStrings } from "./StateTree";

export type UiStrings = {
  stateTree: string;
  closeTree: string;
  noTreeSource: string;
  lastDone: string;
  nowDoing: string;
  upNext: string;
  needsYou: string;
  items: string;
  /** The mark on a voice line the agent polished (its tooltip and label). */
  polished: string;
  /** The menu's Latency row (latency.ts): its title, and before any voice reply. */
  latency: string;
  latencyNone: string;
  /** Its stages: the VAD's silence wait, STT, the page's own steps, the hub, the agent, the voice. */
  latVad: string;
  latStt: string;
  latSend: string;
  latHub: string;
  latReply: string;
  latVoice: string;
  /**
   * The menu's latency readout as two lines, each with its parts adding up
   * to its total (seconds follow each label):
   * - latSpeechLine: line 1, from the end of his speech to his text being sent;
   * - latReplyLine: line 2, from his text sent to the reply starting to play;
   * - latTotal: the overall time, end of speech to the reply's first sound;
   * - latPause: waiting for silence to know he stopped speaking;
   * - latRecog: speech recognition; latLocal / latCloud say where it ran
   *   (on his own computer, or on the server), in parentheses after it;
   * - latToAgent: the text reaching the agent (its "heard you" signal);
   * - latAgent: the agent thinking and writing its reply;
   * - latVoiceStart: from the reply arriving to its voice starting;
   * - latOther: the remainder not measured separately.
   */
  latSpeechLine: string;
  latReplyLine: string;
  latTotal: string;
  latPause: string;
  latRecog: string;
  latLocal: string;
  latCloud: string;
  latToAgent: string;
  latAgent: string;
  latVoiceStart: string;
  latOther: string;
  /**
   * The menu's echo-cancellation switch (an A/B the owner flips): on, the
   * mic is echo-cancelled and stays open while the agent speaks; off, raw
   * capture, paused while the agent speaks. "Applies the next time the mic
   * turns on."
   */
  aec: string;
  aecHint: string;
  /**
   * A chip shown after a reload cut a reply off mid-read, when the browser
   * needs a tap before it may speak (iOS/Android autoplay rules). Tapping
   * it reads on from the sentence it stopped at.
   */
  resumeRead: string;
  /**
   * Ask cards (AskCard.tsx): the agent asks a question with options shown
   * as tappable pills; the owner taps one. The question and option texts
   * come from the agent. These are the card's own words:
   * - askRecommended: a short tag after the option the agent recommends;
   * - askSend: the button that sends the choices of a multi-question card;
   * - askExpired: under a card past its deadline (it can no longer be answered);
   * - askAnswered: under a card that has its answer (it is one-shot);
   * - askSent: under a card just tapped here, until the answer is confirmed.
   */
  askRecommended: string;
  askSend: string;
  askExpired: string;
  askAnswered: string;
  askSent: string;
};

export const UI_EN: UiStrings = {
  stateTree: "State tree",
  closeTree: "Close the state tree",
  noTreeSource: "No tree source",
  lastDone: "Last done",
  nowDoing: "In progress",
  upNext: "Next",
  needsYou: "needs you",
  items: "items",
  polished: "Polished",
  latency: "Latency, last voice line",
  latencyNone: "Latency: no voice reply yet",
  latVad: "silence",
  latStt: "STT",
  latSend: "send",
  latHub: "hub",
  latReply: "reply",
  latVoice: "voice",
  latSpeechLine: "Speech → text",
  latReplyLine: "Reply",
  latTotal: "Total",
  latPause: "pause detection",
  latRecog: "recognition",
  latLocal: "local",
  latCloud: "cloud",
  latToAgent: "to agent",
  latAgent: "agent",
  latVoiceStart: "voice start",
  latOther: "other",
  aec: "Echo cancellation",
  resumeRead: "Tap to continue reading",
  askRecommended: "recommended",
  askSend: "Send",
  askExpired: "Expired",
  askAnswered: "Answered",
  askSent: "Sent",
  aecHint: "On: you can talk over replies; on Android the speaker may sound like a call. Off: fuller sound, the mic pauses while replies play. Applies the next time the mic turns on.",
};

export const UI_ZH: UiStrings = {
  stateTree: "状态树",
  closeTree: "关闭状态树",
  noTreeSource: "没有状态树来源",
  lastDone: "最近完成",
  nowDoing: "进行中",
  upNext: "下一步",
  needsYou: "等你处理",
  items: "项",
  polished: "已润色",
  latency: "延迟（上一句语音）",
  latencyNone: "延迟：还没有语音回复",
  latVad: "静音等待",
  latStt: "转写",
  latSend: "发送",
  latHub: "传输",
  latReply: "回复",
  latVoice: "朗读",
  latSpeechLine: "语音 → 文字",
  latReplyLine: "回复",
  latTotal: "总计",
  latPause: "停顿检测",
  latRecog: "识别",
  latLocal: "本地",
  latCloud: "云端",
  latToAgent: "送达助手",
  latAgent: "助手",
  latVoiceStart: "开始朗读",
  latOther: "其他",
  aec: "回声消除",
  resumeRead: "点按继续朗读",
  askRecommended: "推荐",
  askSend: "发送",
  askExpired: "已过期",
  askAnswered: "已回答",
  askSent: "已发送",
  aecHint: "开：回复朗读时也能插话；安卓上扬声器可能变成通话音质。关：音质更好，朗读回复时麦克风暂停。下次打开麦克风时生效。",
};

export const UI_JA: UiStrings = {
  stateTree: "状態ツリー",
  closeTree: "状態ツリーを閉じる",
  noTreeSource: "状態ツリーのソースがありません",
  lastDone: "最近の完了",
  nowDoing: "進行中",
  upNext: "次",
  needsYou: "あなた待ち",
  items: "件",
  polished: "整えました",
  latency: "遅延（直前の音声）",
  latencyNone: "遅延：まだ音声の返信がありません",
  latVad: "無音待ち",
  latStt: "文字起こし",
  latSend: "送信",
  latHub: "転送",
  latReply: "返信",
  latVoice: "読み上げ",
  latSpeechLine: "音声 → 文字",
  latReplyLine: "返信",
  latTotal: "合計",
  latPause: "無音検出",
  latRecog: "認識",
  latLocal: "ローカル",
  latCloud: "クラウド",
  latToAgent: "エージェントへ",
  latAgent: "エージェント",
  latVoiceStart: "読み上げ開始",
  latOther: "その他",
  aec: "エコーキャンセル",
  resumeRead: "タップして読み上げを続ける",
  askRecommended: "おすすめ",
  askSend: "送信",
  askExpired: "期限切れ",
  askAnswered: "回答済み",
  askSent: "送信しました",
  aecHint: "オン：返事の読み上げ中も話しかけられます。Android ではスピーカーが通話の音質になることがあります。オフ：音質が良く、読み上げ中はマイクが一時停止します。次にマイクをオンにしたときから有効。",
};

/** The tree's strings in Chinese (StateTree.tsx TreeStrings). */
export const TREE_ZH: TreeStrings = {
  tree: "状态树",
  back: "返回聊天",
  needsMe: "待我处理",
  needsYou: "等你处理",
  openCount: "{n} 项未完成",
  needsYouCount: "{n} 项等你",
  copy: "复制",
  copied: "已复制",
  expand: "展开",
  collapse: "收起",
  loading: "加载中…",
  failed: "无法加载状态树",
  empty: "状态树是空的。",
  nothingNeedsYou: "没有等你处理的事。",
  you: "你",
  open: "未开始",
  doing: "进行中",
  blocked: "受阻",
  done: "已完成",
  lastDone: "最近完成",
  nowDoing: "进行中",
  upNext: "下一步",
  live: "来自开发服务器的实时数据",
};

/** The page's language is Chinese. */
export function isZh(lang: string | null | undefined = globalThis.document?.documentElement.lang) {
  return /^zh\b/i.test(lang ?? "");
}

/** The page's language is Japanese. */
export function isJa(lang: string | null | undefined = globalThis.document?.documentElement.lang) {
  return /^ja\b/i.test(lang ?? "");
}

/** The widget's strings for the page's language (zh, ja, else English). */
export const uiStrings = (lang?: string | null): UiStrings =>
  isZh(lang) ? UI_ZH : isJa(lang) ? UI_JA : UI_EN;

/** The tree's defaults for the page's language, under the host's own. */
export const treeDefaults = (lang?: string | null): Partial<TreeStrings> =>
  isZh(lang) ? TREE_ZH : {};

/** Opacity blink for in-progress items (globals.css lk-blink: 1 → 0.35 → 1, 1.6 s). */
export const BLINK = "animate-lk-blink motion-reduce:animate-none";

/** The mic's local-STT dot (MicButton.tsx, docs/local-stt.md): what each state says. */
export type LocalSttStrings = { ready: string; connecting: string; down: string };
const LOCAL_STT: Record<"en" | "zh" | "ja", LocalSttStrings> = {
  en: {
    ready: "Local speech model connected",
    connecting: "Connecting to the local speech model…",
    down: "Local speech model unreachable: using the cloud",
  },
  zh: {
    ready: "已连接本地语音模型",
    connecting: "正在连接本地语音模型…",
    down: "本地语音模型连不上，改用云端识别",
  },
  ja: {
    ready: "ローカル音声モデルに接続済み",
    connecting: "ローカル音声モデルに接続中…",
    down: "ローカル音声モデルに接続できません。クラウドで認識します",
  },
};
export function localSttStrings(
  lang: string | null | undefined = globalThis.document?.documentElement.lang,
): LocalSttStrings {
  if (isZh(lang)) return LOCAL_STT.zh;
  if (/^ja\b/i.test(lang ?? "")) return LOCAL_STT.ja;
  return LOCAL_STT.en;
}

/**
 * The mic's wake-word state (MicButton.tsx, docs/wake-word.md).
 *
 * Context for translators: "Linky" is the learning partner's name and the
 * word the user says to wake it; keep it in Latin letters in every language.
 * Passive = the mic is on but only waits for that word, on the device;
 * nothing is transcribed or sent until it hears it.
 */
export type WakeStrings = {
  /** Under the mic icon while passive (at most 6 characters): the word it waits for. */
  badge: string;
  /** The mic button's label and tooltip while passive: what to do to talk again. */
  passive: string;
  /** The same while the on-device spotter downloads (the first time only, ~25 MB). */
  loading: string;
  /** The note when the spotter could not load; the mic went back to hearing everything. */
  failed: string;
  /** The note when the first download waits for Wi-Fi (on cellular data or Data Saver). */
  wifi: string;
};
const WAKE: Record<"en" | "zh" | "ja", WakeStrings> = {
  en: {
    badge: "Linky?",
    passive: "Waiting for “Linky”: say it, then talk, or tap",
    loading: "Getting the wake word ready…",
    failed: "Wake word unavailable: listening to everything",
    wifi: "Wake word downloads on Wi-Fi (25 MB): listening to everything",
  },
  zh: {
    badge: "Linky?",
    passive: "等你叫“Linky”：叫一声再说，或点一下",
    loading: "正在准备唤醒词…",
    failed: "唤醒词不可用，照常听所有声音",
    wifi: "唤醒词需连 Wi-Fi 下载（25 MB），先照常听所有声音",
  },
  ja: {
    badge: "Linky?",
    passive: "「Linky」待ち：呼んでから話すか、タップしてください",
    loading: "ウェイクワードを準備中…",
    failed: "ウェイクワードが使えません。すべて聞き取ります",
    wifi: "ウェイクワードは Wi-Fi でダウンロードします（25 MB）。今はすべて聞き取ります",
  },
};
export function wakeStrings(
  lang: string | null | undefined = globalThis.document?.documentElement.lang,
): WakeStrings {
  return isZh(lang) ? WAKE.zh : isJa(lang) ? WAKE.ja : WAKE.en;
}
