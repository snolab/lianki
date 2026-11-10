/**
 * The debug chat's wire types and the pure helpers its UI uses. The hub and
 * the sender use them too, through lib/dev-eval.ts (which re-exports them).
 * Its only import is ./node-path (no imports either), so the push Worker can
 * bundle this file.
 */

import type { Ask, AskAnswer } from "./ask";
import type { LaneId, VoiceId } from "./voices";

export * from "./node-path";

/** Largest chat message (owner's or agent's), in characters. */
export const MAX_CHAT = 4000;

/**
 * What an approval lets a controller do: "eval" (Allow for 8 hours) runs code
 * and chats; "chat" (Allow chat for 30 days) only chats — it hears the owner's
 * messages and may `say`, but cannot eval.
 */
export type Scope = "eval" | "chat";

/**
 * Who wrote a line, as far as the hub knows, for the chat's avatars. Never
 * the email: `id` is a short hash of the user id (or of the email when there
 * is no id), so the fallback avatar keeps one colour without exposing it.
 */
export type Sender = {
  /** hashId(user id), the fallback avatar's colour seed. */
  id?: string;
  /** Display name, for the avatar's alt text and initial. */
  name?: string;
  /**
   * Picture URLs in fallback order: the app's own avatar, then the sign-in
   * provider's image. Each that fails to load falls through to the next, and
   * after the last to the initial in a coloured circle.
   */
  avatars?: string[];
};

/**
 * One line of a chat thread, as the hub stores and sends it. `thread` is
 * "owner" or a friend's user id; `email` is the friend's, on their thread.
 * `label` is the page's path and user agent (or the agent's name). `sender`
 * (optional; absent on older lines and on the agent's) draws the avatar.
 */
export type ChatMessage = {
  id: string;
  from: "owner" | "friend" | "agent";
  label: string;
  text: string;
  at: number;
  thread?: string;
  email?: string;
  sender?: Sender;
  /**
   * A line posted with an API token (`lianki chat`, workers/push/src/token-chat.ts):
   * `via: "token"`, and `tokenLane` is the token's name, which the text also
   * starts with as 【name】 (and `lane` is set when that name is a known lane,
   * voices.ts). Stamped by the hub only. An ask card on such a line is
   * answered to that token lane alone.
   */
  via?: "token";
  tokenLane?: string;
  /**
   * The state-tree node an agent line comes from ("/words/prefetch"; absent =
   * the main thread). Shown as a muted subtitle under the agent's avatar.
   */
  taskPath?: string;
  /** The node's assignee that wrote an agent line (≤ MAX_AGENT_ID). */
  agentId?: string;
  /**
   * The node the line is addressed to (absent or "/" = the main thread): the
   * owner's "@/words › prefetch …", or one agent's line to another node.
   */
  to?: string;
  /**
   * "stt": the owner's line came from the widget's own mic — an STT final
   * sent as heard, or sent unchanged. Absent = typed (or dictation edited
   * before sending). Only such a line may be polished by the agent (`edit`).
   */
  source?: LineSource;
  /** The STT text as first heard, kept once the agent has polished the line. */
  raw?: string;
  /** Set when the agent polished the line: when, by which agent, and how many times. */
  edited?: EditMark;
  /** The agent summarised a run of voice lines starting here (SummaryMark); `text` is the summary. */
  summary?: SummaryMark;
  /** This voice line is inside a summary that starts at that line: hidden, still kept. */
  collapsedInto?: string;
  /**
   * Stamped by the hub only, with flag `stt.merge` on (voice-merge.ts): an owner's
   * voice line the next utterance may amend. Absent = always a new line.
   */
  mergeable?: true;
  /** Stamped by the hub: the merged passage ended, so nothing more joins it and polish may read it. */
  settled?: true;
  /**
   * A merged line: the utterances it was made from, as heard, oldest first.
   * `raw` is their text joined; `id` and `at` are the first one's. Undo splits it back.
   */
  parts?: MergedPart[];
  /**
   * A voice line's timestamps on the sender's clock (VoiceTiming; the page's
   * latency record, packages/debug-chat/src/latency.ts). Optional: older pages
   * send none, and an older hub drops it.
   */
  timing?: VoiceTiming;
  /**
   * An agent line sent with `say --quiet` (FYI, progress, deploy notices):
   * shown, never read aloud. Only ever `true`; the hub drops anything else.
   */
  quiet?: true;
  /**
   * The lane an agent line is from (voices.ts LANES: "main", "codex",
   * "agy"; `say --lane`): its avatar, name tag and voice. Absent = a
   * `【lane】` prefix in the text says it, else none (looks as before).
   */
  lane?: LaneId;
  /**
   * The voice to read it in (`say --voice`): a table id (voices.ts VOICES) or
   * a line's own (voices.ts parseLineVoice: device:, melo:, aura:, eleven:).
   * Absent = its lane's.
   */
  voice?: VoiceId | (string & {});
  /**
   * The mic's wake-word mode when the owner sent the line (docs/wake-word.md):
   * "active", or "passive" (it came through "Linky"). Absent = the mic was
   * off. The chat lane sets it with {type: "wake", mode}.
   */
  wake?: "active" | "passive";
  /** Why the mic is in that mode (wake.ts WakeReason). */
  wakeReason?: string;
  /**
   * The Mac's speaker check on a voice line (SpeakerTag; docs/local-stt.md,
   * "Voiceprint"), as the owner's page reported it. Only on `source: "stt"`
   * lines; absent when the line went through the cloud or nothing is enrolled.
   */
  speaker?: SpeakerTag;
  /**
   * What the sender attached from the page with the input's + menu
   * (attach.ts): the text selected on the page, and where. Owner and friend
   * lines only; checked by cleanContext, so it is never more than its limits.
   */
  context?: ChatContext;
  /**
   * Files sent with the line (the + menu's File / Photo, paste, drop): the
   * host's upload ids and what each is. Never the bytes: the host stores
   * them and says where to fetch them (ChatFiles.url). Checked by
   * cleanAttachments. Owner lines only, as the host's upload is.
   */
  attachments?: AttachmentRef[];
  /**
   * Where a voice line was spoken: the page's path and title and the text on
   * its screen (cleanScene). Only on `source: "stt"` lines; what the agent's
   * polish may draw on (polish.ts), so it fixes words from context, not guesses.
   */
  scene?: SttScene;
  /**
   * Stamped by the hub only (workers/push/src/debug.ts `say`): an agent line
   * said in the owner's thread by a pairing he approved. It alone lets a line
   * use the HTML subset (rich-text.ts lineTier). Never read from what a sender
   * sends, and absent on friends' lines, the partner AI's and older lines.
   */
  ownerGrant?: true;
  /**
   * `source: "eta"` lines only: the state-tree node whose estimate ran out,
   * and that estimate (lib/eta-ping.ts). Automatic, never the owner speaking.
   */
  eta?: { id: string; etaAt: number };
  /** An agent line that asks: the question(s) and their options (ask.ts). */
  ask?: Ask;
  /** Its answer, stamped by the hub from a tap on a page (ask.ts). */
  answer?: AskAnswer;
};

/** The hub telling pages and listeners that an ask was answered by a tap. */
export type AnsweredEvent = {
  type: "answered";
  /** The ask's message id, and the ask's own id. */
  id: string;
  askId: string;
  answer: AskAnswer;
  /** Option labels per question, for a listener that prints it. */
  labels: Record<string, string[]>;
};

/**
 * The hub telling pages and listeners that the agent withdrew an open ask
 * (eval.ts withdraw): the card greys out, takes no tap, and is never read aloud.
 */
export type WithdrawnEvent = {
  type: "withdrawn";
  /** The ask's message id, the ask's own id, and its thread. */
  id: string;
  askId: string;
  thread: string;
  withdrawnAt: number;
};

/** A message updated by a WithdrawnEvent; any other message is returned as is. */
export function applyWithdrawn<M extends ChatMessage>(m: M, e: Omit<WithdrawnEvent, "type">): M {
  if (m.id !== e.id || !m.ask || m.ask.askId !== e.askId || (m.thread ?? "owner") !== e.thread)
    return m;
  return { ...m, ask: { ...m.ask, withdrawnAt: e.withdrawnAt } };
}

/** Where an owner line came from: "stt" (the widget's mic). Absent = typed. */
export type MessageSource = "stt";
/**
 * A stored line's source: MessageSource, or "eta" — an automatic line the
 * hubs put in the owner's thread when a state-tree estimate ran out
 * (lib/eta-ping.ts). Stamped by the hub only; a page can never send it.
 */
export type LineSource = MessageSource | "eta";
/** An agent's polish of a voice line (ChatMessage.edited). */
export type EditMark = { at: number; by: string; count: number };
/** One utterance of a merged line (ChatMessage.parts): its raw text and what it arrived with. */
export type MergedPart = {
  id: string;
  text: string;
  at: number;
  timing?: VoiceTiming;
  speaker?: SpeakerTag;
  wake?: "active" | "passive";
  wakeReason?: ChatMessage["wakeReason"];
};
/** How many times the agent may polish one voice line. */
export const MAX_EDITS = 3;
/**
 * How far back the agent may polish or summarise: any of the owner's last
 * EDITABLE_LINES lines in the owner thread (not only the latest).
 */
export const EDITABLE_LINES = 5;
/**
 * A run of the owner's voice lines the agent summarised (room talk, someone
 * else speaking): on the run's first line, which shows the summary; the others
 * carry `collapsedInto` and are hidden on the page. Nothing is deleted: every
 * line stays stored with its text, and the first line's `raw` holds them all.
 */
export type SummaryMark = { at: number; by: string; ids: string[] };
/**
 * The hub's broadcast after an agent polished a voice line: the pages and
 * listeners update that line in place (never read aloud again).
 */
export type EditedEvent = {
  type: "edited";
  id: string;
  thread: string;
  text: string;
  raw: string;
  edited: EditMark;
  /** A merge (voice-merge.ts): every part so far. */
  parts?: MergedPart[];
  /** A merge: the utterance that just joined (the hub's answer to its `id`). */
  merged?: { id: string; text: string };
  /** An undo: the lines this one goes back to, in order; the first keeps this id. */
  split?: ChatMessage[];
  /** A summary of a run of lines starting at `id` (its other lines are hidden). */
  summary?: SummaryMark;
};

/** The hub to the listeners: a merged passage ended, polish it now, from `raw`. */
export type PolishDueEvent = {
  type: "polish-due";
  id: string;
  thread: string;
  text: string;
  raw: string;
  parts: number;
};

/** A message updated by an EditedEvent; any other message is returned as is. */
export function applyEdit<M extends ChatMessage>(m: M, e: Omit<EditedEvent, "type">): M {
  if (m.id !== e.id || (m.thread ?? "owner") !== e.thread) return m;
  return {
    ...m,
    text: e.text,
    raw: e.raw,
    edited: e.edited,
    ...(e.parts ? { parts: e.parts } : {}),
    ...(e.summary ? { summary: e.summary } : {}),
  };
}

/** The list after an EditedEvent: the line changed in place, or split back into its lines. */
export function applyEditTo<M extends ChatMessage>(list: M[], e: Omit<EditedEvent, "type">): M[] {
  if (e.summary) {
    const rest = new Set(e.summary.ids.filter((id) => id !== e.id));
    return list.map((m) =>
      (m.thread ?? "owner") === e.thread && rest.has(m.id)
        ? { ...m, collapsedInto: e.id }
        : applyEdit(m, e),
    );
  }
  if (!e.split) return list.map((m) => applyEdit(m, e));
  const split = e.split as M[];
  return list.flatMap((m) => (m.id === e.id && (m.thread ?? "owner") === e.thread ? split : [m]));
}

/**
 * Longest avatar URL the hub keeps; longer ones are dropped. Google's and
 * GitHub's are about 100. Bounded because a page's socket attachment (which
 * holds its Sender) must stay under 2 KB.
 */
export const MAX_AVATAR_URL = 300;
/** Longest display name the hub keeps. */
export const MAX_SENDER_NAME = 80;

/** A short, stable, non-reversible-enough hash (FNV-1a, 32 bits, base 36). */
export function hashId(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** An avatar URL worth keeping: https only, bounded. */
export function avatarUrl(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !raw || raw.length > MAX_AVATAR_URL) return undefined;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" ? u.href : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The Sender for a signed-in user: the id seed hashed from the user id (or
 * the email, lower-cased, when there is no id), never the raw email; the
 * name cleaned; the pictures that are https URLs, in the order given.
 */
export function senderOf(who: {
  userId?: string;
  email?: string;
  name?: string | null;
  avatars?: readonly (string | null | undefined)[];
}): Sender {
  const key = who.userId || who.email?.trim().toLowerCase() || "";
  const name = (who.name ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim()
    .slice(0, MAX_SENDER_NAME);
  const avatars = (who.avatars ?? []).map(avatarUrl).filter((u): u is string => !!u);
  return {
    ...(key ? { id: hashId(key) } : {}),
    ...(name ? { name } : {}),
    ...(avatars.length ? { avatars: [...new Set(avatars)].slice(0, 2) } : {}),
  };
}

/** The fallback avatar's letter: the name's first character (a whole grapheme), upper-cased. */
export function initialOf(name: string | undefined): string {
  const s = (name ?? "").trim();
  if (!s) return "?";
  const Seg = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
  const first = Seg
    ? (new Seg(undefined, { granularity: "grapheme" }).segment(s)[Symbol.iterator]().next().value
        ?.segment ?? s[0])
    : Array.from(s)[0];
  return first.toLocaleUpperCase();
}

/** Relative luminance (WCAG) of an oklch colour, clamped into sRGB. */
export function oklchLuminance(l: number, c: number, hDeg: number): number {
  const h = (hDeg * Math.PI) / 180;
  const a = c * Math.cos(h);
  const b = c * Math.sin(h);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  const r = clamp(4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_);
  const g = clamp(-1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_);
  const bl = clamp(-0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_);
  return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
}

/** WCAG contrast ratio of two relative luminances. */
export const contrastRatio = (y1: number, y2: number) =>
  (Math.max(y1, y2) + 0.05) / (Math.min(y1, y2) + 0.05);

/** The fallback avatar's lightness and chroma: oklch(0.7 0.12 <hue>). */
const AVATAR_L = 0.7;
const AVATAR_C = 0.12;
/** The two letter colours tried on it: near-black and white. */
const INK = [
  { css: "oklch(0.2 0 0)", y: oklchLuminance(0.2, 0, 0) },
  { css: "oklch(1 0 0)", y: 1 },
];

/**
 * The fallback avatar's colours for a seed (a Sender id, or any stable
 * string): the hue from a hash, so a person keeps one colour; the letter in
 * whichever ink contrasts more (at least 4.5:1 for every hue).
 */
export function avatarColors(seed: string): { bg: string; fg: string; hue: number } {
  const hue = parseInt(hashId(`avatar:${seed}`), 36) % 360;
  const y = oklchLuminance(AVATAR_L, AVATAR_C, hue);
  const ink = INK.reduce((best, i) =>
    contrastRatio(i.y, y) > contrastRatio(best.y, y) ? i : best,
  );
  return { bg: `oklch(${AVATAR_L} ${AVATAR_C} ${hue})`, fg: ink.css, hue };
}

/** What the hub tells pages: the pairing waiting for an answer, and the approved sessions. */
export type PairInfo = {
  pair: string;
  code: string;
  label: string;
  at: number;
  until?: number;
  scope?: Scope;
  /** The page ids an approved pairing reaches; absent = all this audience's pages. */
  pages?: string[];
};

/** An open debug page: its socket's id, current label (path…), and when it connected. */
export type PageInfo = { id: string; label: string; at: number };

/**
 * The language to read a reply in, from its script alone: any kana is
 * Japanese, Hangul Korean, other Han Chinese (zh-CN), and everything else
 * English.
 */
export function pickLang(text: string): "ja-JP" | "ko-KR" | "zh-CN" | "en-US" {
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)) return "ja-JP";
  if (/\p{Script=Hangul}/u.test(text)) return "ko-KR";
  if (/\p{Script=Han}/u.test(text)) return "zh-CN";
  return "en-US";
}

/** An installed voice for `lang`: the exact locale first, then the same language. */
/**
 * How natural a voice sounds, higher is better. iOS lists its Eloquence
 * voices (Eddy, Flo, Grandma, …) and the novelty ones (Bahh, Bubbles,
 * Zarvox, …) first for most languages, and marks every voice `default`, so
 * "the first voice of the language" sounds robotic or silly there. Prefer
 * Premium/Enhanced, then the regular named voice (Samantha, Tingting, Kyoko).
 */
export function voiceQuality(v: { voiceURI?: string; name?: string; localService?: boolean }): number {
  const uri = (v.voiceURI ?? "").toLowerCase();
  if (uri.includes("eloquence") || uri.includes("speech.synthesis.voice.")) return 0;
  if (uri.includes("premium")) return 4;
  if (uri.includes("enhanced")) return 3;
  if (uri.includes("siri")) return 3;
  return 2;
}

export function pickVoice<
  V extends { lang: string; default?: boolean; voiceURI?: string; name?: string },
>(voices: readonly V[], lang: string): V | undefined {
  const norm = (l: string) => l.replace(/_/g, "-").toLowerCase();
  const want = norm(lang);
  const base = want.split("-")[0];
  const exact = voices.filter((v) => norm(v.lang) === want);
  const same = voices.filter((v) => norm(v.lang).split("-")[0] === base);
  const pool = exact.length ? exact : same;
  const best = Math.max(-1, ...pool.map(voiceQuality));
  const top = pool.filter((v) => voiceQuality(v) === best);
  return top.find((v) => v.default) ?? top[0];
}

/**
 * A page label ("<path> [pwa ]<user agent>") split for the chat's page list:
 * the path, and a short device hint like "pwa · Android" or "iPhone".
 */
export function pageParts(label: string): { path: string; device: string } {
  const [path = "", ...rest] = label.split(" ");
  const ua = rest.join(" ");
  const pwa = rest[0] === "pwa";
  const device =
    [
      ["iPhone", /iPhone/],
      ["iPad", /iPad/],
      ["Android", /Android/],
      ["Mac", /Macintosh|Mac OS X/],
      ["Windows", /Windows/],
      ["Linux", /Linux|X11/],
    ].find(([, re]) => (re as RegExp).test(ua))?.[0] ?? "";
  return {
    path: path.startsWith("/") ? path : "/",
    device: [pwa ? "pwa" : "", device as string].filter(Boolean).join(" · "),
  };
}

/** What Allow grants, in one sentence (the requester declared its scope when it knocked). */
export function pairSentence(p: Pick<PairInfo, "label" | "scope">, friend: boolean): string {
  if (friend) return `${p.label} wants to preview a change on this page for 1 hour.`;
  return p.scope === "chat"
    ? `${p.label} wants to chat with you for 30 days.`
    : `${p.label} wants to run code on your pages for 8 hours.`;
}

/** The pairing modal's Allow button, for the pages ticked. */
export function allowLabel(ticked: number, total: number, selfTicked: boolean): string {
  if (total > 1 && ticked === total) return "Authorize all pages";
  if (ticked === 1 && selfTicked) return "Authorize this page";
  return ticked === 1 ? "Authorize 1 page" : `Authorize ${ticked} pages`;
}

/**
 * The feature's user-facing name in English. Every English string that names
 * it reads this one constant (the app's i18n file imports it too). Internally
 * the feature is still "debug" (docs/dev-debug-widget.md, "Naming").
 */
export const AGENT_NAME_EN = "Learning Partner";

/**
 * The chat's user-facing strings that name the feature. The host passes them
 * localized (app/components/learning-partner.content.ts); `{name}` is
 * replaced with `name`. English defaults here, so the widget works alone.
 */
export type ChatStrings = {
  name: string;
  /** The chat box's aria-label. */
  chatWith: string;
  /** Input placeholder and aria-label while the agent is online. */
  message: string;
  /** Input placeholder while it is offline. */
  offline: string;
  /** After a message sent while offline. */
  waiting: string;
  /** Tooltip on `waiting`. */
  waitingTitle: string;
  /** The speaker shown before your own lines. */
  you: string;
  /** The empty log's hint. */
  hint: string;
  /** The connection status (pill tooltip, menu) with the agent listening; `{n}` = listeners. */
  listening: string;
  /** The status with no agent listening. */
  statusOffline: string;
  /** The mark on a voice line the agent polished (tooltip and label). */
  polished: string;
  /** The undo on a line several utterances were merged into. */
  unmerge: string;
  /** Voice-clip recording (ClipsBadge.tsx): the badge's title while it records. */
  clipsRecording: string;
  /** The badge's button that stops recording. */
  clipsStop: string;
  /** Badge note: the screen wake lock is held while recording. */
  clipsScreenOn: string;
  /** Badge note: no wake lock; recording pauses while the screen is off. */
  clipsScreenMaySleep: string;
  /** Badge note after a gap; `{n}` = minutes. */
  clipsPaused: string;
  /** Badge reminder before an auto-stop; `{n}` = minutes. */
  clipsStopsIn: string;
  /** Button: continue another window's recording session on this page. */
  clipsContinue: string;
  /** Badge note: clips the sink acknowledged; `{n}` = the count. */
  clipsSaved: string;
  /** Badge state while the latest clip did not reach the sink. */
  clipsSaveFailed: string;
  /** Menu item that starts recording voice clips in this window. */
  clipsStart: string;
  /** Menu switch: a tap on clipsStart also sets an auto-stop; `{n}` = minutes. */
  clipsAutoStop: string;
  /** Menu switch: compact mode (compact-view.ts), this device only. */
  /** The chat menu's switch: a tone when a spoken line goes out. */
  cueSend: string;
  /** The chat menu's switch: soft tones when he starts and stops speaking. */
  cueSpeech: string;
  /** The speaker row, on: on a phone every reply is read (voice.ts, the toggle alone decides). */
  readAloud: string;
  /** The speaker row, on, on a computer: replies are read while the input has focus. */
  readAloudTyping: string;
  compactIdle: string;
  /** The menu's collapsed Dev group (DevMenuGroup.tsx), the owner's pages only: its heading. */
  devGroup: string;
  /** The compact line's tooltip and screen-reader hint: a tap shows the whole chat. */
  compactShowAll: string;
  /** The up-arrow over the log (ask-above.ts): its screen-reader label; `{count}` is how many are above. */
  askJump: string;
  /** The round button at the open chat's top corner that makes it fill the whole app (full-screen.ts). */
  fullScreen: string;
  /** The same button in full screen: back to the small chat panel, as it was. */
  fullScreenExit: string;
  /** The six-dot grip at the bar's left end: drag to move the chat, tap to fold or open it, double-tap for the menu. */
  dragGrip: string;
  // The voiceprint panel (VoiceprintPanel.tsx, voiceprint.ts; docs/local-stt.md, "Voiceprint").
  /** Item in the chat's menu (owner only) that opens the voiceprint panel: enrol his voice on this device, or delete the voiceprint. A noun, the feature's name. */
  vpMenu: string;
  /** Heading of the voiceprint panel shown above the chat bar. 'Your' = the person using the app. Noun phrase. */
  vpTitle: string;
  /** Line in the voiceprint panel when no device has enrolled a voiceprint yet. One short sentence. */
  vpNone: string;
  /** One row per enrolled device in the voiceprint panel: {device} is a device name like iphone or android, {n} how many sentences were read for it. Keep both placeholders. */
  vpPrint: string;
  /** Note in the voiceprint panel when the speech model on the owner's own computer (a Mac) is not reachable; the mic button shows a green dot when it is. Keep 'Mac'. One sentence. */
  vpOff: string;
  /** Button in the voiceprint panel that starts enrolling the user's voice on the phone or computer in hand (it first shows a consent card; nothing is recorded yet). Imperative verb phrase. */
  vpEnrol: string;
  /** The consent card shown before any enrolment audio is captured: what happens, what is kept (numbers that describe the voice, not audio), where (on the owner's Mac at the given folder path, keep the path exactly; and, after a passkey confirmation, an encrypted copy of the same numbers in his Lianki account, readable only by his account), that no recording is kept in the account, what it is for, and that it can be deleted from both at any time. {n} is a range like 10–20; {name} is the assistant's name. Keep 'Mac', 'Lianki' and both placeholders. Plain, honest, several sentences. */
  vpConsent: string;
  /** On/off checkbox on the consent card, off by default: when on, the audio of the enrolment sentences is also kept on the owner's Mac (normally only the numbers are). First person, a statement of what is kept. */
  vpKeepAudio: string;
  /** Button on the consent card: the user agrees and enrolment recording starts (the microphone turns on). First person agreement plus imperative verb, short. */
  vpAgree: string;
  /** Button on the voiceprint panel's consent, recording and delete steps that stops without saving or deleting anything. Imperative verb, one word. */
  vpCancel: string;
  /** Instruction above the sentence to read aloud during enrolment; the pause lets the mic know the sentence is over. Imperative, ends with a colon. */
  vpRead: string;
  /** Counter during enrolment: {n} sentences accepted so far out of {total} at most. Keep both placeholders; short. */
  vpProgress: string;
  /** Note during enrolment: the sentence just read had too little speech to use; read the same sentence again, more slowly. Two short sentences. */
  vpShort: string;
  /** Note during enrolment: background noise was too loud for that sentence to be used; try again in a quieter place. Two short sentences. */
  vpNoise: string;
  /** Note during enrolment: the voice in the sentence just read did not match the earlier sentences (maybe someone else spoke); read it again. Two short sentences. */
  vpMismatch: string;
  /** Note during enrolment: the words recognised were not the sentence shown, so the user should read the shown sentence again. Two short sentences. */
  vpText: string;
  /** Note during enrolment: the owner's own computer (Mac) running the speech model did not answer for that sentence; the mic button's green dot shows whether it is connected. Two short sentences; keep 'Mac'. */
  vpUnreachable: string;
  /** Button during enrolment that moves on to the next sentence without reading the one shown (too hard to read). Imperative verb, one word. */
  vpSkip: string;
  /** Button during enrolment, enabled once enough sentences are kept: saves the voiceprint on the owner's Mac and ends enrolment. Imperative verb phrase. */
  vpSave: string;
  /** Status in the voiceprint panel while the voiceprint is being written on the Mac. Progressive form, ends with an ellipsis. */
  vpSaving: string;
  /** Confirmation in the voiceprint panel after enrolment: the voiceprint was saved on the owner's Mac. One short sentence; keep 'Mac'. */
  vpSaved: string;
  /** Button in the voiceprint panel that deletes the user's own voiceprint (asks to confirm first). First person 'my'; imperative verb phrase. */
  vpDelete: string;
  /** Confirmation question after tapping Delete my voiceprint: it removes the voiceprint of every enrolled device from the owner's Mac and from his Lianki account, and does not touch the separately saved voice clips. A question and a reassurance; keep 'Mac'. */
  vpDeleteConfirm: string;
  /** The confirming button under that question: deletes the voiceprint now. Imperative verb, one word. */
  vpDeleteYes: string;
  /** Confirmation in the voiceprint panel after deleting: the voiceprint is gone. One short sentence. */
  vpDeleted: string;
  /** Error line in the voiceprint panel; {error} is a short technical reason in English from the Mac. Keep {error} inside the parentheses. */
  vpFailed: string;
  /** Button and screen-reader label that closes the voiceprint panel (shown as ✕ or under a finished step). Imperative verb, one word. */
  vpClose: string;
  /** Status line in the voiceprint panel: the owner's 'Only my voice' filter is working: speech that does not match his voiceprint is dropped on his Mac before it is transcribed. Keep 'Mac'; one sentence. */
  vpFilterOn: string;
  /** Status line in the voiceprint panel: the 'Only my voice' filter is switched off, so all speech is transcribed as usual. One sentence. */
  vpFilterOff: string;
  /** Status line in the voiceprint panel: the 'Only my voice' filter is switched on but cannot work (this phone or computer has no voiceprint yet, or the check on the Mac is unavailable), so all speech is transcribed as usual. Keep 'Mac'; one sentence. */
  vpFilterWaiting: string;
  /** Count in the voiceprint panel: {n} spoken lines were dropped today by the 'Only my voice' filter because the voice did not match; {score} is the last match score, a small decimal like 0.07. Keep both placeholders; short. */
  vpFilterCount: string;
  /** Count in the voiceprint panel, while the filter is off: {n} spoken lines today that the 'Only my voice' filter would have dropped (they were still sent). Keep the placeholder; short. */
  vpFilterWould: string;
  /** Checkbox in the voiceprint panel that pauses the 'Only my voice' filter on the phone or computer in hand only. A short statement. */
  vpFilterPause: string;
  /** Button in the voiceprint panel: copies the voiceprint (numbers describing the owner's voice, never a recording) from his Mac into his own Lianki account, encrypted; the passkey prompt (Face ID / Touch ID) comes next. First person 'my'; imperative verb phrase, short. */
  vpCloudSave: string;
  /** Button in the voiceprint panel: puts the voiceprint saved in the owner's Lianki account back onto his Mac (for example a new Mac); the passkey prompt comes next. First person 'my'; imperative verb phrase, short. */
  vpCloudRestore: string;
  /** Status in the voiceprint panel while the voiceprint's numbers are being copied from the Mac into the owner's account (after the passkey prompt). Progressive form, ends with an ellipsis. */
  vpCloudSaving: string;
  /** Status in the voiceprint panel while the voiceprint from the owner's account is being written back onto his Mac. Progressive form, ends with an ellipsis; keep 'Mac'. */
  vpCloudRestoring: string;
  /** Confirmation in the voiceprint panel: the voiceprint's numbers are now saved, encrypted, in the owner's Lianki account; {n} is how many device prints were saved. Keep the placeholder; one short sentence. */
  vpCloudSaved: string;
  /** Confirmation in the voiceprint panel: the voiceprint from the owner's account was written back onto his Mac; {n} is how many device prints. Keep the placeholder and 'Mac'; one short sentence. */
  vpCloudRestored: string;
  /** Line in the voiceprint panel listing which devices' voiceprints are saved in the owner's Lianki account; {devices} is a comma-separated list of device names like 'iphone, android'. Keep the placeholder; short. */
  vpCloudHas: string;
  /** Line in the voiceprint panel when nothing of the voiceprint is saved in the owner's Lianki account yet. One short sentence. */
  vpCloudNone: string;
  /** Error line in the voiceprint panel about the copy in the owner's account (saving, restoring or deleting it); {error} is a short technical reason in English. Keep {error} inside the parentheses; it is not a danger warning, just a failure note. */
  vpCloudFailed: string;
  /** Tooltip and screen-reader label of a tiny check mark after a voice-typed chat line: the owner's Mac confirmed the line was spoken in his own voice. Short phrase, no full stop. */
  vpVerified: string;
  /** A small note on an agent line that was not read aloud because the page was in the background. */
  notReadHidden: string;
  // The input's + menu (attach.tsx).
  /** Screen-reader label and tooltip of the + button at the start of the chat input: opens a menu to add something to Lianki or attach something to the message. */
  attachOpen: string;
  /** Section heading in the + menu: actions that add content to Lianki (a link as a card, words from a deck, imports). A short noun or imperative, one word if possible. */
  attachGroupAdd: string;
  /** Section heading in the + menu: things attached to the message being typed (page selection, files, media). A short phrase. */
  attachGroupMessage: string;
  /** Menu item in the + menu: attaches the text the user selected on the page to the next message. Noun phrase, the thing attached. */
  attachSelection: string;
  /** Grey hint under the disabled 'Page selection' item when nothing is selected: the user should first select (highlight) text on the page. One short imperative sentence. */
  attachSelectionNone: string;
  /** Menu item in the + menu: upload a file from the device and attach it to the message. Noun or short verb phrase. */
  attachFile: string;
  /** Menu item in the + menu: upload a photo, a video or a sound recording and attach it to the message. Short noun phrase. */
  attachMedia: string;
  /** Small grey tag on a + menu item that is not available here (no uploads on this page). Two or three words. */
  attachSoon: string;
  /** Screen-reader label of the × on the chip above the input that shows the attached page selection: removes it from the message. Imperative verb phrase. */
  attachRemove: string;
  /** Screen-reader label of the quoted page selection shown above a message in the chat log, and of the chip above the input: it is text quoted from the page. Short noun phrase. */
  attachQuoted: string;
  /** Section heading in the + menu, the last group: things to look at (the state tree). One short word. */
  attachGroupView: string;
  /** Menu item in the + menu's View group: shows or hides the state tree (the progress outline of what is being built). Short noun phrase, the panel's name. */
  attachTree: string;
  // Files attached to a message (files.ts; FileChips.tsx).
  /** Big hint over the chat while files are dragged over it: let go to attach them to the message. Short imperative phrase. */
  attachDrop: string;
  /** Tooltip of a file chip above the input while it is still being uploaded (a progress bar is shown). Progressive form, ends with an ellipsis. */
  attachUploading: string;
  /** Small red note on a file chip above the input: the upload did not work; remove it and try again. Two or three words. */
  attachFailed: string;
  /** Small red note on a file chip above the input: the file is bigger than allowed, so it was not uploaded. Two or three words. */
  attachTooBig: string;
  /** Screen-reader label of the × on a file chip above the input: takes that file off the message (before sending). Imperative verb phrase. */
  attachFileRemove: string;
  /** Menu item in the + menu's View group: opens the list of files sent in the chat (the inbox). One word, a noun. */
  inbox: string;
  /** Menu item in the + menu's View group: opens the page with the account's past chat lines (the history). One word, a noun. */
  chatHistory: string;
  /** Grey line in the inbox list when no file has been sent yet. One short sentence. */
  inboxEmpty: string;
  /** Grey line at the top of the inbox list: how much the user has stored. {size} is like "12 MB", {n} a count of files. Keep both placeholders. */
  inboxUsage: string;
  /** The same line when the user has a storage limit: {size} used of {quota} (both like "12 MB"), {n} files. Keep the three placeholders. */
  inboxUsageQuota: string;
  /** Red line in the inbox list when it could not be loaded. One short sentence. */
  inboxFailed: string;
  /** Small grey tag on a file in the inbox list: the agent has already read and handled it. One word, past participle. */
  inboxProcessed: string;
  /** Button on a file in the inbox list: deletes that one file for good (asks to confirm first). Imperative verb, one word. */
  inboxDelete: string;
  /** The question that replaces a file's row in the inbox list after Delete was tapped: the file is removed for good. Short question. */
  inboxDeleteConfirm: string;
  /** The button next to that question that keeps the file (does not delete it). Imperative verb, one word. */
  inboxKeep: string;
  /** Button and screen-reader label that closes the inbox list. Imperative verb, one word. */
  inboxClose: string;
  /** Part of the one-line progress bar above the chat input, when several tasks the assistant is working on have a time estimate: how many there are. {n} becomes a number; keep it. A short count, no verb; other parts follow after a middle dot. */
  etaTasks: string;
  /** Part of the progress bar above the chat input, and of each task's row in the state tree: how much time is left until the assistant's estimate runs out. {t} becomes a short duration such as '25m' or '1h 5m' (already localized); keep it. Very short, no full stop. */
  etaLeft: string;
  /** Part of the progress bar above the chat input when several tasks have estimates: how soon the next one is due. {t} becomes a short duration such as '5m' (already localized); keep it. Very short, no full stop. */
  etaNext: string;
  /** Shown in the progress bar above the chat input and in a task's row in the state tree instead of the time left, once the assistant's own time estimate for the work has passed (the work may still be going on; the assistant is asked to report). Very short status phrase, no full stop. */
  etaReached: string;
  /** Shown for a few seconds in the progress bar above the chat input and in a task's row in the state tree when that task was finished. One word, a status (past participle or adjective). */
  etaDone: string;
  /** Screen-reader label and tooltip of the progress bar above the chat input (and of the expand button on the task list in the state tree): tapping it opens a full-screen timeline (a Gantt chart) of every task with its own bar and time left. Imperative verb phrase. */
  etaOpen: string;
  /** Screen-reader label and tooltip of the × button at the top of the full-screen task timeline (a Gantt chart of the assistant's tasks): closes the timeline and returns to the chat. Imperative verb phrase, very short. */
  etaGanttClose: string;
  /** Screen-reader label of a small two-button switch in the header of the full-screen task timeline (a Gantt chart of the assistant's tasks): it chooses how the time axis is drawn, evenly (linear) or compressed further from now (logarithmic). Short noun phrase, no full stop. */
  etaGanttScale: string;
  /** One of two buttons of a small switch in the header of the full-screen task timeline (a Gantt chart): draws the time axis evenly, each hour the same width. A single short word for 'linear' as on a chart's axis (线性 in Chinese); the button is narrow. */
  etaGanttLinear: string;
  /** The other of the two buttons of that switch in the header of the full-screen task timeline (a Gantt chart): draws the time axis logarithmically, near times wide and far times compressed, so minutes and days fit one screen. A single short word for 'logarithmic' as on a chart's axis, abbreviated if usual (对数 in Chinese, 'Log' in English); the button is narrow. */
  etaGanttLog: string;
  /** A task waiting for the owner (Gantt and list): the red mark's label, and before its reminder time. */
  etaWaitingYou: string;
  /** The full-screen Gantt's one-line legend: the underline is the reported progress, the red line now. */
  etaGanttLegend: string;
  /** A parked task's time: when its reminder goes off, `{t}` a compact time ("9.1H"). */
  etaReminder: string;
  /** The full-screen Gantt's legend, second part: the ETA ticks and the ghost bar of the original plan. */
  etaGanttLegendTicks: string;
  /** A tapped ETA tick's group (`{names}`: task names): ends moved earlier. */
  etaTickEarlier: string;
  /** …ends moved later. */
  etaTickLater: string;
  /** …estimates re-confirmed unchanged. */
  etaTickConfirmed: string;
  /** …a first estimate. */
  etaTickSet: string;
  /** …status changed only. */
  etaTickStatus: string;
  /** The tick note's close button (screen reader, tooltip). */
  etaTickClose: string;
  /** Part of the minimized chat's one status line: a task's name followed by the minutes left until the assistant's own time estimate for it runs out, e.g. 'Native swipe 5 min · Box fix 40 min' (two tasks, the nearest and the last). {n} becomes a whole number; keep it. Abbreviate 'minutes' as is usual in the language; no full stop. */
  etaMinutes: string;
  /** Heading above the list of tasks with time estimates at the top of the state tree panel in the chat (each row: task title, a small progress bar, time left). Short noun phrase, no full stop. */
  etaList: string;
};

export const CHAT_STRINGS_EN: ChatStrings = {
  name: AGENT_NAME_EN,
  chatWith: "Chat with your {name}",
  message: "Message your {name}…",
  offline: "Your {name} is offline — your message waits for it…",
  waiting: "· waiting for your {name}",
  waitingTitle: "Your {name} is offline: this is delivered when it is back",
  you: "you",
  hint: "Type here; it is sent 3 s after you stop.",
  listening: "Your {name} is listening ({n})",
  statusOffline: "Your {name} is offline · messages wait until it is back",
  polished: "Polished by your {name}",
  unmerge: "Split back into the separate messages",
  clipsRecording: "Recording",
  clipsStop: "Stop",
  clipsScreenOn: "Screen kept on",
  clipsScreenMaySleep: "Pauses when the screen sleeps",
  clipsPaused: "Paused {n} min",
  clipsStopsIn: "Stops in {n} min",
  clipsContinue: "Continue recording",
  clipsSaved: "{n} saved",
  clipsSaveFailed: "Saving failed",
  clipsStart: "Record voice clips",
  clipsAutoStop: "Auto-stop after {n} min",
  cueSend: "Sound when a voice message is sent",
  cueSpeech: "Sound when speech starts and ends",
  readAloud: "Replies read aloud",
  readAloudTyping: "Replies read aloud while typing",
  compactIdle: "Only the last message while not typing",
  devGroup: "Dev",
  compactShowAll: "Show the whole chat",
  askJump: "Go to the nearest unanswered question above. Unanswered above: {count}",
  fullScreen: "Full screen",
  fullScreenExit: "Exit full screen",
  dragGrip: "Move the chat: drag. Tap to fold or open, double-tap for the menu",
  vpMenu: "Voiceprint",
  vpTitle: "Your voiceprint",
  vpNone: "No voiceprint yet.",
  vpPrint: "{device}: {n} sentences",
  vpOff: "Needs the local speech model on your Mac (the green dot on the mic).",
  vpEnrol: "Enrol this device",
  vpConsent: "Before anything is recorded: you will read {n} short sentences aloud. Your Mac turns them into a voiceprint (numbers that describe your voice, not a recording) and keeps it there, in ~/.config/lianki-stt/voiceprints. After you confirm with your passkey, a copy of these numbers is also kept in your Lianki account, encrypted and readable only by your account, so another Mac can get it back. No recording is kept in your account. It is used to check that a line spoken to your {name} is your voice. You can delete it, on the Mac and in your account, here at any time.",
  vpKeepAudio: "Also keep the recordings of these sentences on my Mac",
  vpAgree: "I agree, start",
  vpCancel: "Cancel",
  vpRead: "Read this aloud, then pause:",
  vpProgress: "{n} of {total} kept",
  vpShort: "Too short. Read it again, a little slower.",
  vpNoise: "Too noisy here. Try again somewhere quieter.",
  vpMismatch: "That did not sound like the other sentences. Read it again.",
  vpText: "That was not this sentence. Read it again.",
  vpUnreachable: "Your Mac did not answer. Check the green dot on the mic.",
  vpSkip: "Skip",
  vpSave: "Save voiceprint",
  vpSaving: "Saving…",
  vpSaved: "Voiceprint saved on your Mac.",
  vpDelete: "Delete my voiceprint",
  vpDeleteConfirm: "Delete your voiceprint for every device, from your Mac and from your account? Your saved voice clips are not touched.",
  vpDeleteYes: "Delete",
  vpDeleted: "Voiceprint deleted.",
  vpFailed: "Voiceprint: something went wrong ({error})",
  vpClose: "Close",
  vpVerified: "Your voice, verified",
  vpFilterOn: "Only my voice: on. Speech that does not match is dropped on your Mac.",
  vpFilterOff: "Only my voice: off. All speech is transcribed as usual.",
  vpFilterWaiting: "Only my voice: needs a voiceprint on this device and the check on your Mac. Until then all speech is transcribed as usual.",
  vpFilterCount: "Dropped today: {n}. Voice did not match (last score {score}).",
  vpFilterWould: "Would have been dropped today: {n} (still sent).",
  vpFilterPause: "Pause on this device",
  vpCloudSave: "Save to my account",
  vpCloudRestore: "Restore from my account",
  vpCloudSaving: "Saving to your account…",
  vpCloudRestoring: "Restoring on your Mac…",
  vpCloudSaved: "Saved in your account ({n}).",
  vpCloudRestored: "Restored on your Mac from your account ({n}).",
  vpCloudHas: "In your account: {devices}.",
  vpCloudNone: "Not saved in your account yet.",
  vpCloudFailed: "Your account copy: something went wrong ({error})",
  notReadHidden: "· not read aloud: the page was in the background",
  attachOpen: "Add or attach",
  attachGroupAdd: "Add",
  attachGroupMessage: "Attach to message",
  attachSelection: "Page selection",
  attachSelectionNone: "Select some text on the page first.",
  attachFile: "File",
  attachMedia: "Photo, video or audio",
  attachSoon: "Coming soon",
  attachRemove: "Remove the attached selection",
  attachDrop: "Drop to attach",
  attachUploading: "Uploading…",
  attachFailed: "Upload failed",
  attachTooBig: "Too large",
  attachFileRemove: "Remove this file",
  inbox: "Inbox",
  chatHistory: "History",
  inboxEmpty: "Nothing here yet.",
  inboxUsage: "{size} stored · {n} files",
  inboxUsageQuota: "{size} of {quota} used · {n} files",
  inboxFailed: "Could not load the inbox.",
  inboxProcessed: "Processed",
  inboxDelete: "Delete",
  inboxDeleteConfirm: "Delete for good?",
  inboxKeep: "Keep",
  inboxClose: "Close",
  etaTasks: "{n} tasks",
  etaLeft: "{t} left",
  etaNext: "next in {t}",
  etaReached: "ETA reached",
  etaDone: "done",
  etaOpen: "Show all tasks on a full-screen timeline",
  etaGanttClose: "Close the timeline",
  etaGanttScale: "Time axis",
  etaGanttLinear: "Linear",
  etaGanttLog: "Log",
  etaWaitingYou: "Waiting for you",
  etaGanttLegend: "Underline = reported progress · red line = now",
  etaReminder: "reminder in {t}",
  etaGanttLegendTicks: "tick = estimate changed or confirmed · faint grey = original plan",
  etaTickEarlier: "moved up: {names}",
  etaTickLater: "postponed: {names}",
  etaTickConfirmed: "confirmed: {names}",
  etaTickSet: "estimated: {names}",
  etaTickStatus: "status changed: {names}",
  etaTickClose: "Close",
  etaList: "Timed tasks",
  etaMinutes: "{n} min",
  attachQuoted: "Quoted from the page",
  attachGroupView: "View",
  attachTree: "State tree",
};

/** Most characters of a page selection attached to a line. */
export const MAX_SELECTION = 2000;
/** Most characters of the attached page's title. */
export const MAX_CONTEXT_TITLE = 200;
/** Most characters of its path (or host). */
export const MAX_CONTEXT_PATH = 300;

/**
 * A line's attachment from the page (the + menu's "Page selection",
 * attach.ts): the selected text, the page's path (never its query or
 * fragment) and title, and its host when the chat runs on another site.
 */
export type ChatContext = {
  selection: string;
  path?: string;
  title?: string;
  host?: string;
};

/**
 * Most characters of a voice line's screen text: the same bound as a page
 * selection (MAX_SELECTION), the other text a line carries from its page.
 */
export const MAX_SCENE_SCREEN = MAX_SELECTION;

/** Where a voice line was spoken (ChatMessage.scene): path (no query), title, screen text. */
export type SttScene = { path?: string; title?: string; screen?: string };

/** An SttScene from the wire, or undefined: known keys only, each bounded. */
export function cleanScene(raw: unknown): SttScene | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const text = (v: unknown, max: number) =>
    typeof v === "string"
      ? v
          .replace(/[\u0000-\u001f\u007f]/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, max)
      : "";
  const path = text(r.path, MAX_CONTEXT_PATH).split(/[?#]/)[0]!.trim();
  const title = text(r.title, MAX_CONTEXT_TITLE);
  const screen = text(r.screen, MAX_SCENE_SCREEN);
  const out: SttScene = {
    ...(path.startsWith("/") ? { path } : {}),
    ...(title ? { title } : {}),
    ...(screen ? { screen } : {}),
  };
  return Object.keys(out).length ? out : undefined;
}

/** Most files sent with one line. */
export const MAX_ATTACHMENTS = 10;
/** Most characters of an attached file's name. */
export const MAX_ATTACHMENT_NAME = 200;

/**
 * A file sent with a line (ChatMessage.attachments): the host's id for the
 * upload, the file's name (display only), its type and size in bytes.
 */
export type AttachmentRef = { id: string; name: string; type: string; size: number };

/** Control and bidirectional-override characters: never in a shown file name. */
const NAME_JUNK = /[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** A file name for display: no control or bidi characters, no folders, bounded. */
export function cleanFileName(raw: unknown): string {
  const s = typeof raw === "string" ? raw : "";
  const base = s.replace(NAME_JUNK, "").split(/[\\/]/).at(-1)!.trim();
  return base.slice(0, MAX_ATTACHMENT_NAME) || "file";
}

/** AttachmentRefs from the wire, or undefined: known keys only, each checked; at most MAX_ATTACHMENTS. */
export function cleanAttachments(raw: unknown): AttachmentRef[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: AttachmentRef[] = [];
  for (const a of raw.slice(0, MAX_ATTACHMENTS)) {
    if (!a || typeof a !== "object") continue;
    const r = a as Record<string, unknown>;
    if (typeof r.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(r.id)) continue;
    const type =
      typeof r.type === "string" && /^[a-z0-9.+-]{1,40}\/[a-z0-9.+-]{1,60}$/.test(r.type)
        ? r.type
        : "application/octet-stream";
    const size = typeof r.size === "number" && Number.isSafeInteger(r.size) && r.size >= 0 ? r.size : 0;
    if (out.some((x) => x.id === r.id)) continue;
    out.push({ id: r.id, name: cleanFileName(r.name), type, size });
  }
  return out.length ? out : undefined;
}

/** A ChatContext from the wire, or undefined: known keys only, each bounded; no selection, none. */
export function cleanContext(raw: unknown): ChatContext | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const text = (v: unknown, max: number) =>
    typeof v === "string" ? v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").slice(0, max) : "";
  const selection = text(r.selection, MAX_SELECTION).trim();
  if (!selection) return undefined;
  const path = text(r.path, MAX_CONTEXT_PATH).split(/[?#]/)[0]!.trim();
  const title = text(r.title, MAX_CONTEXT_TITLE).replace(/\s+/g, " ").trim();
  const host = text(r.host, MAX_CONTEXT_PATH).trim().toLowerCase();
  return {
    selection,
    ...(path.startsWith("/") ? { path } : {}),
    ...(title ? { title } : {}),
    ...(/^[a-z0-9.-]+(:\d+)?$/.test(host) ? { host } : {}),
  };
}

/** Defaults filled in and `{name}` substituted. */
export function chatStrings(s?: Partial<ChatStrings>): ChatStrings {
  const all = { ...CHAT_STRINGS_EN, ...s };
  const name = all.name || AGENT_NAME_EN;
  const out = { ...all };
  for (const k of Object.keys(out) as (keyof ChatStrings)[]) out[k] = out[k].replaceAll("{name}", name);
  return out;
}

/**
 * The draft after a transcript landed in it, if the whole draft is still
 * dictation (the draft was empty, or is exactly what dictation left there);
 * null once anything typed is in it.
 */
export function dictatedDraft(prev: string, pure: string | null, next: string): string | null {
  return !prev.trim() || prev === pure ? next : null;
}

/**
 * A line's source as it is sent: "stt" when the draft is exactly what the
 * mic left there (sent as heard, or unchanged); undefined when anything was
 * typed or edited in it.
 */
export function draftSource(draft: string, pure: string | null): MessageSource | undefined {
  return pure !== null && draft === pure && !!draft.trim() ? "stt" : undefined;
}

/**
 * A voice line's timestamps (Date.now() on the sending page) and the STT
 * server's own ms, carried on the owner line's envelope so the hub and the
 * listener can see where an utterance spent its time. Every field is
 * optional; `t_sent` is always there on a page that sends one.
 *
 * t_lastVoice   the last frame the VAD scored as speech (Silero only)
 * t_speechEnd   the VAD ended the utterance (after its silence timeout)
 * t_uploadStart the WAV POST to /api/debug/stt began
 * t_sttDone     its transcript came back
 * t_shown       the transcript landed in the input (上屏)
 * t_sent        the line went out on the socket
 * sttServerMs   the route's own transcription time (SttResult.ms)
 * audioMs       the utterance's length
 */
export type VoiceTiming = {
  t_lastVoice?: number;
  t_speechEnd?: number;
  t_uploadStart?: number;
  t_sttDone?: number;
  t_shown?: number;
  t_sent?: number;
  sttServerMs?: number;
  audioMs?: number;
  /** The VAD's start of the first utterance in the line (voice-merge.ts: the gap to the line before). */
  t_speechStart?: number;
  /** The capture hit MAX_UTTERANCE_MS and was cut: it did not end by silence. */
  t_cut?: number;
};
export const VOICE_TIMING_KEYS = [
  "t_lastVoice",
  "t_speechEnd",
  "t_uploadStart",
  "t_sttDone",
  "t_shown",
  "t_sent",
  "sttServerMs",
  "audioMs",
  "t_speechStart",
  "t_cut",
] as const satisfies readonly (keyof VoiceTiming)[];

/**
 * A VoiceTiming from the wire, or undefined: only the known keys, each a
 * finite non-negative number (rounded to whole ms); anything else is dropped.
 */
/**
 * The local STT server's speaker check on a voice line (scripts/local-stt/
 * voiceprint.py; docs/local-stt.md, "Voiceprint"): the cosine `score` of the
 * line against the owner's enrolled voiceprint, and its `decision` from the
 * per-duration bands and the noise gate. "me" = verified as him; "other" = not
 * him; "unknown" = too short, too noisy, between the bands, or no voiceprint.
 * A line made of several utterances carries the weakest of them
 * (combineSpeaker). Reported by the owner's page, never stamped by the hub:
 * it is the base for voice approvals later, not an approval by itself.
 */
export type SpeakerDecision = "me" | "other" | "unknown";
export type SpeakerTag = {
  decision: SpeakerDecision;
  /** Cosine to the print, -1..1 (absent when nothing was scored). */
  score?: number;
  /** The embedding model ("campp", later "eres2netv2"). */
  model?: string;
  /** Whose print it was scored against (the device slug, "iphone"). */
  device?: string;
  /** Why "unknown": "short" | "noise" | "between" | "no-print". */
  reason?: string;
  speechS?: number;
  snrDb?: number;
  /**
   * The texts the Mac signed, in order: set only by the hub after it verified
   * the proofs (lib/speaker-proof.ts), never taken from a page (cleanSpeaker
   * drops it). Any decision based on a voice line must use these words, not
   * the line's displayed text.
   */
  signed?: string[];
};
const SPEAKER_DECISIONS: readonly SpeakerDecision[] = ["me", "other", "unknown"];
const SLUG = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** A SpeakerTag from the wire, or undefined: known keys only, each checked. */
export function cleanSpeaker(raw: unknown): SpeakerTag | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const d = r.decision;
  if (typeof d !== "string" || !SPEAKER_DECISIONS.includes(d as SpeakerDecision)) return undefined;
  const out: SpeakerTag = { decision: d as SpeakerDecision };
  const num = (v: unknown, lo: number, hi: number) =>
    typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : undefined;
  const score = num(r.score, -1, 1);
  if (score !== undefined) out.score = Math.round(score * 1000) / 1000;
  const speech = num(r.speechS, 0, 600);
  if (speech !== undefined) out.speechS = Math.round(speech * 100) / 100;
  const snr = num(r.snrDb, -100, 200);
  if (snr !== undefined) out.snrDb = Math.round(snr * 10) / 10;
  for (const k of ["model", "device", "reason"] as const) {
    const v = r[k];
    if (typeof v === "string" && SLUG.test(v)) out[k] = v;
  }
  return out;
}

/**
 * One tag for a line made of several utterances: the weakest decision wins
 * (any "other" → other; else any "unknown" → unknown; all "me" → me), with
 * the lowest score. Undefined when no utterance carried a tag.
 */
export function combineSpeaker(tags: readonly (SpeakerTag | undefined)[]): SpeakerTag | undefined {
  const ts = tags.filter((t): t is SpeakerTag => !!t);
  if (!ts.length) return undefined;
  const rank: Record<SpeakerDecision, number> = { other: 0, unknown: 1, me: 2 };
  return ts.reduce((a, b) => {
    const w = rank[b.decision] < rank[a.decision] ? b : a;
    const scores = [a.score, b.score].filter((s): s is number => s !== undefined);
    return scores.length ? { ...w, score: Math.min(...scores) } : w;
  });
}

export function cleanTiming(raw: unknown): VoiceTiming | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: VoiceTiming = {};
  let any = false;
  for (const k of VOICE_TIMING_KEYS) {
    const v = (raw as Record<string, unknown>)[k];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1e14) continue;
    out[k] = Math.round(v);
    any = true;
  }
  return any ? out : undefined;
}
