/**
 * One avatar per voice in the room (owner, 2026-11-19 ~15:0x JST: "你应该给所有
 * 不同的人的声线都给弄一个不同的头像"; docs/voice-mode.md, "Speaker clusters").
 * The Mac's speaker check names every final that is not his with a cluster
 * label (SpeakerTag.cluster: "A", "B"… per voice heard today, or
 * "household:<name>" for a household print; scripts/local-stt/voiceprint.py
 * Verifier.cluster). This draws that label as a disc: a letter for a cluster,
 * a house for a household voice, the colour from the label (an oklch palette,
 * config `voice.clusterHues`, never the seal red: that is his). Pure (no
 * React): LaneMark.tsx clusterAvatar renders it, the unit tests read it.
 */
import { nameHash } from "./svg-avatar";
import { CLUSTER_ID } from "./wire";

export { CLUSTER_ID };

/** Flag (lib/flags.ts): a voice line's cluster gets its own avatar while it is on. */
export const SPEAKER_AVATARS_FLAG = "voice.speaker-avatars";

/**
 * Default of config `voice.clusterHues`: oklch hues round the wheel, far enough
 * apart to tell at 18 px, none near the seal red (hue ~22–30, reserved for him).
 */
export const CLUSTER_HUES: readonly number[] = [70, 110, 150, 185, 220, 255, 290, 325];
/** Default of config `voice.clusterMinScore`: 0 = every cluster label is drawn. */
export const CLUSTER_MIN_SCORE = 0;
/** The seal red's hue (theme), and how near a palette hue may come to it. */
const SEAL_HUE = 25;
const SEAL_GAP = 20;
const L = 0.6;
const C = 0.14;

const live = { on: true, hues: CLUSTER_HUES, minScore: CLUSTER_MIN_SCORE };

const nearSeal = (h: number) => {
  const d = Math.abs((((h - SEAL_HUE) % 360) + 540) % 360 - 180);
  return d < SEAL_GAP;
};

/** A palette from config: finite hues 0–360, away from the seal red; else the default. */
export function cleanHues(v: unknown): readonly number[] {
  if (!Array.isArray(v)) return CLUSTER_HUES;
  const out = v.filter(
    (h): h is number => typeof h === "number" && Number.isFinite(h) && h >= 0 && h <= 360 && !nearSeal(h),
  );
  return out.length ? out.slice(0, 24) : CLUSTER_HUES;
}

/**
 * The live switches (DebugEval: flag `voice.speaker-avatars`, config
 * `voice.clusterHues`, `voice.clusterMinScore`). Anything malformed keeps its default.
 */
export function setSpeakerAvatars(opts: { on?: unknown; hues?: unknown; minScore?: unknown }) {
  live.on = opts.on !== false;
  live.hues = cleanHues(opts.hues);
  const m = opts.minScore;
  live.minScore = typeof m === "number" && Number.isFinite(m) && m >= 0 && m <= 1 ? m : CLUSTER_MIN_SCORE;
}

/** Whether a line's cluster is drawn now: the flag on, a valid label, its score not under the line. */
export function clusterShown(cluster: unknown, score?: unknown): cluster is string {
  if (!live.on || typeof cluster !== "string" || !CLUSTER_ID.test(cluster)) return false;
  return !(typeof score === "number" && score < live.minScore);
}

export const isHousehold = (cluster: string) => cluster.startsWith("household:");

/** 1-based ordinal of a letter label: "A" 1, "Z" 26, "AA" 27 (as the server counts). */
export function labelOrdinal(label: string): number {
  let n = 0;
  for (const ch of label) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

export type ClusterAvatar = {
  kind: "letter" | "household";
  /** The letter drawn ("A"), or "" on a household voice (its house). */
  letter: string;
  hue: number;
  bg: string;
  fg: string;
};

/**
 * The same label, the same disc, everywhere. Letters are ordinal, so the first
 * clusters of a day take the palette in order (two people talking are never one
 * colour); a household voice takes its colour from its name's hash.
 */
export function clusterAvatar(cluster: string): ClusterAvatar {
  const hues = live.hues;
  const house = isHousehold(cluster);
  const i = house ? nameHash(cluster) : labelOrdinal(cluster) - 1;
  const hue = hues[((i % hues.length) + hues.length) % hues.length]!;
  return {
    kind: house ? "household" : "letter",
    letter: house ? "" : cluster,
    hue,
    bg: `oklch(${L} ${C} ${hue})`,
    fg: `oklch(0.98 0.02 ${hue})`,
  };
}

/** A house (24×24), drawn on a household voice's disc. */
export const HOUSE_PATH = "M5.5 11.5L12 6l6.5 5.5V18h-4.5v-4h-4v4H5.5Z";

/** The avatar's name (tooltip, screen reader): "Voice A", or the household words. */
export function clusterName(cluster: string, words: { voice?: string; household?: string }): string {
  if (isHousehold(cluster)) return words.household || "Household voice";
  return (words.voice || "Voice {label}").replaceAll("{label}", cluster);
}
