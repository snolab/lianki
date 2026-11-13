/**
 * Lanes and their voices (docs/dev-debug-widget.md, "Lanes and voices").
 *
 * Several agents talk in the owner's chat — the chat lane (main), codex and
 * agy — and he tells them apart by ear and by eye. Each lane has a voice id
 * and a mark (avatar and name tag), all data here; one generic resolver
 * picks the device and cloud voice for any language. No per-language code:
 * a language is a row in SIBLING_LOCALES or a key in a cloud speaker map.
 *
 * Which lane a line is from: its `lane` field (eval.ts say --lane), else a
 * leading `【lane】` prefix in its text (what the lanes write today), which is
 * then taken off the shown and spoken text. A line with neither is the main
 * lane and looks as before.
 *
 * Device voices (speechSynthesis): main — the chat lane, a cute, young,
 * bright voice (owner, 2026-11-07 20:34 JST) — takes the first natural voice
 * it prefers, else today's pick (wire.ts pickVoice), a little higher. Every
 * other voice takes a different installed voice *model* (another name, not a
 * variant of the same one), in this order of passes, each pass over the
 * voices in VOICE_IDS order:
 *   1. a natural voice it prefers by name (VoiceSpec.prefer),
 *   2. any other natural voice of the language,
 *   3. an Eloquence voice it prefers (Apple's Reed, Flo, …: robotic but a
 *      different model),
 *   4. any other Eloquence voice.
 * Novelty voices (Bahh, Bubbles, Zarvox, …) are never used. Only when none
 * is left does the voice reuse main's with its pitch and rate (last resort).
 * Never silence: no voice at all still speaks with the browser's default.
 *
 * Cloud voices (voice-out.ts, /api/words/tts): a speaker on an engine that
 * has several for the language (Workers AI Aura-2: English and Spanish).
 * Elsewhere the cloud has one voice (MeloTTS), so the clip is played at a
 * lane's own speed (`shift`), its pitch kept, as the last resort. Never a
 * pitch shift: on iOS a clip played pitch-free through the voice context
 * stalls mid-word (owner's iPhone, 2026-11-07: "续续" dropped; the clip's
 * currentTime froze ~200 ms while it "played"), and the owner does not want
 * pitch tweaks anyway. Main has no shift: his reading speed as it is.
 *
 * Pure: unit/voices.test.ts.
 */

/** A lane: who is talking in the owner's chat. */
export const LANE_IDS = ["main", "codex", "agy", "claude"] as const;
export type LaneId = (typeof LANE_IDS)[number];

/** A voice a line is read in. */
export const VOICE_IDS = ["main", "calm", "bright"] as const;
export type VoiceId = (typeof VOICE_IDS)[number];

export type VoiceSpec = {
  /**
   * Device voices this voice wants, best first, matched case-insensitively
   * against a voice's name before any " (…)" — the whole name or one of its
   * words ("Microsoft Yunxi Online" matches "Yunxi"). Any language's names
   * in one list: a voice's name is its own across languages. Empty = main.
   */
  prefer: readonly string[];
  /**
   * Main: its pitch always. The others: only as the last resort, on a
   * device with no other voice left (main's voice at this pitch…)
   */
  pitch: number;
  /** …and this speed factor (times the owner's reading speed). */
  rate: number;
  /** Cloud: the speaker per engine and language, where the engine has several. */
  cloud: { aura?: Readonly<Record<string, string>> };
  /**
   * Cloud last resort, where the cloud has one voice for the language: the
   * clip plays at this speed (times his reading speed), pitch kept (1 = as is).
   */
  shift: number;
};

export const VOICES: Readonly<Record<VoiceId, VoiceSpec>> = {
  // The chat lane: cute, young and bright (a cat-girl feel), a little higher.
  main: {
    prefer: [
      "Meijia",
      "Xiaoyi",
      "Lili",
      "Shasha",
      "Nicky",
      "Zoe",
      "Ava",
      "Samantha",
      "O-ren",
      "Nanami",
      "Sora",
      "Yuna",
      "SunHi",
    ],
    pitch: 1.1,
    rate: 1,
    cloud: { aura: { en: "luna", es: "celeste" } },
    shift: 1,
  },
  // Lower and calmer: male and deeper voices first.
  calm: {
    prefer: [
      "Li-mu",
      "Yunxi",
      "Yunyang",
      "Yunjian",
      "Daniel",
      "Aaron",
      "Arthur",
      "Evan",
      "Nathan",
      "Tom",
      "Alex",
      "Gordon",
      "Lee",
      "Rishi",
      "Aman",
      "Otoya",
      "Hattori",
      "Keita",
      "Minsu",
      "InJoon",
      "Thomas",
      "Jorge",
      "Reed",
      "Rocko",
      "Eddy",
      "Grandpa",
    ],
    pitch: 0.8,
    rate: 0.92,
    cloud: { aura: { en: "orion", es: "nestor" } },
    shift: 0.88,
  },
  // Higher and brighter: lighter female voices first (main's picks go to main first).
  bright: {
    prefer: [
      "Lili",
      "Shasha",
      "Yu-shu",
      "Xiaoxiao",
      "Meijia",
      "Tingting",
      "Karen",
      "Moira",
      "Tessa",
      "Nicky",
      "Ava",
      "Allison",
      "Susan",
      "Zoe",
      "Serena",
      "Kate",
      "Tara",
      "O-ren",
      "Kyoko",
      "Nanami",
      "Sora",
      "Yuna",
      "SunHi",
      "Amelie",
      "Monica",
      "Paulina",
      "Flo",
      "Shelley",
      "Sandy",
      "Grandma",
    ],
    pitch: 1.4,
    rate: 1.06,
    cloud: { aura: { en: "thalia", es: "carina" } },
    shift: 1.2,
  },
};

/** How a lane's lines look: a small own-drawn mark on an oklch disc (24×24 viewBox). */
export type LaneMark = {
  /** Disc and drawing colours: mid lightness, so they read in light and dark. */
  bg: string;
  fg: string;
  /** Path data, drawn in `fg`. */
  paths: readonly { d: string; fill?: boolean }[];
};

export type LaneSpec = {
  /** The name tag on its lines (a proper name: not translated). Empty = the host's agent name. */
  name: string;
  voice: VoiceId;
  /** What its `【…】` prefix may say, lower case. */
  aliases: readonly string[];
  /** Its avatar; absent = the host's agent avatar, as today. */
  mark?: LaneMark;
};

export const LANES: Readonly<Record<LaneId, LaneSpec>> = {
  main: { name: "", voice: "main", aliases: ["main", "chat"] },
  codex: {
    // coco (owner, 2026-11-14: "codex 的话就让它叫做 coco 吧"); the lane id and `【codex】` stay.
    name: "coco",
    voice: "calm",
    aliases: ["codex", "coco"],
    // Two slow waves: calm, low.
    mark: {
      bg: "oklch(0.5 0.143 22.3)",
      fg: "oklch(0.97 0.02 255)",
      paths: [{ d: "M5 10c2.3-2 4.7-2 7 0s4.7 2 7 0" }, { d: "M5 15c2.3-2 4.7-2 7 0s4.7 2 7 0" }],
    },
  },
  agy: {
    // 杰咪 (owner, 2026-11-14: "你的名字名片还没改"); the lane id and `【agy】` stay.
    name: "杰咪",
    voice: "bright",
    aliases: ["agy", "antigravity", "杰咪"],
    // A four-point spark: bright, high.
    mark: {
      bg: "oklch(0.8 0.14 80)",
      fg: "oklch(0.3 0.08 60)",
      paths: [{ d: "M12 4l1.9 6.1L20 12l-6.1 1.9L12 20l-1.9-6.1L4 12l6.1-1.9Z", fill: true }],
    },
  },
  // Claude Code helping agy (owner, 2026-11-13: named 小可). Low and calm, like codex,
  // told apart by its mark: three dots in a row, a thought being finished.
  claude: {
    // 小克: the 克 of 克劳德 (owner's wife's choice, 2026-11-14); 小可 still reads as this lane.
    name: "小克",
    voice: "calm",
    aliases: ["claude", "小克", "小可"],
    mark: {
      bg: "oklch(0.55 0.1 250)",
      fg: "oklch(0.97 0.02 250)",
      paths: [
        { d: "M5.5 12a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0Z", fill: true },
        { d: "M10.5 12a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0Z", fill: true },
        { d: "M15.5 12a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0Z", fill: true },
      ],
    },
  },
};

export const isLaneId = (v: unknown): v is LaneId =>
  typeof v === "string" && (LANE_IDS as readonly string[]).includes(v);
export const isVoiceId = (v: unknown): v is VoiceId =>
  typeof v === "string" && (VOICE_IDS as readonly string[]).includes(v);

/** A leading `【name】` and the space after it. */
const PREFIX = /^\s*【\s*([^】\n]{1,24}?)\s*】\s*/u;

const laneByAlias = (name: string): LaneId | null => {
  const n = name.toLowerCase();
  return LANE_IDS.find((id) => LANES[id].aliases.includes(n)) ?? null;
};

/**
 * Which lane a line is from, and its text without the lane's prefix: the
 * `lane` field, else a `【lane】` prefix naming a known lane. An unknown
 * prefix stays in the text. `lane: null` = no lane (looks as today).
 */
export function laneOf(m: { lane?: unknown; text: string }): { lane: LaneId | null; text: string } {
  const hit = PREFIX.exec(m.text);
  const fromPrefix = hit ? laneByAlias(hit[1]!) : null;
  const lane = isLaneId(m.lane) ? m.lane : fromPrefix;
  // The prefix goes when it names this line's lane (the name tag says it).
  const text = hit && fromPrefix && fromPrefix === lane ? m.text.slice(hit[0].length) : m.text;
  return { lane, text };
}

/**
 * An agent line with its lane resolved: `lane` set and the prefix taken off
 * the text. The same object when nothing changes; other senders untouched.
 */
export function withLane<M extends { from?: string; lane?: unknown; text: string }>(m: M): M {
  if (m.from !== "agent" || typeof m.text !== "string") return m;
  const r = laneOf(m);
  if (!r.lane || (r.lane === m.lane && r.text === m.text)) return m;
  return { ...m, lane: r.lane, text: r.text };
}

/** The voice a line is read in: its `voice`, else its lane's, else main. */
export function voiceIdOf(m: { voice?: unknown; lane?: unknown; text?: string }): VoiceId {
  if (isVoiceId(m.voice)) return m.voice;
  const lane = laneOf({ lane: m.lane, text: m.text ?? "" }).lane;
  return lane ? LANES[lane].voice : "main";
}

// ---- Device voices -------------------------------------------------------

/** The shape of a SpeechSynthesisVoice this needs. */
export type VoiceLike = { lang: string; name?: string; voiceURI?: string; default?: boolean };

/**
 * Other locales of a language whose voices read its text the same way (data,
 * not code): Taiwan Mandarin reads mainland text; Cantonese (zh-HK) does
 * not, so it is not listed. A locale not here uses only itself.
 */
export const SIBLING_LOCALES: Readonly<Record<string, readonly string[]>> = {
  "zh-CN": ["zh-TW"],
  "en-US": ["en-GB", "en-AU", "en-IE", "en-ZA", "en-IN", "en-CA", "en-NZ"],
};

/** Apple's Eloquence voices (each its own model, robotic), by name. */
export const ELOQUENCE = ["eddy", "flo", "grandma", "grandpa", "reed", "rocko", "sandy", "shelley"];
/** Novelty and old MacinTalk voices: never used for a lane. */
export const NOVELTY = [
  "albert",
  "bad news",
  "bahh",
  "bells",
  "boing",
  "bubbles",
  "cellos",
  "wobble",
  "deranged",
  "fred",
  "good news",
  "jester",
  "hysterical",
  "junior",
  "kathy",
  "organ",
  "superstar",
  "princess",
  "ralph",
  "trinoids",
  "whisper",
  "zarvox",
];

/** A voice's model name: its name before any " (…)", lower case ("Li-mu (Enhanced)" → "li-mu"). */
export const baseName = (v: VoiceLike) =>
  (v.name ?? v.voiceURI ?? "").split(" (")[0]!.split("（")[0]!.trim().toLowerCase();

/** 2 natural, 1 Eloquence, 0 never (novelty). */
export function voiceTier(v: VoiceLike): 0 | 1 | 2 {
  const uri = (v.voiceURI ?? "").toLowerCase();
  const base = baseName(v);
  if (uri.includes("speech.synthesis.voice.") || NOVELTY.includes(base)) return 0;
  if (uri.includes("eloquence") || ELOQUENCE.includes(base)) return 1;
  return 2;
}

/** Premium, then Enhanced, then the plain voice (within one tier). */
const grade = (v: VoiceLike) => {
  const s = `${v.voiceURI ?? ""} ${v.name ?? ""}`.toLowerCase();
  return s.includes("premium") ? 2 : s.includes("enhanced") ? 1 : 0;
};

const norm = (l: string) => l.replace(/_/g, "-").toLowerCase();

const prefIndex = (v: VoiceLike, prefer: readonly string[]) => {
  const base = baseName(v);
  const words = base.split(/\s+/);
  const i = prefer.findIndex((p) => {
    const q = p.toLowerCase();
    return base === q || words.includes(q);
  });
  return i < 0 ? Infinity : i;
};

/** What a voice id reads with on this device. */
export type DeviceVoice<V> = {
  /** The voice to set (absent: the browser's default for the language). */
  voice?: V;
  pitch: number;
  rate: number;
  /** It had to reuse main's voice: only pitch and rate tell it apart. */
  shared: boolean;
};

/**
 * Every voice id's device voice for `lang`, each a different model where the
 * device has enough (see the file's comment). `pick` is main's (pickVoice).
 */
export function resolveVoices<V extends VoiceLike>(
  voices: readonly V[],
  lang: string,
  pick: (voices: readonly V[], lang: string) => V | undefined,
): Record<VoiceId, DeviceVoice<V>> {
  const want = [norm(lang), ...(SIBLING_LOCALES[lang] ?? []).map(norm)];
  // The language's own locale first, then its siblings; within, best grade first.
  const pool = voices
    .filter((v) => want.includes(norm(v.lang)) && voiceTier(v) > 0)
    .map((v, i) => ({ v, i, loc: want.indexOf(norm(v.lang)) }))
    .sort((a, b) => a.loc - b.loc || grade(b.v) - grade(a.v) || a.i - b.i)
    .map((x) => x.v);
  // Main: the first natural voice it prefers, else today's pick.
  let mainPref: { v: V; rank: number } | null = null;
  for (const v of pool) {
    const rank = voiceTier(v) === 2 ? prefIndex(v, VOICES.main.prefer) : Infinity;
    if (Number.isFinite(rank) && (!mainPref || rank < mainPref.rank)) mainPref = { v, rank };
  }
  const main = mainPref?.v ?? pick(voices, lang);
  const taken = new Set<string>(main ? [baseName(main)] : []);
  const m = VOICES.main;
  const out = { main: { voice: main, pitch: m.pitch, rate: m.rate, shared: false } } as Record<
    VoiceId,
    DeviceVoice<V>
  >;
  const rest = VOICE_IDS.filter((id) => id !== "main");
  const passes: ((v: V, id: VoiceId) => number | null)[] = [
    (v, id) => (voiceTier(v) === 2 ? finite(prefIndex(v, VOICES[id].prefer)) : null),
    (v) => (voiceTier(v) === 2 ? 0 : null),
    (v, id) => (voiceTier(v) === 1 ? finite(prefIndex(v, VOICES[id].prefer)) : null),
    (v) => (voiceTier(v) === 1 ? 0 : null),
  ];
  for (const pass of passes)
    for (const id of rest) {
      if (out[id]) continue;
      let best: { v: V; rank: number } | null = null;
      for (const v of pool) {
        if (taken.has(baseName(v))) continue;
        const rank = pass(v, id);
        if (rank !== null && (!best || rank < best.rank)) best = { v, rank };
      }
      if (best) {
        taken.add(baseName(best.v));
        out[id] = { voice: best.v, pitch: 1, rate: 1, shared: false };
      }
    }
  // Last resort: main's voice (or the default) at the voice's own pitch and speed.
  for (const id of rest)
    out[id] ??= { voice: main, pitch: VOICES[id].pitch, rate: VOICES[id].rate, shared: true };
  return out;
}

const finite = (n: number) => (Number.isFinite(n) ? n : null);

// ---- Cloud voices --------------------------------------------------------

/** What a voice id asks the cloud for in `lang` (a primary subtag or a locale). */
export function cloudVoice(id: VoiceId, lang: string): { speaker?: string; shift: number } {
  const base = norm(lang).split("-")[0]!;
  const spec = VOICES[id];
  const speaker = spec.cloud.aura?.[base];
  return speaker ? { speaker, shift: 1 } : { shift: spec.shift };
}

/** Every Aura-2 speaker the table uses, per language (the route accepts only these). */
export function auraSpeakers(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const id of VOICE_IDS)
    for (const [lang, s] of Object.entries(VOICES[id].cloud.aura ?? {}))
      (out[lang] ??= []).includes(s) || out[lang]!.push(s);
  return out;
}

// ---- A line's own voice --------------------------------------------------
//
// Besides the table's ids (main, calm, bright), one line may name the exact
// voice to read it in (`say --voice <id>`; docs/dev-debug-widget.md, "A
// line's own voice"). The ids, all data, checked by one strict parser:
//   device:<name>   a voice the device itself has (speechSynthesis), by name;
//                   read with speech even when the voice output is cloud
//   melo:<lang>     the cloud's one MeloTTS voice of that language
//   aura:<speaker>  a Workers AI Aura-2 speaker of the table (English, Spanish)
//   eleven:<id>     an ElevenLabs voice's public preview clip (its own words, not
//                   the line's): no key, no generation, played from ElevenLabs
//   google:<voice>  a Google Cloud TTS voice (cmn-TW-Wavenet-A), synthesized on
//                   the server (/api/voice/tts), paid from credits
//   azure:<voice>[/<locale>]  an Azure Speech voice, optionally reading in a
//                   secondary locale (zh-CN-XiaoxiaoDialectsNeural/nan-CN)
//   local:<name>    reserved for Mac-local engines (Kokoro, VOICEVOX); none yet
// google:/azure: are read only where the page has provider voices on
// (setCloudVoices: flag voice.cloud-voices); elsewhere, and whenever the
// server cannot voice them (no key, an error), the line's lane voice reads it.
// A voice this device cannot play falls back to the line's lane voice, as if
// none was named: never silence.

/** Languages the cloud's MeloTTS reads (lib/workers-ai.ts MELOTTS_LANGS). */
export const MELO_LANGS = ["en", "es", "fr", "zh", "ja", "ko"] as const;

/**
 * ElevenLabs voices whose preview clips ElevenLabs publishes for anyone to
 * hear: its premade voices (`GET /v1/voices` lists them with `preview_url`,
 * no key). Its community library (Lulu, Kaori, Pipi, Kano, Auri…) lists
 * voices and previews only to a signed-in account (checked 2026-11-07), so
 * none of those is here. Paid voices, not wired into Li: a line can only play
 * the preview, which says its own words.
 */
export type ElevenVoice = { id: string; name: string; lang: string; note: string; preview: string };
const EL = "https://storage.googleapis.com/eleven-public-prod/premade/voices/";
const eleven = (id: string, name: string, note: string, file: string): ElevenVoice => ({
  id,
  name,
  lang: "en",
  note,
  preview: `${EL}${id}/${file}.mp3`,
});
export const ELEVEN_PREVIEWS: readonly ElevenVoice[] = [
  eleven("cgSgspJ2msm6clMCkdW9", "Jessica", "playful, bright, cute", "56a97bf8-b69b-448f-846c-c3a11683d45a"),
  eleven("EXAVITQu4vr4xnSDxMaL", "Sarah", "young, reassuring", "01a3e33c-6e99-4ee7-8543-ff2216a32186"),
  eleven("hpp4J3VqNfWAUOO0d1Us", "Bella", "bright, warm", "dab0f5ba-3aa4-48a8-9fad-f138fea1126d"),
  eleven("XrExE9yKIg1WjnnlVkGX", "Matilda", "upbeat", "b930e18d-6b4d-466e-bab2-0ae97c6d8535"),
  eleven("Xb7hH8MSUJpSbSDYk0k2", "Alice", "clear, British", "d10f7534-11f6-41fe-a012-2de1e482d336"),
  eleven("pFZP5JQG7iQjIQuC4Bku", "Lily", "velvety, British", "89b68b35-b3dd-4348-a84a-a3c13a3c2b30"),
  eleven("SAz9YHcvj6GT2YYXdXww", "River", "relaxed, neutral", "e6c95f0b-2227-491a-b3d7-2249240decb7"),
];

/** Mac-local engines a `local:` id may name (Kokoro-82M catgirl TTS at /lianki-tts). */
export const LOCAL_ENGINES: readonly string[] = [
  "neko",
  "neko-moe",
  "neko-soft",
  // Little-child blends (kokoro-tts-server.py presets; owner, 2026-11-14 "小宝宝的声线").
  "baby",
  "baby-soft",
  "xiaoxiao",
  "xiaobei",
  "yunxi",
  "alpha",
  "heart",
  "bella",
];

/** A line's voice, parsed. */
export type LineVoice =
  | { kind: "table"; id: VoiceId }
  | { kind: "device"; name: string }
  | { kind: "melo"; lang: string }
  | { kind: "aura"; speaker: string; lang: string }
  | { kind: "eleven"; id: string; preview: string }
  | { kind: "local"; name: string }
  /** A Google Cloud TTS voice by name ("cmn-TW-Wavenet-A"); `lang` its locale (cmn-TW). */
  | { kind: "google"; id: string; name: string; lang: string }
  /**
   * An Azure Speech voice by name ("zh-CN-XiaoxiaoDialectsNeural"), its own
   * locale `voiceLang`, and an optional secondary `locale` it reads the text
   * in ("nan-CN"); `lang` is the one it reads in.
   */
  | {
      kind: "azure";
      id: string;
      name: string;
      voiceLang: string;
      locale?: string;
      lang: string;
    };

/** Google voice names: <lang>-<REGION>-<model>[-<variant>…] (cmn-TW-Wavenet-A, en-US-Chirp3-HD-Achernar). */
const GOOGLE_NAME = /^([a-z]{2,3}-[A-Z]{2})-[A-Za-z0-9]{1,24}(?:-[A-Za-z0-9]{1,24}){0,3}$/;
/** Azure voice names: <lang>-<REGION>-<Name>[:<model>] (zh-TW-HsiaoChenNeural, en-US-Ava:DragonHDLatestNeural). */
const AZURE_NAME = /^([a-z]{2,3}-[A-Z]{2})-[A-Za-z0-9]{2,40}(?::[A-Za-z0-9]{2,40})?$/;
/** A secondary locale: <lang>-<REGION> (nan-CN). */
const LOCALE = /^[a-z]{2,3}-[A-Z]{2}$/;
/** The provider kinds: their voices are synthesized on the server (/api/voice/tts). */
export const isProviderVoice = (
  v: LineVoice | undefined,
): v is Extract<LineVoice, { kind: "google" | "azure" }> =>
  v?.kind === "google" || v?.kind === "azure";

/** The longest voice id a line may carry. */
export const LINE_VOICE_MAX = 80;
/** A device voice's name: letters, digits, spaces and ()（）.-_'’ — no URL, no markup. */
const DEVICE_NAME = /^[\p{L}\p{N}][\p{L}\p{M}\p{N} ()（）._'’-]{0,63}$/u;

/**
 * A line's voice id → what it names, or why it is refused. Strict: an
 * unknown kind, speaker, language or ElevenLabs id is an error, never
 * guessed or dropped. A device name is only checked for its shape (each
 * device has its own voices); one the device lacks falls back when read.
 */
export function parseLineVoice(raw: unknown): LineVoice | { error: string } {
  if (typeof raw !== "string" || !raw || raw.length > LINE_VOICE_MAX)
    return { error: `a voice id is 1–${LINE_VOICE_MAX} chars` };
  if (isVoiceId(raw)) return { kind: "table", id: raw };
  const kinds = `${VOICE_IDS.join(", ")}, device:<name>, melo:<lang>, aura:<speaker>, eleven:<id>, google:<voice>, azure:<voice>[/<locale>] (local:<name> reserved)`;
  const m = /^([a-z]+):(.*)$/s.exec(raw);
  if (!m) return { error: `unknown voice ${raw}: one of ${kinds}` };
  const kind = m[1]!;
  const rest = m[2]!;
  if (kind === "device") {
    if (rest.trim() !== rest || !DEVICE_NAME.test(rest))
      return { error: `not a device voice name: ${JSON.stringify(rest)}` };
    return { kind: "device", name: rest };
  }
  if (kind === "melo") {
    if (!(MELO_LANGS as readonly string[]).includes(rest))
      return { error: `unknown melo language ${rest}: one of ${MELO_LANGS.join(", ")}` };
    return { kind: "melo", lang: rest };
  }
  if (kind === "aura") {
    const all = auraSpeakers();
    const lang = Object.keys(all).find((l) => all[l]!.includes(rest));
    if (!lang)
      return { error: `unknown aura speaker ${rest}: one of ${Object.values(all).flat().join(", ")}` };
    return { kind: "aura", speaker: rest, lang };
  }
  if (kind === "eleven") {
    const v = ELEVEN_PREVIEWS.find((e) => e.id === rest);
    if (!v)
      return {
        error: `unknown eleven voice ${rest}: one of ${ELEVEN_PREVIEWS.map((e) => `${e.id} (${e.name})`).join(", ")}`,
      };
    return { kind: "eleven", id: v.id, preview: v.preview };
  }
  if (kind === "google") {
    const m = GOOGLE_NAME.exec(rest);
    if (!m) return { error: `not a Google voice name: ${JSON.stringify(rest)} (e.g. cmn-TW-Wavenet-A)` };
    return { kind: "google", id: raw, name: rest, lang: m[1]! };
  }
  if (kind === "azure") {
    const [name = "", locale, extra] = rest.split("/");
    const m = AZURE_NAME.exec(name);
    if (!m || extra !== undefined || (locale !== undefined && !LOCALE.test(locale)))
      return {
        error: `not an Azure voice: ${JSON.stringify(rest)} (e.g. zh-TW-HsiaoChenNeural, zh-CN-XiaoxiaoDialectsNeural/nan-CN)`,
      };
    return {
      kind: "azure",
      id: raw,
      name,
      voiceLang: m[1]!,
      ...(locale ? { locale } : {}),
      lang: locale ?? m[1]!,
    };
  }
  if (kind === "local") {
    if (!(LOCAL_ENGINES as readonly string[]).includes(rest))
      return {
        error: LOCAL_ENGINES.length
          ? `unknown local voice ${rest}: one of ${LOCAL_ENGINES.join(", ")}`
          : "local:<name> is reserved for Mac-local engines; none is built yet",
      };
    return { kind: "local", name: rest };
  }
  return { error: `unknown voice ${raw}: one of ${kinds}` };
}

/** Provider voice ids listed by `eval.ts voices` (any name the provider has is taken). */
const PROVIDER_EXAMPLES: readonly (readonly [string, string, string])[] = [
  [
    "google:cmn-TW-Wavenet-A",
    "cmn-TW",
    "Google Cloud TTS, Taiwan Mandarin (any google:<voice name> works); server-side, paid from credits, needs voice.cloud-voices and the Google key",
  ],
  [
    "azure:zh-CN-XiaoxiaoDialectsNeural/nan-CN",
    "nan-CN",
    "Azure Speech, Southern Min (mainland accent; any azure:<voice>[/<locale>] works); server-side, paid from credits, needs voice.cloud-voices and the Azure key",
  ],
];

/** A voice id a line may carry: the table's or a typed one the parser takes. */
export const isLineVoiceId = (raw: unknown): raw is string => !("error" in parseLineVoice(raw));

/** A line's typed voice (not one of the table's ids), or undefined. */
export function lineVoiceOf(raw: unknown): Exclude<LineVoice, { kind: "table" }> | undefined {
  const r = parseLineVoice(raw);
  return "error" in r || r.kind === "table" ? undefined : r;
}

/**
 * The device voice a `device:<name>` names: the exact name, else the same
 * name in another case, else the same model ("Meijia" → "Meijia (Enhanced)",
 * best grade first). Undefined: this device does not have it.
 */
export function findDeviceVoice<V extends VoiceLike>(voices: readonly V[], name: string): V | undefined {
  const q = name.toLowerCase();
  const base = baseName({ lang: "", name });
  return (
    voices.find((v) => v.name === name) ??
    voices.find((v) => (v.name ?? "").toLowerCase() === q) ??
    voices.filter((v) => baseName(v) === base).sort((a, b) => grade(b) - grade(a))[0]
  );
}

/** The cloud and ElevenLabs voice ids a line may name (`eval.ts voices`). */
export function cloudVoiceIds(): { id: string; lang: string; note: string }[] {
  const out: { id: string; lang: string; note: string }[] = MELO_LANGS.map((l) => ({
    id: `melo:${l}`,
    lang: l,
    note: "MeloTTS: the cloud's one voice of the language",
  }));
  for (const [lang, speakers] of Object.entries(auraSpeakers()))
    for (const s of speakers) out.push({ id: `aura:${s}`, lang, note: "Workers AI Aura-2" });
  for (const e of ELEVEN_PREVIEWS)
    out.push({
      id: `eleven:${e.id}`,
      lang: e.lang,
      note: `ElevenLabs ${e.name} (${e.note}): its public preview clip only, in its own words; a paid voice, not wired into Li`,
    });
  // Provider voices: any of the provider's voice names; these two are the Taiwan pair.
  for (const [id, lang, note] of PROVIDER_EXAMPLES) out.push({ id, lang, note });
  return out;
}

/** A device's voices as `device:<name>` ids, its languages zh, ja, en first. */
export function deviceVoiceIds(
  voices: readonly VoiceLike[],
): { id: string; name: string; lang: string; tier: "natural" | "eloquence" | "novelty" }[] {
  const first = ["zh", "ja", "en"];
  const rank = (l: string) => {
    const i = first.indexOf(norm(l).split("-")[0]!);
    return i < 0 ? first.length : i;
  };
  return voices
    .filter((v) => typeof v.name === "string" && DEVICE_NAME.test(v.name))
    .map((v, i) => ({ v, i }))
    .sort(
      (a, b) =>
        rank(a.v.lang) - rank(b.v.lang) || norm(a.v.lang).localeCompare(norm(b.v.lang)) || a.i - b.i,
    )
    .map(({ v }) => ({
      id: `device:${v.name}`,
      name: v.name!,
      lang: v.lang,
      tier: (["novelty", "eloquence", "natural"] as const)[voiceTier(v)],
    }));
}

// ---- Provider voices on this page ------------------------------------------

type CloudVoices = { on: boolean; map: Readonly<Record<string, string>> };
type CloudStore = { __lkCloudVoices?: CloudVoices };

/**
 * Provider voices for this page, from the app (flag `voice.cloud-voices` and
 * the config `voice.langVoices`, a language → voice id map). Kept on
 * globalThis so a hot-loaded chat reads the same. Map entries that are not a
 * provider voice id are dropped.
 */
export function setCloudVoices(s: { on?: unknown; map?: unknown } | null | undefined): void {
  const map: Record<string, string> = {};
  if (s?.map && typeof s.map === "object" && !Array.isArray(s.map))
    for (const [lang, id] of Object.entries(s.map as Record<string, unknown>))
      if (typeof id === "string" && isProviderVoice(lineVoiceOf(id))) map[norm(lang)] = id;
  (globalThis as CloudStore).__lkCloudVoices = { on: s?.on === true, map };
}

/** Provider voices may be read on this page. */
export const cloudVoicesOn = () => (globalThis as CloudStore).__lkCloudVoices?.on === true;

/**
 * The provider voice the map names for `lang` (its locale, else its
 * language), or undefined; always undefined while provider voices are off.
 */
export function langVoice(lang: string): Extract<LineVoice, { kind: "google" | "azure" }> | undefined {
  const s = (globalThis as CloudStore).__lkCloudVoices;
  if (!s?.on) return undefined;
  const l = norm(lang);
  const id = s.map[l] ?? s.map[l.split("-")[0]!];
  const v = id ? lineVoiceOf(id) : undefined;
  return isProviderVoice(v) ? v : undefined;
}
