/**
 * The chat's system lines about its lanes (owner, 2026-11-15 "全员入群"): an
 * agent joined, started listening live, turned reader, left, was muted. The
 * hub (workers/push/src/lane-registry.ts) posts them in the thread with
 * `laneEvent` set and its text in the thread's own language (config
 * `lanes.eventLocale`); a page shows them in its own language
 * (withLaneEvent), an older page the stored text. Also the words for a
 * lane's mode in the presence stack (头像叠).
 *
 * Strings in the app's 16 locales (docs/i18n.md), each key with its context
 * line below (LANE_EVENT_CONTEXT): where it shows, what it means, how it is
 * used. `{name}` is the agent's name (keep it); `{names}` a comma-separated
 * list of them.
 *
 * Pure: unit/lane-events.test.ts.
 */
import { CHAT_LOCALES, type ChatLocale } from "./chat-ui-locales";

/** What happened to a lane. */
export const LANE_EVENT_KINDS = [
  "joined",
  "listening",
  "listeningAll",
  "reader",
  "left",
  "muted",
  "unmuted",
] as const;
export type LaneEventKind = (typeof LANE_EVENT_KINDS)[number];
/** A lane's mode: a resident listener (hears every line live) or a reader (reads when it wants, woken by name). */
export type LaneMode = "reader" | "listener";
/**
 * What a listener hears (owner, 2026-11-15 15:1x JST, the five tiers in docs/lane-listen.md):
 * "owner" his lines only (tier ②), "all" every line, agents' and system lines too (tier ①).
 * Absent = "owner" (an older client or hub).
 */
export type LaneScope = "owner" | "all";
export const isLaneScope = (v: unknown): v is LaneScope => v === "owner" || v === "all";

/** On a system line (wire.ts ChatMessage.laneEvent): which lane, its name then, and what happened. */
export type LaneEvent = { lane: string; name: string; kind: LaneEventKind };

export type LaneEventStrings = Record<LaneEventKind, string> & {
  modeListener: string;
  modeListenerAll: string;
  modeReader: string;
  modeMuted: string;
  tokensNeeded: string;
};
type Key = keyof LaneEventStrings;

/** One line per key: what a translator reads before the string. */
export const LANE_EVENT_CONTEXT: Record<Key, string> = {
  joined:
    "A one-line system notice in the chat log when an AI agent joins the conversation for the first time, as a reader (it can read the chat but does not hear every message live). {name} is the agent's name; keep it. A short past-tense statement.",
  listening:
    "A one-line system notice in the chat log: the AI agent {name} now hears the owner's messages in real time (it switched to live listening). Keep {name}. A short statement, like a status change.",
  listeningAll:
    "A one-line system notice in the chat log: the AI agent {name} now hears ALL messages in real time — the owner's, every other AI agent's and these system notices — not only the owner's. Keep {name}. The same statement as the plain live-listening notice, with a short qualifier for 'all messages' (e.g. in parentheses).",
  reader:
    "A one-line system notice in the chat log: the AI agent {name} stopped listening live and is now read-only (it reads the chat only when called by name). Keep {name}. A short statement.",
  left:
    "A one-line system notice in the chat log: the AI agent {name} went offline and left the conversation. Keep {name}. A short statement, as in a group chat.",
  muted:
    "A one-line system notice in the chat log: the owner muted the AI agent {name}; it can still read but can no longer post. Keep {name}. A short statement.",
  unmuted:
    "A one-line system notice in the chat log: the AI agent {name} may post again (its mute was lifted). Keep {name}. A short statement.",
  modeListener:
    "A small status word in the list of agents present in the chat (hover card beside each avatar): this agent hears the owner's messages live. An adjective or short phrase, not a verb command.",
  modeListenerAll:
    "A small status word in the list of agents present in the chat (hover card beside each avatar, also the tooltip of the small dot on its avatar): this agent hears ALL messages live, the other agents' and system notices too, not only the owner's. The plain live-listening phrase with a short 'all messages' qualifier.",
  modeReader:
    "A small status word in the list of agents present in the chat (hover card beside each avatar): this agent only reads the chat, and is woken when called by name. An adjective or short phrase.",
  modeMuted:
    "A small status word in the list of agents present in the chat (hover card beside each avatar): this agent was muted by the owner and cannot post. An adjective or short phrase.",
  tokensNeeded:
    "A one-line system notice in the owner's chat: these AI agents are waiting for an access token before they can join; the owner creates them under Preferences → API tokens. {names} is a comma-separated list of agent names; keep it.",
};

export const LANE_EVENT_STRINGS: Record<ChatLocale, LaneEventStrings> = {
  en: {
    joined: "{name} joined (read-only)",
    listening: "{name} is now listening live",
    listeningAll: "{name} is now listening live (all messages)",
    reader: "{name} switched to read-only",
    left: "{name} went offline",
    muted: "{name} was muted",
    unmuted: "{name} may post again",
    modeListener: "listening live",
    modeListenerAll: "listening live (all messages)",
    modeReader: "read-only",
    modeMuted: "muted",
    tokensNeeded: "Waiting for a token to join: {names} (Preferences → API tokens)",
  },
  zh: {
    joined: "{name} 入群（只读）",
    listening: "{name} 开始实时监听",
    listeningAll: "{name} 开始实时监听（全部消息）",
    reader: "{name} 转为只读",
    left: "{name} 下线",
    muted: "{name} 已禁言",
    unmuted: "{name} 解除禁言",
    modeListener: "实时监听",
    modeListenerAll: "实时监听（全部消息）",
    modeReader: "只读",
    modeMuted: "已禁言",
    tokensNeeded: "还在等 token 才能入群：{names}（偏好设置 → API tokens）",
  },
  hi: {
    joined: "{name} जुड़ा (केवल पढ़ने के लिए)",
    listening: "{name} अब लाइव सुन रहा है",
    listeningAll: "{name} अब लाइव सुन रहा है (सभी संदेश)",
    reader: "{name} अब केवल पढ़ रहा है",
    left: "{name} ऑफ़लाइन हो गया",
    muted: "{name} को म्यूट किया गया",
    unmuted: "{name} फिर से लिख सकता है",
    modeListener: "लाइव सुन रहा है",
    modeListenerAll: "लाइव सुन रहा है (सभी संदेश)",
    modeReader: "केवल पढ़ना",
    modeMuted: "म्यूट",
    tokensNeeded: "जुड़ने के लिए टोकन का इंतज़ार: {names} (प्राथमिकताएँ → API टोकन)",
  },
  es: {
    joined: "{name} se unió (solo lectura)",
    listening: "{name} ahora escucha en directo",
    listeningAll: "{name} ahora escucha en directo (todos los mensajes)",
    reader: "{name} pasó a solo lectura",
    left: "{name} se desconectó",
    muted: "{name} fue silenciado",
    unmuted: "{name} puede volver a escribir",
    modeListener: "escuchando en directo",
    modeListenerAll: "escuchando en directo (todos los mensajes)",
    modeReader: "solo lectura",
    modeMuted: "silenciado",
    tokensNeeded: "Esperan un token para unirse: {names} (Preferencias → Tokens de API)",
  },
  fr: {
    joined: "{name} a rejoint (lecture seule)",
    listening: "{name} écoute maintenant en direct",
    listeningAll: "{name} écoute maintenant en direct (tous les messages)",
    reader: "{name} est passé en lecture seule",
    left: "{name} s'est déconnecté",
    muted: "{name} a été mis en sourdine",
    unmuted: "{name} peut de nouveau écrire",
    modeListener: "écoute en direct",
    modeListenerAll: "écoute en direct (tous les messages)",
    modeReader: "lecture seule",
    modeMuted: "en sourdine",
    tokensNeeded: "En attente d'un jeton pour rejoindre : {names} (Préférences → Jetons d'API)",
  },
  ar: {
    joined: "انضم {name} (قراءة فقط)",
    listening: "{name} يستمع الآن مباشرة",
    listeningAll: "{name} يستمع الآن مباشرة (كل الرسائل)",
    reader: "تحوّل {name} إلى القراءة فقط",
    left: "خرج {name} من الاتصال",
    muted: "تم كتم {name}",
    unmuted: "يمكن لـ {name} الكتابة مجددًا",
    modeListener: "يستمع مباشرة",
    modeListenerAll: "يستمع مباشرة (كل الرسائل)",
    modeReader: "قراءة فقط",
    modeMuted: "مكتوم",
    tokensNeeded: "بانتظار رمز للانضمام: {names} (التفضيلات ← رموز API)",
  },
  bn: {
    joined: "{name} যোগ দিয়েছে (শুধু পড়া)",
    listening: "{name} এখন সরাসরি শুনছে",
    listeningAll: "{name} এখন সরাসরি শুনছে (সব বার্তা)",
    reader: "{name} এখন শুধু পড়ছে",
    left: "{name} অফলাইন হয়েছে",
    muted: "{name}-কে মিউট করা হয়েছে",
    unmuted: "{name} আবার লিখতে পারে",
    modeListener: "সরাসরি শুনছে",
    modeListenerAll: "সরাসরি শুনছে (সব বার্তা)",
    modeReader: "শুধু পড়া",
    modeMuted: "মিউট",
    tokensNeeded: "যোগ দিতে টোকেনের অপেক্ষায়: {names} (পছন্দ → API টোকেন)",
  },
  pt: {
    joined: "{name} entrou (somente leitura)",
    listening: "{name} agora ouve ao vivo",
    listeningAll: "{name} agora ouve ao vivo (todas as mensagens)",
    reader: "{name} passou para somente leitura",
    left: "{name} ficou offline",
    muted: "{name} foi silenciado",
    unmuted: "{name} pode escrever de novo",
    modeListener: "ouvindo ao vivo",
    modeListenerAll: "ouvindo ao vivo (todas as mensagens)",
    modeReader: "somente leitura",
    modeMuted: "silenciado",
    tokensNeeded: "Aguardando um token para entrar: {names} (Preferências → Tokens de API)",
  },
  ru: {
    joined: "{name} присоединился (только чтение)",
    listening: "{name} теперь слушает в реальном времени",
    listeningAll: "{name} теперь слушает в реальном времени (все сообщения)",
    reader: "{name} перешёл в режим только чтения",
    left: "{name} отключился",
    muted: "{name}: публикация запрещена",
    unmuted: "{name} снова может писать",
    modeListener: "слушает в реальном времени",
    modeListenerAll: "слушает в реальном времени (все сообщения)",
    modeReader: "только чтение",
    modeMuted: "без права писать",
    tokensNeeded: "Ждут токена, чтобы присоединиться: {names} (Настройки → API-токены)",
  },
  ur: {
    joined: "{name} شامل ہوا (صرف پڑھنا)",
    listening: "{name} اب براہِ راست سن رہا ہے",
    listeningAll: "{name} اب براہِ راست سن رہا ہے (تمام پیغامات)",
    reader: "{name} اب صرف پڑھ رہا ہے",
    left: "{name} آف لائن ہو گیا",
    muted: "{name} کو خاموش کر دیا گیا",
    unmuted: "{name} دوبارہ لکھ سکتا ہے",
    modeListener: "براہِ راست سن رہا ہے",
    modeListenerAll: "براہِ راست سن رہا ہے (تمام پیغامات)",
    modeReader: "صرف پڑھنا",
    modeMuted: "خاموش",
    tokensNeeded: "شامل ہونے کے لیے ٹوکن کا انتظار: {names} (ترجیحات ← API ٹوکن)",
  },
  id: {
    joined: "{name} bergabung (hanya baca)",
    listening: "{name} kini mendengarkan langsung",
    listeningAll: "{name} kini mendengarkan langsung (semua pesan)",
    reader: "{name} beralih ke hanya baca",
    left: "{name} sedang offline",
    muted: "{name} dibisukan",
    unmuted: "{name} boleh menulis lagi",
    modeListener: "mendengarkan langsung",
    modeListenerAll: "mendengarkan langsung (semua pesan)",
    modeReader: "hanya baca",
    modeMuted: "dibisukan",
    tokensNeeded: "Menunggu token untuk bergabung: {names} (Preferensi → Token API)",
  },
  de: {
    joined: "{name} ist beigetreten (nur lesen)",
    listening: "{name} hört jetzt live mit",
    listeningAll: "{name} hört jetzt live mit (alle Nachrichten)",
    reader: "{name} liest jetzt nur noch",
    left: "{name} ist offline",
    muted: "{name} wurde stummgeschaltet",
    unmuted: "{name} darf wieder schreiben",
    modeListener: "hört live mit",
    modeListenerAll: "hört live mit (alle Nachrichten)",
    modeReader: "nur lesen",
    modeMuted: "stummgeschaltet",
    tokensNeeded: "Warten auf ein Token zum Beitreten: {names} (Einstellungen → API-Tokens)",
  },
  ja: {
    joined: "{name} が参加しました（閲覧のみ）",
    listening: "{name} がリアルタイムで聞き始めました",
    listeningAll: "{name} がリアルタイムで聞き始めました（全メッセージ）",
    reader: "{name} は閲覧のみになりました",
    left: "{name} がオフラインになりました",
    muted: "{name} は発言できなくなりました",
    unmuted: "{name} は再び発言できます",
    modeListener: "リアルタイムで聞いている",
    modeListenerAll: "リアルタイムで聞いている（全メッセージ）",
    modeReader: "閲覧のみ",
    modeMuted: "発言停止中",
    tokensNeeded: "参加にトークンが必要です：{names}（設定 → API トークン）",
  },
  sw: {
    joined: "{name} amejiunga (kusoma tu)",
    listening: "{name} sasa anasikiliza moja kwa moja",
    listeningAll: "{name} sasa anasikiliza moja kwa moja (ujumbe wote)",
    reader: "{name} amehamia kusoma tu",
    left: "{name} ametoka mtandaoni",
    muted: "{name} amenyamazishwa",
    unmuted: "{name} anaweza kuandika tena",
    modeListener: "anasikiliza moja kwa moja",
    modeListenerAll: "anasikiliza moja kwa moja (ujumbe wote)",
    modeReader: "kusoma tu",
    modeMuted: "amenyamazishwa",
    tokensNeeded: "Wanasubiri tokeni ili kujiunga: {names} (Mapendeleo → Tokeni za API)",
  },
  mr: {
    joined: "{name} सामील झाला (फक्त वाचन)",
    listening: "{name} आता थेट ऐकत आहे",
    listeningAll: "{name} आता थेट ऐकत आहे (सर्व संदेश)",
    reader: "{name} आता फक्त वाचत आहे",
    left: "{name} ऑफलाइन झाला",
    muted: "{name} ला म्यूट केले",
    unmuted: "{name} पुन्हा लिहू शकतो",
    modeListener: "थेट ऐकत आहे",
    modeListenerAll: "थेट ऐकत आहे (सर्व संदेश)",
    modeReader: "फक्त वाचन",
    modeMuted: "म्यूट",
    tokensNeeded: "सामील होण्यासाठी टोकनची वाट: {names} (प्राधान्ये → API टोकन)",
  },
  ko: {
    joined: "{name} 님이 참여했습니다(읽기 전용)",
    listening: "{name} 님이 실시간으로 듣기 시작했습니다",
    listeningAll: "{name} 님이 실시간으로 듣기 시작했습니다(모든 메시지)",
    reader: "{name} 님이 읽기 전용으로 바뀌었습니다",
    left: "{name} 님이 오프라인이 되었습니다",
    muted: "{name} 님의 발언이 중지되었습니다",
    unmuted: "{name} 님이 다시 발언할 수 있습니다",
    modeListener: "실시간 듣는 중",
    modeListenerAll: "실시간 듣는 중(모든 메시지)",
    modeReader: "읽기 전용",
    modeMuted: "발언 중지됨",
    tokensNeeded: "참여하려면 토큰이 필요합니다: {names}(환경설정 → API 토큰)",
  },
};

const isLocale = (l: unknown): l is ChatLocale =>
  typeof l === "string" && (CHAT_LOCALES as readonly string[]).includes(l);
const table = (locale: unknown) => LANE_EVENT_STRINGS[isLocale(locale) ? locale : "en"];

export const isLaneEventKind = (v: unknown): v is LaneEventKind =>
  typeof v === "string" && (LANE_EVENT_KINDS as readonly string[]).includes(v);

/** The system line's text in `locale` (an unknown one: English). */
export const laneEventText = (e: Pick<LaneEvent, "kind" | "name">, locale: unknown): string =>
  table(locale)[e.kind].replaceAll("{name}", e.name);

/** The "waiting for a token" line in `locale`, for these names. */
export const tokensNeededText = (names: readonly string[], locale: unknown): string =>
  table(locale).tokensNeeded.replaceAll("{names}", names.join(", "));

/** The presence row's word for a lane's mode (muted first: it is what he set); a listener's scope tells the two live kinds apart. */
export function laneModeWord(
  p: { mode?: unknown; muted?: unknown; scope?: unknown },
  locale: unknown,
): string | null {
  const t = table(locale);
  if (p.muted === true) return t.modeMuted;
  if (p.mode === "listener") return p.scope === "all" ? t.modeListenerAll : t.modeListener;
  if (p.mode === "reader") return t.modeReader;
  return null;
}

/** A well-formed lane event, or null. */
export function parseLaneEvent(raw: unknown): LaneEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  if (typeof e.lane !== "string" || typeof e.name !== "string" || !isLaneEventKind(e.kind)) return null;
  return { lane: e.lane, name: e.name, kind: e.kind };
}

/** A system line shown in the page's language: the same object when it is not one, or reads the same. */
export function withLaneEvent<M extends { laneEvent?: unknown; text: string }>(m: M, locale: unknown): M {
  const e = m.laneEvent === undefined ? null : parseLaneEvent(m.laneEvent);
  if (!e) return m;
  const text = laneEventText(e, locale);
  return text === m.text ? m : { ...m, text };
}
