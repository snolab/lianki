/**
 * The widget's own strings for the page's language (`<html lang>`), until the
 * host passes localized ones: en / zh / ja here, the app's other 13 locales in
 * chat-ui-locales.ts (user-facing) and dev-ui-locales.ts (developer-only).
 * The tree's strings (StateTree.tsx TreeStrings) included.
 */
import type { TreeStrings } from "./StateTree";
import { OTHER_LEGACY, chatLocale } from "./chat-ui-locales";
import { OTHER_DEV, OTHER_TREE } from "./dev-ui-locales";

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
  /**
   * The visible tag on a line the agent summarised: a run of the owner's voice
   * lines that were room talk, collapsed into one short line saying what was
   * said. A tap shows the lines as heard. Short: one word.
   */
  summary: string;
  /** The tag's tooltip: what the summary is and that a tap shows what was heard. */
  summaryTip: string;
  /**
   * The visible tag on a line the agent merged: a run of the owner's
   * consecutive voice lines rewritten as one fluent passage. `{n}` = how many
   * lines. A tap shows the lines as heard. Short.
   */
  merged: string;
  /** The tag's tooltip: what the passage is and that a tap shows the lines as heard. */
  mergedTip: string;
  /** The menu's Latency row (latency.ts): its title, and before any voice reply. */
  latency: string;
  latencyNone: string;
  /**
   * The menu's mic row (adaptive.ts), a debug readout for the owner: the
   * room's noise floor, his voice level, the input gain the mic adds, and the
   * speech detector's settings, which adapt to a quiet room and a soft voice.
   * - micAdapt: the row's title;
   * - micAdaptFloor / micAdaptVoice / micAdaptGain: short labels before a
   *   value in dB ("room −58 dB", "voice −44 dB", "gain +12 dB");
   * - micAdaptWhisper: a short tag shown while it is in its most sensitive
   *   (whisper) setting, chosen by itself or forced in Settings.
   */
  micAdapt: string;
  micAdaptFloor: string;
  micAdaptVoice: string;
  micAdaptGain: string;
  micAdaptWhisper: string;
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
  /**
   * Developer-only: the tiny tag after one of his voice lines saying which
   * speech recognizer turned it into text, e.g. "local · sensevoice-small" or
   * "cloud · whisper-large-v3-turbo" (latLocal / latCloud, then the engine id).
   * - sttFallback: one or two words at its end when the local recognizer was
   *   tried, failed, and the cloud one stood in ("fallback");
   * - sttTagTip: the tag's tooltip, naming what it is.
   */
  sttFallback: string;
  sttTagTip: string;
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
  wakeWord: string;
  wakeWordHint: string;
  /**
   * A chip shown after a reload cut a reply off mid-read, when the browser
   * needs a tap before it may speak (iOS/Android autoplay rules). Tapping
   * it reads on from the sentence it stopped at.
   */
  resumeRead: string;
  /**
   * A chip in the chat bar when the browser refused to play an agent reply
   * aloud (autoplay rules: no tap on the page since it loaded, e.g. after a
   * reload). One tap there (or anywhere) lets the reading go on; the 🔊 is
   * added by the chip, so this is only the words.
   */
  resumeBlocked: string;
  /**
   * Ask cards (AskCard.tsx): the agent asks a question with options shown
   * as tappable pills; the owner taps one. The question and option texts
   * come from the agent. These are the card's own words:
   * - askRecommended: a short tag after the option the agent recommends;
   * - askSend: the button that sends the choices of a multi-question card;
   * - askExpired: under a card past its deadline (it can no longer be answered);
   * - askAnswered: under a card that has its answer (it is one-shot);
   * - askSent: under a card just tapped here, until the answer is confirmed;
   * - askWithdrawn: in place of a card's options once the agent took the
   *   question back (it no longer needs an answer, and cannot be tapped):
   *   one or two words, like a message marked "withdrawn" in a chat app.
   */
  askRecommended: string;
  askSend: string;
  askExpired: string;
  askAnswered: string;
  askSent: string;
  /** The ask-jump button's label, for a host that passes no strings (ChatStrings.askJump). */
  askJump: string;
  /** The full-screen button and its way back (full-screen.ts), for a host that passes no strings. */
  fullScreen: string;
  fullScreenExit: string;
  /** A withdrawn ask card's grey state (ChatStrings.askWithdrawn). */
  askWithdrawn: string;
  /**
   * Compact mode (compact-view.ts), until the host passes localized ones
   * (ChatStrings): the menu switch, and the compact line's tap hint.
   */
  /** The menu's two cue switches (cues.ts): when a spoken line goes out; when speech starts and ends. */
  cueSend: string;
  cueSpeech: string;
  /** The speaker row, on (phone: always; computer: while typing). */
  readAloud: string;
  readAloudTyping: string;
  compactIdle: string;
  compactShowAll: string;
  /**
   * Folding the minimized chat into the screen edge (fold.ts), screen-reader
   * labels and tooltips:
   * - tuckChat: the arrow button on the minimized chat (a small pill): a tap
   *   slides the chat into the nearest screen edge, leaving a handle;
   * - restoreChat: the Li mark on that pill, and the menu row that replaces
   *   "Minimize" while minimized: a tap opens the full chat again;
   * - untuckChat: the handle left on the screen edge: a tap (or a drag
   *   starting on it) brings the small pill back.
   */
  tuckChat: string;
  restoreChat: string;
  untuckChat: string;
  /**
   * The remote-code pairing modal (DebugPairModal.tsx), developer only: a
   * program on the developer's computer (its name is `{label}`) asks to run
   * code on their open Lianki pages; the modal's first sentence says what
   * "Allow" grants. `{time}` is how long, from grantHour / grantHours /
   * grantDays below. Keep `{label}` and `{time}`.
   * - pairEval: Allow covers the pages ticked in the list below it;
   * - pairEvalAll: Allow covers all of the developer's pages, on every one of
   *   their devices, also pages opened later (no list).
   */
  pairEval: string;
  pairEvalAll: string;
  /**
   * How long that grant lasts, put into `{time}` above: grantHour = exactly
   * one hour; grantHours = `{n}` hours (2 or more); grantDays = `{n}` whole
   * days (2 or more, e.g. 30). A number and a unit only; keep `{n}`.
   */
  grantHour: string;
  grantHours: string;
  grantDays: string;
  /**
   * The connection chip (LinkChip.tsx), developer only: a small chip left of
   * the chat's progress bar with two readings, each showing all its states
   * (the current one highlighted). A tap opens details.
   * - linkChip: the chip's name (screen readers, the details' title): one word;
   * - linkEval: the first reading's name: whether a program on the developer's
   *   computer can run code on this page now; linkSel: the second's: whether
   *   the chat's assistant has got the text the user selected on the page and
   *   attached to the chat. Short nouns.
   * - evalOff / evalConnecting / evalConnected / evalDisconnected: that
   *   reading's states, one or two words each (like a network status); and
   *   evalOffTip … evalDisconnectedTip: one sentence each, what the state
   *   means (disconnected also covers "your permission does not cover this
   *   page").
   * - selNone / selPending / selSeen / selFailed: the selection's states
   *   (nothing attached; attached or sent but the assistant has not seen it
   *   yet; the assistant has seen it; it did not reach the assistant), one or
   *   two words; selNoneTip … selFailedTip: one sentence each.
   * - linkLeft: time left on a permission, `{time}` from grantHours /
   *   grantDays ("30 days left"); keep `{time}`.
   * - linkReachAll / linkReachHere / linkReachOther: which pages it covers:
   *   every page; this page; other pages, not this one. Short.
   * - linkEnd: the button that ends that permission now. One verb.
   *
   * Who is here (PresenceStack.tsx): small overlapping avatars right of that
   * chip, of the AI agents in this chat (reading it now, or posted lately).
   * - people: the heading of their list and the avatars' label. Short.
   * - peopleNow: an agent is connected and reading right now. A few words.
   * - peopleActive: when it was last active, `{time}` a clock time ("14:05").
   * - peopleSince: since when it has been here, `{time}` a clock time.
   * - peopleRemove: the button that removes an agent from the chat (its
   *   access token is revoked). One verb.
   * - peopleRemoveAsk: the one-sentence confirmation before that; keep
   *   `{name}` (the agent's name).
   * - peopleCancel: cancel that confirmation. One word.
   * - peopleFailed: a short error, the action did not work.
   * - peopleName: the button that gives an agent another name. One verb.
   * - peopleSave: save that name or picture. One verb.
   * - peopleAuto / peopleOwn / peoplePaste: the agent's picture choices: the
   *   one drawn from its name automatically; the one the agent set for
   *   itself; one the user pastes as SVG code. Short.
   * - peopleByYou: a note after a name the user chose. A few words.
   * - peopleInvite: the button to invite a new AI agent into the chat.
   * - peopleInviteHow: one sentence, a link to the settings page where a
   *   chat-only access token is made (the form already filled in), then the
   *   text below it is given to the agent.
   * - peopleCopy / peopleClose: copy that text; close the list. One verb.
   */
  linkChip: string;
  linkEval: string;
  linkSel: string;
  evalOff: string;
  evalConnecting: string;
  evalConnected: string;
  evalDisconnected: string;
  evalOffTip: string;
  evalConnectingTip: string;
  evalConnectedTip: string;
  evalDisconnectedTip: string;
  selNone: string;
  selPending: string;
  selSeen: string;
  selFailed: string;
  selNoneTip: string;
  selPendingTip: string;
  selSeenTip: string;
  selFailedTip: string;
  linkLeft: string;
  linkReachAll: string;
  linkReachHere: string;
  linkReachOther: string;
  linkEnd: string;
  people: string;
  peopleNow: string;
  peopleActive: string;
  peopleSince: string;
  peopleRemove: string;
  peopleRemoveAsk: string;
  peopleCancel: string;
  peopleFailed: string;
  peopleName: string;
  peopleSave: string;
  peopleAuto: string;
  peopleOwn: string;
  peoplePaste: string;
  peopleByYou: string;
  peopleInvite: string;
  peopleInviteHow: string;
  peopleCopy: string;
  peopleClose: string;
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
  summary: "Summary",
  summaryTip: "Summary of what was heard. Tap to see the lines as heard.",
  merged: "Merged {n}",
  mergedTip: "{n} spoken messages joined into one passage. Tap to see them as heard.",
  latency: "Latency, last voice line",
  micAdapt: "Mic, adapting",
  micAdaptFloor: "room",
  micAdaptVoice: "voice",
  micAdaptGain: "gain",
  micAdaptWhisper: "whisper",
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
  sttFallback: "fallback",
  sttTagTip: "Speech recognizer that made this line",
  latToAgent: "to agent",
  latAgent: "agent",
  latVoiceStart: "voice start",
  latOther: "other",
  aec: "Echo cancellation",
  wakeWord: "Wake word (Linky)",
  resumeRead: "Tap to continue reading",
  resumeBlocked: "Tap to turn read-aloud back on",
  askRecommended: "recommended",
  askSend: "Send",
  askExpired: "Expired",
  askAnswered: "Answered",
  askSent: "Sent",
  askJump: "Go to the nearest unanswered question above. Unanswered above: {count}",
  fullScreen: "Full screen",
  fullScreenExit: "Exit full screen",
  aecHint: "On: you can talk over replies; on Android the speaker may sound like a call. Off: fuller sound, the mic pauses while anything plays. Takes effect at once.",
  wakeWordHint: "On: after a few lines that were not for the agent, the mic waits for \"Linky\" (passive). Off: the mic always listens, never passive. Takes effect at once.",
  cueSend: "Sound when a voice message is sent",
  cueSpeech: "Sound when speech starts and ends",
  askWithdrawn: "Withdrawn",
  readAloud: "Replies read aloud",
  readAloudTyping: "Replies read aloud while typing",
  compactIdle: "Only the last message while not typing",
  compactShowAll: "Show the whole chat",
  tuckChat: "Tuck the chat into the screen edge",
  restoreChat: "Open the chat",
  untuckChat: "Bring the chat back",
  pairEval: "{label} wants to run code on your pages for {time}.",
  pairEvalAll: "{label} wants to run code on all your pages, on every device, for {time}.",
  grantHour: "1 hour",
  grantHours: "{n} hours",
  grantDays: "{n} days",
  linkChip: "Connection",
  linkEval: "Remote code",
  linkSel: "Selection",
  evalOff: "Off",
  evalConnecting: "Connecting",
  evalConnected: "Connected",
  evalDisconnected: "Disconnected",
  evalOffTip: "No program may run code on this page now.",
  evalConnectingTip: "Connecting to Lianki's server…",
  evalConnectedTip: "A program you allowed can run code on this page.",
  evalDisconnectedTip:
    "Code cannot reach this page: the connection dropped, or your permission does not cover this page.",
  selNone: "None",
  selPending: "Not seen yet",
  selSeen: "Seen",
  selFailed: "Failed",
  selNoneTip: "No page selection is attached to the chat.",
  selPendingTip: "The selection is attached or sent; the agent has not seen it yet.",
  selSeenTip: "The agent has seen the selection.",
  selFailedTip: "The selection did not reach the agent: it was not sent, or no agent is listening.",
  linkLeft: "{time} left",
  linkReachAll: "All pages",
  linkReachHere: "This page",
  linkReachOther: "Not this page",
  linkEnd: "End",
  people: "Who is here",
  peopleNow: "reading now",
  peopleActive: "active {time}",
  peopleSince: "here since {time}",
  peopleRemove: "Remove",
  peopleRemoveAsk: "Remove {name}? Its token is revoked: it can no longer read or post here.",
  peopleCancel: "Cancel",
  peopleFailed: "That did not work. Try again.",
  peopleName: "Rename",
  peopleSave: "Save",
  peopleAuto: "Generated picture",
  peopleOwn: "Its own picture",
  peoplePaste: "Paste an SVG",
  peopleByYou: "set by you",
  peopleInvite: "Invite an agent",
  peopleInviteHow: "Make a chat-only token in your preferences (filled in for you), then give the agent this:",
  peopleCopy: "Copy",
  peopleClose: "Close",
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
  summary: "摘要",
  summaryTip: "听到的内容的摘要，点一下看原话",
  merged: "合并 {n} 句",
  mergedTip: "把连续说的 {n} 句合成了一段。点一下看原话",
  latency: "延迟（上一句语音）",
  micAdapt: "麦克风（自适应）",
  micAdaptFloor: "环境",
  micAdaptVoice: "语音",
  micAdaptGain: "增益",
  micAdaptWhisper: "耳语",
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
  sttFallback: "备用",
  sttTagTip: "这句话由哪个语音识别引擎转写",
  latToAgent: "送达助手",
  latAgent: "助手",
  latVoiceStart: "开始朗读",
  latOther: "其他",
  aec: "回声消除",
  resumeRead: "点按继续朗读",
  resumeBlocked: "点一下恢复朗读",
  askRecommended: "推荐",
  askSend: "发送",
  askExpired: "已过期",
  askAnswered: "已回答",
  askSent: "已发送",
  askJump: "跳到上方最近的未回答问题。上方未回答：{count}",
  fullScreen: "全屏",
  fullScreenExit: "退出全屏",
  aecHint: "开：回复朗读时也能插话；安卓上扬声器可能变成通话音质。关：音质更好，播放声音时麦克风暂停收音。立即生效。",
  wakeWord: "唤醒词（Linky）",
  wakeWordHint: "开：几句不是对 agent 说的话之后，麦克风改为等“Linky”（被动模式）。关：麦克风一直在听，从不进入被动模式。立即生效。",
  cueSend: "语音消息发出时提示音",
  cueSpeech: "开始和结束说话时提示音",
  askWithdrawn: "已撤回",
  readAloud: "朗读回复",
  readAloudTyping: "输入时朗读回复",
  compactIdle: "不打字时只显示最后一条消息",
  compactShowAll: "显示完整聊天",
  tuckChat: "把聊天收进屏幕边",
  restoreChat: "展开聊天",
  untuckChat: "拉出聊天",
  pairEval: "{label} 想在你的页面上运行代码，为期 {time}。",
  pairEvalAll: "{label} 想在你所有设备的所有页面上运行代码，为期 {time}。",
  grantHour: "1 小时",
  grantHours: "{n} 小时",
  grantDays: "{n} 天",
  linkChip: "连接",
  linkEval: "远程代码",
  linkSel: "选区",
  evalOff: "关",
  evalConnecting: "连接中",
  evalConnected: "已连接",
  evalDisconnected: "已断开",
  evalOffTip: "现在没有程序可以在这个页面上运行代码。",
  evalConnectingTip: "正在连接 Lianki 的服务器…",
  evalConnectedTip: "你允许的程序可以在这个页面上运行代码。",
  evalDisconnectedTip: "代码到不了这个页面：连接断了，或者你的授权不包括这个页面。",
  selNone: "无",
  selPending: "还没看到",
  selSeen: "已看到",
  selFailed: "失败",
  selNoneTip: "聊天里没有附上页面选区。",
  selPendingTip: "选区已附上或已发送，代理还没看到。",
  selSeenTip: "代理已经看到选区。",
  selFailedTip: "选区没送到代理：没发出去，或者没有代理在听。",
  linkLeft: "还剩 {time}",
  linkReachAll: "所有页面",
  linkReachHere: "这个页面",
  linkReachOther: "不含这个页面",
  linkEnd: "结束",
  people: "谁在这里",
  peopleNow: "正在读",
  peopleActive: "{time} 活跃",
  peopleSince: "{time} 起在场",
  peopleRemove: "移除",
  peopleRemoveAsk: "移除 {name}？它的令牌会被吊销，之后不能再读或发言。",
  peopleCancel: "取消",
  peopleFailed: "没有成功，请再试一次。",
  peopleName: "改名",
  peopleSave: "保存",
  peopleAuto: "自动生成的头像",
  peopleOwn: "它自己的头像",
  peoplePaste: "粘贴 SVG",
  peopleByYou: "由你设置",
  peopleInvite: "邀请一个 agent",
  peopleInviteHow: "在偏好设置里创建一个只用于聊天的令牌（已为你填好），然后把下面这段给 agent：",
  peopleCopy: "复制",
  peopleClose: "关闭",
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
  summary: "要約",
  summaryTip: "聞こえた内容の要約。タップで元の発言を表示",
  merged: "{n}件を統合",
  mergedTip: "続けて話した{n}件を一つの文にまとめました。タップで元の発言を表示",
  latency: "遅延（直前の音声）",
  micAdapt: "マイク（自動調整）",
  micAdaptFloor: "周囲",
  micAdaptVoice: "声",
  micAdaptGain: "ゲイン",
  micAdaptWhisper: "ささやき",
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
  sttFallback: "代替",
  sttTagTip: "この行を文字にした音声認識エンジン",
  latToAgent: "エージェントへ",
  latAgent: "エージェント",
  latVoiceStart: "読み上げ開始",
  latOther: "その他",
  aec: "エコーキャンセル",
  resumeRead: "タップして読み上げを続ける",
  resumeBlocked: "タップして読み上げを再開",
  askRecommended: "おすすめ",
  askSend: "送信",
  askExpired: "期限切れ",
  askAnswered: "回答済み",
  askSent: "送信しました",
  askJump: "上にある一番近い未回答の質問へ移動。上の未回答：{count}",
  fullScreen: "全画面表示",
  fullScreenExit: "全画面表示を終了",
  aecHint: "オン：返事の読み上げ中も話しかけられます。Android ではスピーカーが通話の音質になることがあります。オフ：音質が良く、音声の再生中はマイクが一時停止します。すぐに反映されます。",
  wakeWord: "ウェイクワード（Linky）",
  wakeWordHint: "オン：エージェント宛てでない発言が続くと、マイクは「Linky」を待つ受け身モードになります。オフ：マイクは常に聞き取り、受け身モードになりません。すぐに反映されます。",
  cueSend: "音声メッセージ送信時の音",
  cueSpeech: "話し始めと話し終わりの音",
  askWithdrawn: "取り下げ済み",
  readAloud: "返事を読み上げる",
  readAloudTyping: "入力中は返事を読み上げる",
  compactIdle: "入力していないときは最後のメッセージだけ表示",
  compactShowAll: "チャット全体を表示",
  tuckChat: "チャットを画面の端にしまう",
  restoreChat: "チャットを開く",
  untuckChat: "チャットを戻す",
  pairEval: "{label} があなたのページでコードを実行しようとしています（期間：{time}）。",
  pairEvalAll: "{label} があなたのすべての端末のすべてのページでコードを実行しようとしています（期間：{time}）。",
  grantHour: "1時間",
  grantHours: "{n}時間",
  grantDays: "{n}日間",
  linkChip: "接続",
  linkEval: "リモートコード",
  linkSel: "選択範囲",
  evalOff: "オフ",
  evalConnecting: "接続中",
  evalConnected: "接続済み",
  evalDisconnected: "切断",
  evalOffTip: "今このページでコードを実行できるプログラムはありません。",
  evalConnectingTip: "Lianki のサーバーに接続しています…",
  evalConnectedTip: "許可したプログラムがこのページでコードを実行できます。",
  evalDisconnectedTip: "コードがこのページに届きません。接続が切れたか、許可がこのページを含んでいません。",
  selNone: "なし",
  selPending: "未確認",
  selSeen: "確認済み",
  selFailed: "失敗",
  selNoneTip: "チャットにページの選択範囲は添付されていません。",
  selPendingTip: "選択範囲は添付済みか送信済みですが、エージェントはまだ確認していません。",
  selSeenTip: "エージェントは選択範囲を確認しました。",
  selFailedTip: "選択範囲はエージェントに届いていません。送信できなかったか、聞いているエージェントがいません。",
  linkLeft: "残り{time}",
  linkReachAll: "すべてのページ",
  linkReachHere: "このページ",
  linkReachOther: "このページは対象外",
  linkEnd: "終了",
  people: "参加者",
  peopleNow: "いま読んでいます",
  peopleActive: "{time} に活動",
  peopleSince: "{time} から参加",
  peopleRemove: "外す",
  peopleRemoveAsk: "{name} を外しますか？トークンが無効になり、ここで読むことも書くこともできなくなります。",
  peopleCancel: "キャンセル",
  peopleFailed: "うまくいきませんでした。もう一度お試しください。",
  peopleName: "名前を変える",
  peopleSave: "保存",
  peopleAuto: "自動生成のアイコン",
  peopleOwn: "本人のアイコン",
  peoplePaste: "SVG を貼り付け",
  peopleByYou: "あなたが設定",
  peopleInvite: "エージェントを招待",
  peopleInviteHow: "設定でチャット専用のトークンを作り（入力済み）、エージェントに次を渡してください：",
  peopleCopy: "コピー",
  peopleClose: "閉じる",
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

/** The tree's strings in Japanese. */
export const TREE_JA: TreeStrings = {
  tree: "状態ツリー",
  back: "チャットに戻る",
  needsMe: "自分待ち",
  needsYou: "あなた待ち",
  openCount: "未完了 {n} 件",
  needsYouCount: "あなた待ち {n} 件",
  copy: "コピー",
  copied: "コピーしました",
  expand: "展開",
  collapse: "折りたたむ",
  loading: "読み込み中…",
  failed: "状態ツリーを読み込めません",
  empty: "状態ツリーは空です。",
  nothingNeedsYou: "あなた待ちの項目はありません。",
  you: "あなた",
  open: "未着手",
  doing: "進行中",
  blocked: "停滞",
  done: "完了",
  lastDone: "最近の完了",
  nowDoing: "進行中",
  upNext: "次",
  live: "開発サーバーのライブデータ",
};

/** The page's language is Chinese. */
export function isZh(lang: string | null | undefined = globalThis.document?.documentElement.lang) {
  return /^zh\b/i.test(lang ?? "");
}

/** The page's language is Japanese. */
export function isJa(lang: string | null | undefined = globalThis.document?.documentElement.lang) {
  return /^ja\b/i.test(lang ?? "");
}

/**
 * The widget's strings for the page's language: zh, ja or English, and for the
 * app's other 13 locales the strings every chat user sees (chat-ui-locales.ts)
 * with the developer-only ones (dev-ui-locales.ts).
 */
export const uiStrings = (lang?: string | null): UiStrings => {
  if (isZh(lang)) return UI_ZH;
  if (isJa(lang)) return UI_JA;
  const loc = chatLocale(lang);
  return loc === "en" || loc === "zh" || loc === "ja"
    ? UI_EN
    : { ...OTHER_DEV[loc], ...OTHER_LEGACY[loc] };
};

/** The tree's defaults for the page's language, under the host's own (English: none). */
export const treeDefaults = (lang?: string | null): Partial<TreeStrings> => {
  if (isZh(lang)) return TREE_ZH;
  if (isJa(lang)) return TREE_JA;
  const loc = chatLocale(lang);
  return loc === "en" || loc === "zh" || loc === "ja" ? {} : OTHER_TREE[loc];
};

/** Opacity blink for in-progress items (globals.css lk-blink: 1 → 0.35 → 1, 1.6 s). */
export const BLINK = "animate-lk-blink motion-reduce:animate-none";

/**
 * The browser tab's title hint (voice-bg.ts): on a computer, while the Li
 * chat's voice keeps running in a tab he switched away from (the mic still
 * listening, or replies still being read aloud), the tab title starts with a
 * glyph (🎙 or 🔊) and these few words, then " · " and the page's own title.
 * It tells him which tab still has Lianki's voice on; it must stay short
 * (tab titles are cut off) and name Lianki. Gone when the voice stops or he
 * is back on the tab.
 */
const VOICE_BG: Record<"en" | "zh" | "ja", string> = {
  en: "Lianki voice on",
  zh: "Lianki 语音运行中",
  ja: "Lianki 音声オン",
};
export function voiceBgWords(
  lang: string | null | undefined = globalThis.document?.documentElement.lang,
): string {
  return isZh(lang) ? VOICE_BG.zh : isJa(lang) ? VOICE_BG.ja : VOICE_BG.en;
}

/** The mic's local-STT dot (MicButton.tsx, docs/local-stt.md): what each state says. */
export type LocalSttStrings = {
  ready: string;
  connecting: string;
  down: string;
  /** Brief note over the mic: the owner's "only my voice" filter dropped a line, because the voice did not match. Short. */
  filtered: string;
};
const LOCAL_STT: Record<"en" | "zh" | "ja", LocalSttStrings> = {
  en: {
    ready: "Connected to Lianki's speech server",
    connecting: "Connecting to Lianki's speech server…",
    down: "Lianki's speech server unreachable: using the cloud",
    filtered: "Not your voice: not sent",
  },
  zh: {
    ready: "已连接 Lianki 语音服务器",
    connecting: "正在连接 Lianki 语音服务器…",
    down: "Lianki 语音服务器连不上，改用云端识别",
    filtered: "不是你的声音，没有发送",
  },
  ja: {
    ready: "Lianki の音声サーバーに接続済み",
    connecting: "Lianki の音声サーバーに接続中…",
    down: "Lianki の音声サーバーに接続できません。クラウドで認識します",
    filtered: "あなたの声ではないため送信しませんでした",
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
    passive: "Waiting for “Linky”: say it, then talk, or tap",
    loading: "Getting the wake word ready…",
    failed: "Wake word unavailable: listening to everything",
    wifi: "Wake word downloads on Wi-Fi (25 MB): listening to everything",
  },
  zh: {
    passive: "等你叫“Linky”：叫一声再说，或点一下",
    loading: "正在准备唤醒词…",
    failed: "唤醒词不可用，照常听所有声音",
    wifi: "唤醒词需连 Wi-Fi 下载（25 MB），先照常听所有声音",
  },
  ja: {
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

/**
 * The Learning Partner on another site (the userscript, embed/; docs/dev-debug-widget.md
 * "On every site"). Picked by the browser's own language (navigator.language),
 * not the site's: the site is someone else's page in any language.
 *
 * Context for translators: these show in one small glass note in the corner
 * of a third-party website (GitHub, a news site), instead of the chat, when
 * the chat cannot run safely there. `{name}` is the feature's localized name
 * (Learning Partner / 学习伙伴); keep it. "lianki.com" is a domain: keep it.
 */
export type EmbedStrings = {
  /** The note when the userscript manager runs Lianki inside the page's own JavaScript, where the site's scripts could read the chat: a full sentence saying it is off here, and why. */
  pageRealm: string;
  /** The note when this site's Content-Security-Policy blocks the connection to Lianki's server: a full sentence. */
  connect: string;
  /** The note when this site's Content-Security-Policy blocks the chat's styles (it would render unstyled): a full sentence. */
  styles: string;
  /** The note when this site's policy (CSP or Trusted Types) blocks running the chat's code: a full sentence. */
  script: string;
  /** The note when the chat's code could not be downloaded or failed to start: a full sentence. */
  load: string;
  /** A link under the note that opens lianki.com in a new tab, where the chat works: imperative, short. */
  openLianki: string;
  /** The × button's accessible label and tooltip: hides the note and the chat on this website only (until re-enabled). Imperative. */
  hideHere: string;
  /** Shown in place of the chat's input box on a site that blocks the private typing frame: replies still show, but typing here could be read by the site, so it is off. A full sentence. */
  readOnly: string;
  /** The link after `readOnly` that opens lianki.com in a new tab, to reply there: imperative, short. */
  replyOnLianki: string;
  /** The tooltip and accessible label of the small grip above the chat frame: drag to move it, double-click to minimize or restore. */
  grip: string;
};
export const EMBED_STRINGS: Record<"en" | "zh" | "ja", EmbedStrings> = {
  en: {
    pageRealm:
      "Your {name} is off on this site: your userscript manager runs Lianki inside the page, where the site's own scripts could read the chat.",
    connect: "This site's security policy blocks the connection to your {name}.",
    styles: "This site's security policy blocks your {name}'s styles.",
    script: "This site's security policy blocks your {name}'s code.",
    load: "Your {name} could not load on this page.",
    openLianki: "Open on lianki.com",
    hideHere: "Hide on this site",
    readOnly: "This site blocks private typing, so replies only show here.",
    replyOnLianki: "Reply on lianki.com",
    grip: "Drag to move; double-click to minimize",
  },
  zh: {
    pageRealm:
      "{name}在本网站已关闭：你的脚本管理器把 Lianki 运行在网页自身的环境里，网站的脚本可能读到聊天内容。",
    connect: "本网站的安全策略阻止了与{name}的连接。",
    styles: "本网站的安全策略阻止了{name}的样式。",
    script: "本网站的安全策略阻止了{name}的代码运行。",
    load: "{name}在此页面加载失败。",
    openLianki: "在 lianki.com 打开",
    hideHere: "在本网站隐藏",
    readOnly: "本网站不允许私密输入，这里只显示回复。",
    replyOnLianki: "去 lianki.com 回复",
    grip: "拖动可移动；双击可最小化",
  },
  ja: {
    pageRealm:
      "このサイトでは{name}をオフにしています。スクリプトマネージャーが Lianki をページ内で実行しており、サイトのスクリプトにチャットを読まれるおそれがあります。",
    connect: "このサイトのセキュリティポリシーにより、{name}に接続できません。",
    styles: "このサイトのセキュリティポリシーにより、{name}のスタイルが読み込めません。",
    script: "このサイトのセキュリティポリシーにより、{name}のコードを実行できません。",
    load: "このページでは{name}を読み込めませんでした。",
    openLianki: "lianki.com で開く",
    hideHere: "このサイトでは非表示",
    readOnly: "このサイトでは安全に入力できないため、返信の表示のみです。",
    replyOnLianki: "lianki.com で返信",
    grip: "ドラッグで移動、ダブルクリックで最小化",
  },
};
/** The feature's name in the same three languages (docs/dev-debug-widget.md, "Naming"). */
export const EMBED_NAME: Record<"en" | "zh" | "ja", string> = {
  en: "Learning Partner",
  zh: "学习伙伴",
  ja: "学習パートナー",
};
/** The browser's language (not the site's): en, zh or ja. */
export function embedLang(
  lang: string | null | undefined = globalThis.navigator?.language,
): "en" | "zh" | "ja" {
  return isZh(lang) ? "zh" : isJa(lang) ? "ja" : "en";
}
