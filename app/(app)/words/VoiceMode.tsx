"use client";

/**
 * The /words voice mode's UI (docs/voice-mode.md): the mic hookup while it
 * is on, the glass badge over the bottom of the list, and the short
 * confirmation after each spoken command. What a command does is the study
 * view's (lib/words/voice-dispatch.ts); this file only listens and shows.
 */
import { useEffect, useRef, useState } from "react";
import { useIntlayer } from "next-intlayer";
import type { VoiceOutcome } from "@/lib/words/voice-dispatch";
import { keepsTranscript } from "@/lib/words/voice-dispatch";
import type { VoiceEar, VoiceEarState } from "@/lib/words/voice-mic";

/** How long a confirmation stays up. */
const FLASH_MS = 1800;

export type VoiceFlash = { outcome: VoiceOutcome; at: number };

/**
 * Listen while `on`: each final transcript goes to `handle` (the study
 * view's dispatcher). `retry` restarts after a failure (from a tap: the
 * gesture a mic may need).
 */
export function useVoiceMode(on: boolean, handle: (text: string) => VoiceOutcome) {
  const [state, setState] = useState<VoiceEarState | "off">("off");
  const [flash, setFlash] = useState<VoiceFlash | null>(null);
  const handleRef = useRef(handle);
  handleRef.current = handle;
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!on) return void setState("off");
    let ear: VoiceEar | null = null;
    let alive = true;
    void import("@/lib/words/voice-mic")
      .then(({ startVoiceEar }) =>
        // Turned off while the module loaded: never start the mic.
        !alive
          ? null
          : startVoiceEar({
              onState: (s) => alive && setState(s),
              onText: (text) => {
                // Turned off while the mic was still starting: act on nothing, pass it on.
                if (!alive) return false;
                const outcome = handleRef.current(text);
                if (outcome.kind !== "agent") setFlash({ outcome, at: Date.now() });
                return keepsTranscript(outcome);
              },
            }),
      )
      .then((e) => {
        if (!e) return;
        if (alive) ear = e;
        else void e.stop();
      })
      .catch(() => alive && setState("failed"));
    return () => {
      alive = false;
      void ear?.stop();
    };
  }, [on, attempt]);
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), FLASH_MS);
    return () => clearTimeout(t);
  }, [flash]);
  return { state, flash, retry: () => setAttempt((n) => n + 1) };
}

/**
 * The badge: "Voice commands on" (or the mic's failure, tap to retry), what
 * to say, and the last command's confirmation. Glass over the list, above
 * the help strip (docs/design-principles.md); a live region, so a screen
 * reader hears each confirmation.
 */
export function VoiceBadge({
  state,
  flash,
  label,
  retry,
  bottom,
}: {
  state: VoiceEarState | "off";
  flash: VoiceFlash | null;
  /** The command's own words (grade names from the words page). */
  label: (o: VoiceOutcome) => string;
  retry: () => void;
  /** What the help strip covers at the bottom, px. */
  bottom: number;
}) {
  const text = useIntlayer("words-voice-mode");
  if (state === "off") return null;
  const failed = state === "failed";
  const ok = flash?.outcome.kind === "done";
  return (
    <div
      data-voice-mode={state}
      className="pointer-events-none fixed inset-x-0 z-30 flex flex-col items-center gap-1 px-4"
      style={{ bottom: `calc(${bottom + 8}px + env(safe-area-inset-bottom, 0px))` }}
    >
      <div
        role="status"
        aria-live="polite"
        data-voice-flash={flash?.outcome.kind}
        className="lk-glass rounded-full border border-[var(--glass-line)] px-3 py-1 text-sm lk-halo transition-opacity"
        style={{
          opacity: flash ? 1 : 0,
          color: ok ? "oklch(0.45 0.13 155)" : "oklch(0.5 0.12 60)",
        }}
      >
        {flash ? `${ok ? "✓ " : ""}${label(flash.outcome)}` : ""}
      </div>
      <button
        type="button"
        onClick={failed ? retry : undefined}
        aria-disabled={!failed}
        className={`lk-glass min-h-10 rounded-full border border-[var(--glass-line)] px-3 py-1 text-xs lk-halo ${
          failed ? "pointer-events-auto" : ""
        }`}
        style={{ color: failed ? "oklch(0.55 0.17 30)" : undefined }}
      >
        <span
          aria-hidden
          className="me-1.5 inline-block h-2 w-2 rounded-full align-middle"
          style={{
            background:
              state === "listening"
                ? "oklch(0.65 0.17 150)"
                : state === "starting"
                  ? "oklch(0.75 0.15 80)"
                  : "oklch(0.6 0.2 30)",
          }}
        />
        {failed ? text.micFailed : text.listening}
      </button>
      {!failed && (
        <div className="max-w-md text-center text-[11px] leading-snug opacity-70 lk-halo">
          {text.sayHint}
        </div>
      )}
    </div>
  );
}
