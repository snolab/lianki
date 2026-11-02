"use client";

import { useState } from "react";
import { type Ask, type AskAnswer, type AskChoices, askState } from "./ask";
import { uiStrings } from "./ui-strings";

/*
 * Inline styles, not utility classes: the hot-loaded widget runs on the app's
 * compiled CSS, which has only the classes the app itself was built with.
 */
const line = (pct: number) => `color-mix(in oklch, currentColor ${pct}%, transparent)`;
const pill = {
  borderRadius: 9999,
  borderWidth: 1,
  borderStyle: "solid",
  padding: "4px 10px",
  fontSize: 12,
  lineHeight: 1.25,
  background: "transparent",
  color: "inherit",
} as const;

/**
 * An ask card under an agent line (ask.ts): each question with its options
 * as pills, the recommended one marked. One question with one choice sends
 * on the tap; a batch (or a multi-choice question) sends with "Send" once
 * every question has a choice. One-shot: after the tap it greys out showing
 * the choice; past its expiry it says so. The answer itself is stamped by
 * the hub; with an older page (no `onAnswer`), the choice goes as a typed
 * line instead, which is not a tap-grade answer.
 */
export function AskCard({
  ask,
  answer,
  onAnswer,
  sendText,
}: {
  ask: Ask;
  answer?: AskAnswer;
  /** Sends {type:"answer"} on the page's socket; false if it could not. */
  onAnswer?: (askId: string, choices: AskChoices) => boolean;
  /** The fallback: the choice as a chat line (an older page without onAnswer). */
  sendText: (text: string) => boolean;
}) {
  const ui = uiStrings();
  const [picked, setPicked] = useState<AskChoices>({});
  /** Sent from this page and not yet confirmed by the hub. */
  const [sent, setSent] = useState<AskChoices | null>(null);
  const state = askState({ ask, answer }, Date.now());
  const shown = answer?.choices ?? sent;
  const done = state !== "open" || !!sent;
  const quick = ask.questions.length === 1 && !ask.questions[0]!.multi;

  const submit = (choices: AskChoices) => {
    if (done) return; // one-shot
    const ok = onAnswer
      ? onAnswer(ask.askId, choices)
      : sendText(
          ask.questions
            .map(
              (q) =>
                `${ask.questions.length > 1 ? `${q.question}: ` : ""}${(choices[q.id] ?? [])
                  .map((id) => q.options.find((o) => o.id === id)?.label ?? id)
                  .join(", ")}`,
            )
            .join("; "),
        );
    if (ok) setSent(choices);
  };
  const tap = (qid: string, oid: string, multi: boolean) => {
    if (done) return;
    if (quick) return submit({ [qid]: [oid] });
    setPicked((p) => {
      const cur = p[qid] ?? [];
      const next = multi ? (cur.includes(oid) ? cur.filter((x) => x !== oid) : [...cur, oid]) : [oid];
      return { ...p, [qid]: next };
    });
  };
  const complete = ask.questions.every((q) => (picked[q.id] ?? []).length > 0);

  return (
    <span
      data-testid="debug-chat-ask"
      data-ask={ask.askId}
      data-state={sent && state === "open" ? "sent" : state}
      style={{ display: "block", marginTop: 4, opacity: done ? 0.6 : 1 }}
    >
      {ask.questions.map((q) => (
        <span key={q.id} style={{ display: "block", marginTop: 6 }}>
          {ask.questions.length > 1 && (
            <span style={{ display: "block", fontSize: 11, fontWeight: 500 }}>{q.question}</span>
          )}
          <span style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 2 }}>
            {q.options.map((o) => {
              const chosen = (shown ?? picked)[q.id]?.includes(o.id) ?? false;
              return (
                <button
                  key={o.id}
                  type="button"
                  data-testid="debug-chat-ask-option"
                  data-option={o.id}
                  aria-pressed={chosen}
                  disabled={done}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => tap(q.id, o.id, !!q.multi)}
                  className="tap-40 pointer-events-auto"
                  style={{
                    ...pill,
                    borderColor: line(chosen ? 100 : o.recommended ? 60 : 25),
                    fontWeight: chosen ? 600 : 400,
                    textDecoration: done && !chosen ? "line-through" : "none",
                    cursor: done ? "default" : "pointer",
                  }}
                >
                  {chosen && done ? "✓ " : ""}
                  {o.label}
                  {o.recommended && (
                    <span style={{ marginInlineStart: 4, fontSize: 10, opacity: 0.7 }}>
                      · {ui.askRecommended}
                    </span>
                  )}
                </button>
              );
            })}
          </span>
        </span>
      ))}
      {!quick && !done && (
        <button
          type="button"
          data-testid="debug-chat-ask-send"
          disabled={!complete}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => complete && submit(picked)}
          className="tap-40 pointer-events-auto"
          style={{
            ...pill,
            marginTop: 6,
            padding: "4px 12px",
            borderColor: line(100),
            fontWeight: 600,
            opacity: complete ? 1 : 0.4,
          }}
        >
          {ui.askSend}
        </button>
      )}
      {done && (
        <span
          data-testid="debug-chat-ask-status"
          style={{ display: "block", marginTop: 4, fontSize: 10, opacity: 0.7 }}
        >
          {state === "expired" ? ui.askExpired : state === "answered" ? ui.askAnswered : ui.askSent}
        </span>
      )}
    </span>
  );
}
