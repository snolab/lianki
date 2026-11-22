/**
 * Voices for other people's polished lines (owner, 2026-11-23: "你识别到不同的人的
 * 时候，我们应该已经用不同的头像了。所以呢声音你也就随机搭配几个不同的声音也就可以了"):
 * a line the hub verified as someone else (signed decision "other") with a
 * `cluster` or `voice` id, the same ids the per-voice avatars use, is read back
 * in a synthetic voice picked from a pool by that id, so one person always gets
 * the same voice. Never a clone of anyone, and never a voice an agent lane
 * reads in (VOICES, NEKO_ROTATION, the calm lane's yunxi, Aura, Melo, the
 * language map), so a person never sounds like an agent.
 *
 * The pool is config `voice.personVoices` (lib/config.ts), default
 * DEFAULT_PERSON_VOICES: single Kokoro voices on his Mac's local TTS server,
 * none of which a lane uses on its own. Pure; tested in unit/person-voice.test.ts.
 */
import { labelOrdinal } from "./cluster-avatar";
import { nameHash } from "./svg-avatar";
import { pinnedLocalVoice, NEKO_ROTATION } from "./voice-heard";
import {
  type LineVoice,
  MELO_LANGS,
  VOICE_IDS,
  auraSpeakers,
  isProviderVoice,
  langVoice,
  lineVoiceOf,
} from "./voices";
import { CLUSTER_ID, type SpeakerTag, VOICE_ID, verifiedDecision } from "./wire";

/** A voice a person may be read in: a Mac-local one, or a provider voice. */
export type PersonVoice = Extract<LineVoice, { kind: "local" | "google" | "azure" }>;

/** The pool's default: Kokoro voices no lane uses on its own (bella, heart: English; alpha: Japanese; xiaobei: Mandarin). */
export const DEFAULT_PERSON_VOICES: readonly string[] = [
  "local:bella",
  "local:heart",
  "local:alpha",
  "local:xiaobei",
];
/** The most voices the pool keeps. */
export const PERSON_VOICES_MAX = 16;

/**
 * Voices the agent lanes read in, whatever the config says: the table's ids,
 * every Aura speaker and Melo voice the table uses, the bright lane's Kokoro
 * rotation and the calm lane's Mandarin voice (voice-out.ts `wanted`).
 */
export function laneVoiceIds(): Set<string> {
  const out = new Set<string>(VOICE_IDS);
  for (const s of Object.values(auraSpeakers()).flat()) out.add(`aura:${s}`);
  for (const l of MELO_LANGS) out.add(`melo:${l}`);
  out.add("local:neko-cycle");
  out.add("local:yunxi");
  for (const n of NEKO_ROTATION) out.add(`local:${n}`);
  return out;
}

/** A pool entry: a local or provider voice id that is no lane's voice. */
export function isPersonVoiceId(id: unknown): id is string {
  if (typeof id !== "string") return false;
  const v = lineVoiceOf(id);
  if (!v || (v.kind !== "local" && !isProviderVoice(v))) return false;
  return !laneVoiceIds().has(id);
}

/** The pool from a config value: valid entries only, each once, at most PERSON_VOICES_MAX. */
export function cleanPersonVoices(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [...DEFAULT_PERSON_VOICES];
  return [...new Set(raw.filter(isPersonVoiceId))].slice(0, PERSON_VOICES_MAX);
}

/**
 * Who another voice line is, for its voice: the verified tag must say "other";
 * then its cluster ("A", "household:<name>"), else its voice id ("s1"), as the
 * avatars read them. Undefined for him, an unknown voice, our own echo, an
 * unsigned tag or one with neither id.
 */
export function personOf(s: SpeakerTag | undefined): string | undefined {
  if (verifiedDecision(s) !== "other") return undefined;
  if (s!.cluster && CLUSTER_ID.test(s!.cluster)) return s!.cluster;
  if (s!.voice && s!.voice !== "me" && VOICE_ID.test(s!.voice)) return s!.voice;
  return undefined;
}

/** A person's place in the pool: as the avatars count (cluster letters in order, "s<n>" by n, a household by its name's hash). */
export function personIndex(id: string): number {
  if (/^[A-Z]{1,3}$/.test(id)) return labelOrdinal(id) - 1;
  const s = /^s([1-9]\d*)$/.exec(id);
  if (s) return Number(s[1]) - 1;
  return nameHash(id);
}

/**
 * The voice a person is read in, from `pool`, or undefined (an empty pool).
 * Voices a lane reads in on this page right now (the device's pinned Kokoro
 * voice, the language map's provider voices) are left out first.
 */
export function personVoice(
  id: string,
  pool: readonly string[],
  lang?: string,
  busy: ReadonlySet<string> = liveLaneVoices(lang),
): PersonVoice | undefined {
  const free = pool.filter((v) => isPersonVoiceId(v) && !busy.has(v));
  if (!free.length) return undefined;
  const v = lineVoiceOf(free[personIndex(id) % free.length]!);
  return v && (v.kind === "local" || isProviderVoice(v)) ? v : undefined;
}

/** The lane voices that depend on this page: the pinned Kokoro voice and the map's voice for `lang`. */
function liveLaneVoices(lang?: string): Set<string> {
  const out = new Set<string>();
  const pin = pinnedLocalVoice();
  if (pin) out.add(`local:${pin}`);
  const lv = lang ? langVoice(lang) : undefined;
  if (lv) out.add(lv.id);
  return out;
}
