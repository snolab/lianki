/**
 * The swipe's feel as runtime tokens (docs/swipe-core.md): every number the
 * physics and the cues read, in one object, with two presets.
 *
 * - "light" is the swipe as it shipped: no lag, no coast, the critically
 *   damped return at ω = 30 (SWIPE_SPRING), the linear stretch past Easy /
 *   Again. Everyone is on it.
 * - "heavy" adds mass and friction: the slip trails the finger a little,
 *   eases into a rubber band past the last level, coasts on after a fling
 *   and slows, then comes home on a heavier spring with a trace of bounce.
 *
 * Neither changes a threshold or a grade: those stay in lib/words/swipe.ts.
 *
 * Which preset a device uses, and any per-token tweak on top, is a
 * device-local preference (`lk:swipe-feel`), turned on from /words Settings
 * in debug mode; `?feel=heavy|light` overrides it for one page load.
 */
import { SWIPE_SNAP, SWIPE_SPRING, SWIPE_STRETCH } from "./swipe";

export type SwipeFeel = {
  /** Release spring. ω₀ = √(stiffness/mass), ζ = damping / 2√(stiffness·mass). */
  mass: number;
  stiffness: number;
  damping: number;
  /** The slip trails the finger on a critically damped spring of this ω (rad/s); 0 = no lag. */
  followOmega: number;
  /** How strongly a level holds while dragging (0..0.95). */
  snap: number;
  /** Past the last level: the share of the finger followed, linear (rubberBand 0)… */
  stretch: number;
  /** …or a rubber band of this stiffness (smaller = heavier), easing into the stop. */
  rubberBand: number;
  /** The share of the release velocity that coasts on, 0..1. */
  flingCarry: number;
  /** Friction on the coast, 1/s: higher stops sooner. */
  friction: number;
  /** The fastest coast, px/s. */
  maxFling: number;
  /** Tilt while sliding, degrees per px of travel. */
  rotatePerPx: number;
  /** Lift on press: the shadow's strength, 0 (none) … 1. */
  lift: number;
  /** How long the lift takes to rise and fall, ms. */
  liftMs: number;
  /** New swipe (native scrolling): the release is the spring above, not the browser's snap. */
  nativeRelease: boolean;
};

export type FeelPreset = "light" | "heavy";

export const FEEL_PRESETS: Record<FeelPreset, SwipeFeel> = {
  light: {
    mass: 1,
    stiffness: SWIPE_SPRING * SWIPE_SPRING,
    damping: 2 * SWIPE_SPRING,
    followOmega: 0,
    snap: SWIPE_SNAP,
    stretch: SWIPE_STRETCH,
    rubberBand: 0,
    flingCarry: 0,
    friction: 0,
    maxFling: 0,
    rotatePerPx: 0,
    lift: 0,
    liftMs: 0,
    nativeRelease: false,
  },
  heavy: {
    // ω₀ ≈ 16.5 rad/s, ζ ≈ 0.88: about half the light spring's pace, one faint overshoot.
    mass: 2.2,
    stiffness: 600,
    damping: 64,
    // The slip lags the finger by ~2/ω ≈ 55 ms: it has mass, but stays under it.
    followOmega: 36,
    snap: SWIPE_SNAP,
    stretch: SWIPE_STRETCH,
    rubberBand: 0.45,
    flingCarry: 0.55,
    friction: 7,
    maxFling: 2200,
    rotatePerPx: 0.012,
    lift: 1,
    liftMs: 140,
    nativeRelease: true,
  },
};

/** Each token's range, for the tuner and for checking stored values. */
export const FEEL_RANGES: {
  [K in keyof SwipeFeel]: SwipeFeel[K] extends boolean ? null : [number, number, number];
} = {
  mass: [0.2, 6, 0.1],
  stiffness: [50, 2000, 10],
  damping: [2, 160, 1],
  followOmega: [0, 80, 1],
  snap: [0, 0.95, 0.01],
  stretch: [0, 1, 0.01],
  rubberBand: [0, 1.5, 0.01],
  flingCarry: [0, 1, 0.01],
  friction: [0, 30, 0.5],
  maxFling: [0, 6000, 50],
  rotatePerPx: [0, 0.08, 0.001],
  lift: [0, 1, 0.05],
  liftMs: [0, 400, 10],
  nativeRelease: null,
};

export const FEEL_KEYS = Object.keys(FEEL_RANGES) as (keyof SwipeFeel)[];

export type FeelTweaks = Partial<SwipeFeel>;

/** The device preference: which preset, what tweaks on top, the tuner open or not. */
export type FeelPrefs = { preset: FeelPreset; tweaks: FeelTweaks; tune: boolean };

export const FEEL_PREFS_KEY = "lk:swipe-feel";
export const DEFAULT_PREFS: FeelPrefs = { preset: "light", tweaks: {}, tune: false };

/** Only known tokens, in range; anything else is dropped. Never throws. */
export function cleanTweaks(raw: unknown): FeelTweaks {
  const out: FeelTweaks = {};
  if (!raw || typeof raw !== "object") return out;
  for (const k of FEEL_KEYS) {
    const v = (raw as Record<string, unknown>)[k];
    const r = FEEL_RANGES[k];
    if (r === null) {
      if (typeof v === "boolean") (out as Record<string, unknown>)[k] = v;
    } else if (typeof v === "number" && Number.isFinite(v)) {
      (out as Record<string, unknown>)[k] = Math.max(r[0], Math.min(r[1], v));
    }
  }
  return out;
}

/** The stored preference, from its JSON; a bad or missing value reads as the default. */
export function parsePrefs(raw: string | null | undefined): FeelPrefs {
  if (!raw) return DEFAULT_PREFS;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    return {
      preset: v.preset === "heavy" ? "heavy" : "light",
      tweaks: cleanTweaks(v.tweaks),
      tune: v.tune === true,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

/** The page-load-only `?feel=` override, or null. */
export function feelOverride(query: string): FeelPreset | null {
  const v = new URLSearchParams(query).get("feel");
  return v === "heavy" || v === "light" ? v : null;
}

/**
 * The tokens in force: the preset, then what a feel island publishes for it
 * (a hot-swapped tuning from the dev machine), then this device's tweaks.
 */
export function resolveFeel(
  prefs: FeelPrefs,
  published: Partial<Record<FeelPreset, FeelTweaks>> = {},
  override: FeelPreset | null = null,
): SwipeFeel {
  const preset = override ?? prefs.preset;
  return {
    ...FEEL_PRESETS[preset],
    ...cleanTweaks(published[preset]),
    ...cleanTweaks(prefs.tweaks),
  };
}

/** The telemetry tag for a feel: nothing on the light preset untweaked, so old rows compare. */
export function feelTag(preset: FeelPreset, tweaks: FeelTweaks): string {
  const n = Object.keys(tweaks).length;
  return preset === "light" && !n ? "" : `feel=${preset}${n ? "+" + n : ""}`;
}
