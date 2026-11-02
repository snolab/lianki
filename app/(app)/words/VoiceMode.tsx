"use client";

/**
 * The voice commands' UI (docs/voice-mode.md): the mic hookup while they are
 * on, the glass badge over the bottom of the screen, and the short
 * confirmation after each spoken command. Any screen can use it (/words,
 * /review): what a command does is that screen's (lib/words/voice-dispatch.ts
 * `handleUtterance` with its own actions); this file only listens and shows.
 * A strict command stays out of the chat; every other line goes to it.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useIntlayer } from "next-intlayer";
import { notePrefWrite, PREF_APPLIED_EVENT } from "@lianki/ui-state";
import type { VoiceOutcome } from "@/lib/words/voice-dispatch";
import { voiceTap } from "@/lib/words/voice-dispatch";
import type { VoiceEar, VoiceEarState } from "@/lib/words/voice-mic";

/** The synced on/off switch (docs/prefs-sync.md `words.voiceMode`): one for every screen. */
export const VOICE_PREF_KEY = "lk:words-voice-mode";

/** The voice commands switch, read after mount and again when the account or another tab changes it. */
export function useVoicePref(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(false);
  const read = useCallback(() => {
    try {
      setOn(localStorage.getItem(VOICE_PREF_KEY) === "1");
    } catch {}
  }, []);
  useEffect(() => {
    read();
    window.addEventListener(PREF_APPLIED_EVENT, read);
    window.addEventListener("storage", read);
    return () => {
      window.removeEventListener(PREF_APPLIED_EVENT, read);
      window.removeEventListener("storage", read);
    };
  }, [read]);
  const set = useCallback((n: boolean) => {
    setOn(n);
    try {
      localStorage.setItem(VOICE_PREF_KEY, n ? "1" : "0");
    } catch {}
    notePrefWrite();
  }, []);
  return [on, set];
}

/** How long a confirmation stays up. */
const FLASH_MS = 1800;

export type VoiceFlash = { outcome: VoiceOutcome; at: number };

/**
 * Listen while `on`: each final transcript goes to `handle` (the screen's
 * dispatcher); what is not a strict command goes on to the chat. `retry` restarts after a
 * failure (from a tap: the gesture a mic may need).
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
              onText: voiceTap(
                // Turned off while the mic was still starting: act on nothing.
                (text) => (alive ? handleRef.current(text) : { kind: "agent" }),
                (outcome) => setFlash({ outcome, at: Date.now() }),
              ),
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
  hint,
}: {
  state: VoiceEarState | "off";
  flash: VoiceFlash | null;
  /** The command's own words (grade names from the words page). */
  label: (o: VoiceOutcome) => string;
  retry: () => void;
  /** What the help strip covers at the bottom, px. */
  bottom: number;
  /** What to say; the /words list by default, null for none. */
  hint?: string | null;
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
      {!failed && hint !== null && (
        <div className="max-w-md text-center fs-11 leading-snug opacity-70 lk-halo">
          {hint ?? text.sayHint}
        </div>
      )}
    </div>
  );
}

/** The confirmation's words for an outcome; `grades` names Again/Hard/Good/Easy as the screen does. */
export function voiceOutcomeLabel(
  o: VoiceOutcome,
  text: {
    echo: { value: string };
    noCard: { value: string };
    next: { value: string };
    prev: { value: string };
    show: { value: string };
    read: { value: string };
    undo: { value: string };
    exit: { value: string };
  },
  grades: Record<1 | 2 | 3 | 4, string>,
): string {
  if (o.kind === "echo") return text.echo.value.replace("{text}", o.heard);
  if (o.kind === "no-card") return text.noCard.value;
  // Not shown: what is not a command is only the chat's.
  if (o.kind === "unknown" || o.kind === "agent") return "";
  switch (o.cmd) {
    case "next":
      return `↓ ${text.next.value}`;
    case "prev":
      return `↑ ${text.prev.value}`;
    case "left":
      return `← ${grades[2]}`;
    case "right":
      return `→ ${grades[3]}`;
    case "again":
      return grades[1];
    case "hard":
      return grades[2];
    case "good":
      return grades[3];
    case "easy":
      return grades[4];
    default:
      return text[o.cmd].value;
  }
}
