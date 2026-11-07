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
 * Elsewhere the cloud has one voice (MeloTTS), so the clip is played shifted
 * (`shift`: pitch and speed together) as the last resort.
 *
 * Pure: unit/voices.test.ts.
 */

/** A lane: who is talking in the owner's chat. */
export const LANE_IDS = ["main", "codex", "agy"] as const;
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
   * clip plays at this speed with its pitch moving with it (1 = as is).
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
    shift: 1.06,
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
    name: "codex",
    voice: "calm",
    aliases: ["codex"],
    // Two slow waves: calm, low.
    mark: {
      bg: "oklch(0.5 0.13 255)",
      fg: "oklch(0.97 0.02 255)",
      paths: [{ d: "M5 10c2.3-2 4.7-2 7 0s4.7 2 7 0" }, { d: "M5 15c2.3-2 4.7-2 7 0s4.7 2 7 0" }],
    },
  },
  agy: {
    name: "agy",
    voice: "bright",
    aliases: ["agy", "antigravity"],
    // A four-point spark: bright, high.
    mark: {
      bg: "oklch(0.8 0.14 80)",
      fg: "oklch(0.3 0.08 60)",
      paths: [{ d: "M12 4l1.9 6.1L20 12l-6.1 1.9L12 20l-1.9-6.1L4 12l6.1-1.9Z", fill: true }],
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
