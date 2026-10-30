/**
 * The mic meter's arithmetic (MicLevel.tsx draws it): the scale, the
 * smoothing, the band, and whether it is on.
 */
import { POLICY } from "./adaptive";

export const METER_KEY = "lk:voice-meter";
export const METER_EVENT = "lk:voice-meter";
export const MIN_DB = -70;
export const FRAME_MS = 50;
export const STATIC_MS = 250;
/** dB per second the peak tick falls back. */
export const PEAK_FALL_DB_S = 20;

export type Band = "whisper" | "normal" | "noisy";
export const BAND_INK: Record<Band, string> = {
  whisper: "oklch(0.62 0.15 300)",
  normal: "oklch(0.64 0.15 150)",
  noisy: "oklch(0.68 0.16 60)",
};

/** dBFS as a share of the bar. */
export const dbFrac = (db: number) => Math.min(1, Math.max(0, (db - MIN_DB) / -MIN_DB));

/** One step of the meter: smoothed level (fast up, slow down) and a falling peak. */
export function meterStep(
  m: { level: number; peak: number },
  db: number,
  dtMs: number,
  smooth = true,
): { level: number; peak: number } {
  if (!smooth) return { level: db, peak: db };
  const k = db > m.level ? 0.6 : 0.15;
  const level = m.level + (db - m.level) * k;
  const peak = Math.max(level, m.peak - (PEAK_FALL_DB_S * dtMs) / 1000);
  return { level, peak };
}

/** The band: whisper while its settings are in force, noisy over the policy's noisy floor. */
export function bandOf(s: { whisper: boolean; floorDb: number }): Band {
  return s.whisper ? "whisper" : s.floorDb > POLICY.NOISY_FLOOR ? "noisy" : "normal";
}

export function meterOn(): boolean {
  try {
    return globalThis.localStorage?.getItem(METER_KEY) !== "0";
  } catch {
    return true;
  }
}

