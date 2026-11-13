/**
 * The avatar of another voice on the owner's voice lines (docs/voice-mode.md,
 * "Speaker avatars"): the local STT server tags a final that is not him with
 * a stable id per voice heard lately ("s1", "s2"…; SpeakerTag.voice). This
 * draws that id as a disc with a glyph, both from its hash, so the same voice
 * gets the same picture on every page and device, and two voices get two.
 * Pure (no React): LaneMark.tsx voiceAvatar renders it, the unit tests read it.
 */
import { AUTO_GLYPHS, nameHash } from "./svg-avatar";
import type { LaneMark } from "./voices";

/**
 * The hues a voice can get: the seal red first (the theme, used boldly:
 * docs/design-principles.md), then round the wheel, far enough apart to tell
 * at 18 px. Mid lightness, so each reads on the light and the dark log.
 */
export const VOICE_HUES: readonly number[] = [22.3, 60, 100, 145, 190, 235, 275, 320];
const VOICE_L = 0.58;
const VOICE_C = 0.15;

export type SpeakerAvatar = LaneMark & {
  /** The hue picked, degrees. */
  hue: number;
  /** Which of AUTO_GLYPHS, for a test or a legend. */
  glyph: number;
};

/**
 * The same id, the same disc and glyph, everywhere. The server's ids are
 * ordinal ("s1", "s2"…), so the first eight voices get eight different hues
 * (s1 the seal red) and the glyph turns with them: two people talking are
 * never the same colour. Any other id falls back to its hash.
 */
export function speakerAvatar(id: string): SpeakerAvatar {
  const m = /^s([1-9]\d*)$/.exec(id);
  const h = m ? Number(m[1]) - 1 : nameHash(`voice:${id}`);
  const hue = VOICE_HUES[h % VOICE_HUES.length]!;
  // 8 hues and 9 glyphs: 72 voices before a pair repeats.
  const glyph = h % AUTO_GLYPHS.length;
  return {
    hue,
    glyph,
    bg: `oklch(${VOICE_L} ${VOICE_C} ${hue})`,
    fg: `oklch(0.98 0.02 ${hue})`,
    paths: AUTO_GLYPHS[glyph]!,
  };
}
