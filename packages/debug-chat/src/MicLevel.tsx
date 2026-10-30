"use client";

import { useEffect, useRef, useState } from "react";
import { voiceAdapt } from "./adaptive";

/**
 * The owner's live mic level under the mic button (owner, 2026-10-31): two
 * hairline bars, drawn from what the VAD already hears (adaptive.ts `live`,
 * no extra capture), on this device only — nothing is uploaded.
 *
 * - The level: the frame's dBFS after the gain (smoothed, fast up, slow
 *   down), a peak tick that falls back slowly, and a tick at the room's
 *   noise floor. Coloured by the band: whisper, normal or noisy.
 * - Speech: Silero's probability, with a tick at the VAD's start threshold,
 *   so a whisper that clears it shows at a glance.
 *
 * Drawn with requestAnimationFrame, at most every FRAME_MS, by transforms
 * only (no reflow); with reduced motion, every STATIC_MS with no smoothing.
 * Shown while the mic is on and lk:voice-meter is not "0" (the /words
 * settings' "Show mic level"; METER_EVENT announces a change).
 */
import {
  BAND_INK,
  type Band,
  FRAME_MS,
  METER_EVENT,
  MIN_DB,
  STATIC_MS,
  bandOf,
  dbFrac,
  meterOn,
  meterStep,
} from "./mic-level";

const reduced = () =>
  document.documentElement.dataset.motion === "off" ||
  matchMedia("(prefers-reduced-motion: reduce)").matches;

export function MicLevel({ active }: { active: boolean }) {
  const [on, setOn] = useState(meterOn);
  const [band, setBand] = useState<Band>("normal");
  const level = useRef<HTMLSpanElement | null>(null);
  const peak = useRef<HTMLSpanElement | null>(null);
  const floor = useRef<HTMLSpanElement | null>(null);
  const prob = useRef<HTMLSpanElement | null>(null);
  const thresh = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    const f = () => setOn(meterOn());
    window.addEventListener(METER_EVENT, f);
    window.addEventListener("storage", f);
    return () => {
      window.removeEventListener(METER_EVENT, f);
      window.removeEventListener("storage", f);
    };
  }, []);
  useEffect(() => {
    if (!active || !on) return;
    const a = voiceAdapt();
    let raf = 0;
    let last = 0;
    let m = { level: MIN_DB, peak: MIN_DB };
    let shownBand: Band | null = null;
    const draw = (t: number) => {
      raf = requestAnimationFrame(draw);
      const still = reduced();
      const dt = t - last;
      if (dt < (still ? STATIC_MS : FRAME_MS)) return;
      last = t;
      const live = (a as { live?: () => { db: number; prob: number; at: number } }).live?.();
      const s = a.state();
      // A stale frame (the VAD paused, the agent speaking): the bar rests.
      const db = live && Date.now() - live.at < 500 ? live.db : MIN_DB;
      m = meterStep(m, db, dt, !still);
      const x = (v: number) => `scaleX(${v})`;
      const at = (v: number) => `translateX(${Math.round(v * 40)}px)`;
      if (level.current) level.current.style.transform = x(dbFrac(m.level));
      if (peak.current) peak.current.style.transform = at(dbFrac(m.peak));
      if (floor.current) floor.current.style.transform = at(dbFrac(s.floorDb + s.gainDb));
      if (prob.current) prob.current.style.transform = x(live && db > MIN_DB ? live.prob : 0);
      if (thresh.current) thresh.current.style.transform = at(s.positiveSpeechThreshold);
      const b = bandOf(s);
      if (b !== shownBand) {
        shownBand = b;
        setBand(b);
      }
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [active, on]);
  if (!active || !on) return null;
  const tick = (ref: React.RefObject<HTMLSpanElement | null>, h: number, ink: string) => (
    <span
      ref={ref}
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        width: 1,
        height: h,
        background: ink,
        transform: "translateX(0px)",
        willChange: "transform",
      }}
    />
  );
  const bar = (ref: React.RefObject<HTMLSpanElement | null>, top: number, ink: string) => (
    <span
      ref={ref}
      style={{
        position: "absolute",
        left: 0,
        top,
        width: 40,
        height: 2,
        borderRadius: 1,
        background: ink,
        transform: "scaleX(0)",
        transformOrigin: "left",
        willChange: "transform",
      }}
    />
  );
  return (
    <span
      aria-hidden
      data-testid="debug-chat-mic-level"
      data-band={band}
      title={band}
      style={{
        position: "absolute",
        left: "50%",
        bottom: -3,
        width: 40,
        height: 5,
        marginLeft: -20,
        pointerEvents: "none",
      }}
    >
      {/* The tracks. */}
      <span
        style={{
          position: "absolute",
          inset: 0,
          background: "oklch(0.6 0 0 / 0.18)",
          borderRadius: 1,
        }}
      />
      {bar(level, 0, BAND_INK[band])}
      {tick(peak, 2, BAND_INK[band])}
      {tick(floor, 2, "oklch(0.55 0 0)")}
      {bar(prob, 3, "oklch(0.6 0.12 250)")}
      {tick(thresh, 5, "oklch(0.5 0.2 25)")}
    </span>
  );
}
