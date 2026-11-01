"use client";

/**
 * The voiceprint panel over the chat bar (voiceprint.ts; docs/local-stt.md,
 * "Voiceprint"): what is enrolled, "Enrol this device" (a consent card
 * first, nothing recorded until its tap), the sentences to read, and "Delete
 * my voiceprint" (confirmed). Owner pages with a local STT only.
 *
 * Inline styles, as in AskCard.tsx: the hot-loaded widget runs on the app's
 * compiled CSS, which has only the classes the app itself was built with.
 */
import { useEffect, useRef, useState } from "react";
import {
  ENROL_MAX,
  ENROL_MIN,
  ENROL_SENTENCES,
  type EnrolDeps,
  type EnrolView,
  createEnrolment,
} from "./voiceprint";
import type { ChatStrings } from "./wire";

const line = (pct: number) => `color-mix(in oklch, currentColor ${pct}%, transparent)`;
const pill = {
  borderRadius: 9999,
  borderWidth: 1,
  borderStyle: "solid",
  padding: "6px 12px",
  fontSize: 12,
  lineHeight: 1.25,
  background: "transparent",
  color: "inherit",
  cursor: "pointer",
} as const;
/** The delete button and its confirmation: a warm red, never the main action's weight. */
const DANGER = "oklch(0.58 0.2 27)";

export function VoiceprintPanel({
  t,
  deps,
  onClose,
}: {
  t: ChatStrings;
  deps: EnrolDeps;
  onClose: () => void;
}) {
  const [view, setView] = useState<EnrolView>({ step: "closed" });
  const ctl = useRef<ReturnType<typeof createEnrolment> | null>(null);
  ctl.current ??= createEnrolment(deps, setView);
  const c = ctl.current;
  useEffect(() => {
    void c.open();
    // Closing the panel drops an enrolment under way (unsaved) and gives the mic back.
    return () => c.close();
  }, [c]);
  const close = () => {
    c.close();
    onClose();
  };
  const btn = (
    testid: string,
    label: string,
    onClick: () => void,
    o: { primary?: boolean; danger?: boolean; disabled?: boolean } = {},
  ) => (
    <button
      type="button"
      data-testid={testid}
      disabled={o.disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className="tap-40 pointer-events-auto"
      style={{
        ...pill,
        borderColor: o.danger ? DANGER : line(o.primary ? 100 : 35),
        color: o.danger ? DANGER : "inherit",
        fontWeight: o.primary ? 600 : 400,
        opacity: o.disabled ? 0.4 : 1,
      }}
    >
      {label}
    </button>
  );
  const row = (children: React.ReactNode) => (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>{children}</div>
  );
  const note = (text: string, testid?: string) => (
    <p data-testid={testid} style={{ margin: "6px 0 0", fontSize: 12, opacity: 0.75 }}>
      {text}
    </p>
  );
  const again: Record<string, string> = {
    short: t.vpShort,
    noise: t.vpNoise,
    mismatch: t.vpMismatch,
    text: t.vpText,
    unreachable: t.vpUnreachable,
  };

  let body: React.ReactNode = null;
  switch (view.step) {
    case "closed":
    case "loading":
      body = note("…");
      break;
    case "status":
      body = (
        <>
          {view.prints.length ? (
            <ul data-testid="debug-voiceprint-prints" style={{ margin: "6px 0 0", paddingInlineStart: 18, fontSize: 12 }}>
              {view.prints.map((p) => (
                <li key={`${p.device}.${p.model}`}>
                  {t.vpPrint.replaceAll("{device}", p.device).replaceAll("{n}", String(p.n))}
                  <span style={{ opacity: 0.6 }}> · {p.model}</span>
                </li>
              ))}
            </ul>
          ) : (
            note(t.vpNone)
          )}
          {!view.local && note(t.vpOff, "debug-voiceprint-off")}
          {row(
            <>
              {view.local && btn("debug-voiceprint-enrol", t.vpEnrol, () => c.enrol(), { primary: true })}
              {view.local && view.prints.length > 0 && btn("debug-voiceprint-delete", t.vpDelete, () => c.askDelete(), { danger: true })}
              {btn("debug-voiceprint-close", t.vpClose, close)}
            </>,
          )}
        </>
      );
      break;
    case "consent":
      body = (
        <>
          <p data-testid="debug-voiceprint-consent" style={{ margin: "6px 0 0", fontSize: 13, lineHeight: 1.45 }}>
            {t.vpConsent.replaceAll("{n}", `${ENROL_MIN}–${ENROL_MAX}`)}
          </p>
          <label style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8, fontSize: 12 }} className="pointer-events-auto">
            <input
              type="checkbox"
              data-testid="debug-voiceprint-keep-audio"
              checked={view.keepAudio}
              onChange={(e) => c.keepAudio(e.currentTarget.checked)}
            />
            {t.vpKeepAudio}
          </label>
          {row(
            <>
              {btn("debug-voiceprint-agree", t.vpAgree, () => void c.consent(), { primary: true })}
              {btn("debug-voiceprint-cancel", t.vpCancel, close)}
            </>,
          )}
        </>
      );
      break;
    case "recording": {
      const sentence = ENROL_SENTENCES[view.index % ENROL_SENTENCES.length]!;
      body = (
        <>
          <p style={{ margin: "6px 0 0", fontSize: 12, opacity: 0.75 }}>{t.vpRead}</p>
          <p data-testid="debug-voiceprint-sentence" lang={/[぀-ヿ]/.test(sentence) ? "ja" : /[一-鿿]/.test(sentence) ? "zh" : "en"} style={{ margin: "6px 0 0", fontSize: 18, lineHeight: 1.4, fontWeight: 500 }}>
            {sentence}
          </p>
          <p data-testid="debug-voiceprint-progress" style={{ margin: "8px 0 0", fontSize: 12, fontVariantNumeric: "tabular-nums" }}>
            {t.vpProgress.replaceAll("{n}", String(view.kept)).replaceAll("{total}", String(ENROL_MAX))}
          </p>
          {view.again && (
            <p data-testid="debug-voiceprint-again" data-reason={view.again} role="status" style={{ margin: "4px 0 0", fontSize: 12, color: DANGER }}>
              {again[view.again]}
            </p>
          )}
          {row(
            <>
              {btn("debug-voiceprint-save", t.vpSave, () => c.save(), { primary: true, disabled: view.kept < ENROL_MIN })}
              {btn("debug-voiceprint-skip", t.vpSkip, () => c.skip())}
              {btn("debug-voiceprint-cancel", t.vpCancel, close)}
            </>,
          )}
        </>
      );
      break;
    }
    case "saving":
      body = note(t.vpSaving);
      break;
    case "saved":
      body = (
        <>
          {note(t.vpSaved, "debug-voiceprint-saved")}
          {row(btn("debug-voiceprint-close", t.vpClose, close))}
        </>
      );
      break;
    case "confirm-delete":
      body = (
        <>
          <p data-testid="debug-voiceprint-confirm" style={{ margin: "6px 0 0", fontSize: 13 }}>
            {t.vpDeleteConfirm}
          </p>
          {row(
            <>
              {btn("debug-voiceprint-delete-yes", t.vpDeleteYes, () => void c.confirmDelete(), { danger: true })}
              {btn("debug-voiceprint-cancel", t.vpCancel, () => void c.open())}
            </>,
          )}
        </>
      );
      break;
    case "deleted":
      body = (
        <>
          {note(t.vpDeleted, "debug-voiceprint-deleted")}
          {row(btn("debug-voiceprint-close", t.vpClose, close))}
        </>
      );
      break;
    case "error":
      body = (
        <>
          {note(t.vpFailed.replaceAll("{error}", view.error), "debug-voiceprint-error")}
          {row(btn("debug-voiceprint-close", t.vpClose, close))}
        </>
      );
      break;
  }
  return (
    <section
      role="dialog"
      aria-label={t.vpTitle}
      data-testid="debug-voiceprint"
      data-step={view.step}
      className="pointer-events-auto"
      style={{
        // The menu's glass (DebugChat.tsx INPUT_BG): readable over any page.
        background: "color-mix(in oklch, var(--background) 96%, transparent)",
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
        width: "100%",
        boxSizing: "border-box",
        maxHeight: "70vh",
        overflowY: "auto",
        padding: "10px 12px 12px",
        borderRadius: 12,
        borderWidth: 1,
        borderStyle: "solid",
        borderColor: line(25),
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <strong style={{ fontSize: 13 }}>{t.vpTitle}</strong>
        <button
          type="button"
          data-testid="debug-voiceprint-x"
          aria-label={t.vpClose}
          onMouseDown={(e) => e.preventDefault()}
          onClick={close}
          className="tap-40 pointer-events-auto"
          style={{ background: "transparent", border: 0, color: "inherit", fontSize: 12, opacity: 0.6, cursor: "pointer" }}
        >
          ✕
        </button>
      </div>
      {body}
    </section>
  );
}

/** The tiny mark after a voice line the Mac verified as his voice (SpeakerTag decision "me"). */
export function VoiceMark({ label }: { label: string }) {
  return (
    <span
      data-testid="debug-chat-voice-verified"
      role="img"
      title={label}
      aria-label={label}
      className="ms-1 inline-flex select-none items-center align-baseline leading-none"
      style={{ fontSize: "0.8em", color: "oklch(0.62 0.15 150)", opacity: 0.85 }}
    >
      <svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
        <path d="M3.5 8.5l3 3 6-7" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}
