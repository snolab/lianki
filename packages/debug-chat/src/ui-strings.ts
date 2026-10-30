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
