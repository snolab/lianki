"use client";

/**
 * Island `words.swipeTuner` (docs/swipe-core.md): a glass panel over /words
 * for tuning the swipe's feel on the phone itself — preset, then any token.
 * Shown only while this device's feel preference has `tune` on (/words
 * Settings → Experimental, in debug mode). Tweaks are this device's, kept in
 * localStorage; they apply to the next swipe, and survive hot swaps and
 * reloads.
 */
import { useState } from "react";
import { useSwipeFeel } from "@/lib/words/swipe-core";
import { FEEL_KEYS, FEEL_RANGES, type FeelPreset, type SwipeFeel } from "@/lib/words/swipe-feel";
import { dampingRatio } from "@/lib/words/swipe-physics";

const EXPECTS = 1;

const LABELS: { [K in keyof SwipeFeel]: string } = {
  mass: "mass",
  stiffness: "stiffness",
  damping: "damping",
  followOmega: "drag lag ω (0 = none)",
  snap: "level hold",
  stretch: "stretch past Easy/Again",
  rubberBand: "rubber band (0 = linear)",
  flingCarry: "fling carry",
  friction: "fling friction /s",
  maxFling: "max fling px/s",
  lift: "lift shadow",
  liftMs: "lift ms",
  nativeRelease: "New swipe: spring release",
};

export function SwipeTuner() {
  const { feel, preset, overridden, prefs, setPrefs } = useSwipeFeel(EXPECTS);
  const [open, setOpen] = useState(true);
  if (!prefs.tune) return null;
  const tweak = (k: keyof SwipeFeel, v: number | boolean) =>
    setPrefs({ ...prefs, tweaks: { ...prefs.tweaks, [k]: v } });
  const pick = (p: FeelPreset) => setPrefs({ ...prefs, preset: p, tweaks: {} });
  const zeta = dampingRatio(feel);
  const glass =
    "border border-[oklch(0.5_0.02_70/0.25)] bg-[oklch(from_var(--background)_l_c_h/0.72)] backdrop-blur-[12px] backdrop-saturate-[1.4] shadow-[0_8px_30px_oklch(0_0_0/0.25)]";
  return (
    <div
      data-swipe-tuner
      role="region"
      aria-label="Swipe feel tuner"
      className={`fixed inset-x-2 z-40 mx-auto max-w-md rounded-2xl px-3 py-2 text-xs ${glass}`}
      style={{ bottom: "calc(4.5rem + env(safe-area-inset-bottom))" }}
    >
      <div className="flex items-center gap-2">
        <b className="font-semibold">Swipe feel</b>
        {(["light", "heavy"] as const).map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => pick(p)}
            aria-pressed={preset === p}
            className={`min-h-10 rounded-full px-3 ${preset === p ? "bg-[oklch(0.55_0.12_60/0.3)] font-semibold" : "opacity-70"}`}
          >
            {p}
          </button>
        ))}
        <span className="tabular-nums opacity-60">ζ {zeta.toFixed(2)}</span>
        <button
          type="button"
          className="ml-auto min-h-10 min-w-10 rounded-full opacity-70"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
        >
          {open ? "▾" : "▴"}
        </button>
        <button
          type="button"
          className="min-h-10 min-w-10 rounded-full opacity-70"
          aria-label="Close the tuner"
          onClick={() => setPrefs({ ...prefs, tune: false })}
        >
          ✕
        </button>
      </div>
      {overridden && <div className="opacity-60">?feel= decides the preset on this page load.</div>}
      {open && (
        <div className="mt-1 max-h-[40vh] space-y-1 overflow-y-auto pb-1">
          {FEEL_KEYS.map((k) => {
            const r = FEEL_RANGES[k];
            const v = feel[k];
            const tweaked = k in prefs.tweaks;
            if (r === null)
              return (
                <label key={k} className="flex min-h-10 items-center gap-2">
                  <input
                    type="checkbox"
                    checked={v as boolean}
                    onChange={(e) => tweak(k, e.target.checked)}
                  />
                  <span className={tweaked ? "font-semibold" : ""}>{LABELS[k]}</span>
                </label>
              );
            return (
              <label key={k} className="grid grid-cols-[8.5rem_1fr_3.2rem] items-center gap-2">
                <span className={`truncate ${tweaked ? "font-semibold" : "opacity-80"}`}>
                  {LABELS[k]}
                </span>
                <input
                  type="range"
                  min={r[0]}
                  max={r[1]}
                  step={r[2]}
                  value={v as number}
                  onChange={(e) => tweak(k, Number(e.target.value))}
                  className="h-8 w-full"
                />
                <span className="text-right tabular-nums">{+(v as number).toFixed(3)}</span>
              </label>
            );
          })}
          <button
            type="button"
            className="mt-1 min-h-10 w-full rounded-xl bg-[oklch(0.5_0.02_70/0.15)]"
            onClick={() => setPrefs({ ...prefs, tweaks: {} })}
          >
            Reset to {preset}
          </button>
        </div>
      )}
    </div>
  );
}
