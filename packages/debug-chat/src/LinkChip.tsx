/**
 * The connection chip, left of the progress bar on a developer's chat
 * (docs/dev-debug-widget.md, "Connection chip"): whether a sender's code can
 * reach this page, and whether the agent has the selection attached to the
 * chat. A single icon keeps the progress row compact; the current states
 * stay in its accessible label and tooltip. A tap opens the details: each eval grant (who, until when, which
 * pages) with End, which deletes the grant at once. States: link-state.ts.
 */
import { useState } from "react";
import { Icon } from "./icons";
import {
  EVAL_LINK_STATES,
  type EvalLink,
  type EvalSession,
  SELECTION_STATES,
  type SelectionState,
} from "./link-state";
import type { UiStrings } from "./ui-strings";
import type { GrantWords } from "./wire";
import { timeLeft } from "./link-state";

/** The chip's words: UiStrings' link… / eval… / sel… keys, and the grant length's. */
export type LinkWords = Pick<
  UiStrings,
  | "linkChip"
  | "linkEval"
  | "linkSel"
  | "evalOff"
  | "evalConnecting"
  | "evalConnected"
  | "evalDisconnected"
  | "evalOffTip"
  | "evalConnectingTip"
  | "evalConnectedTip"
  | "evalDisconnectedTip"
  | "selNone"
  | "selPending"
  | "selSeen"
  | "selFailed"
  | "selNoneTip"
  | "selPendingTip"
  | "selSeenTip"
  | "selFailedTip"
  | "linkLeft"
  | "linkReachAll"
  | "linkReachHere"
  | "linkReachOther"
  | "linkEnd"
> &
  GrantWords;

const EVAL_WORD = {
  off: ["evalOff", "evalOffTip"],
  connecting: ["evalConnecting", "evalConnectingTip"],
  connected: ["evalConnected", "evalConnectedTip"],
  disconnected: ["evalDisconnected", "evalDisconnectedTip"],
} as const satisfies Record<EvalLink, readonly [keyof LinkWords, keyof LinkWords]>;
const SEL_WORD = {
  none: ["selNone", "selNoneTip"],
  pending: ["selPending", "selPendingTip"],
  seen: ["selSeen", "selSeenTip"],
  failed: ["selFailed", "selFailedTip"],
} as const satisfies Record<SelectionState, readonly [keyof LinkWords, keyof LinkWords]>;

/** The theme's seal fill and the word on it (globals.css --lk-primary / --lk-on-primary, AA). */
const SEAL = "var(--lk-primary, oklch(0.53 0.207 22.3))";
const PAPER = "var(--lk-on-primary, oklch(0.985 0.01 85))";
/** A muted state: the seal switch's "off" grey, per theme (unit/seal-switch.test.ts checks its AA). */
const MUTED = "var(--lk-seal-off, oklch(0.46 0.02 68))";
const keep = (e: { preventDefault(): void }) => e.preventDefault();

/** The details' state list: every state by name, the current one marked. */
function StateList<S extends string>({
  title,
  states,
  current,
  word,
  tip,
}: {
  title: string;
  states: readonly S[];
  current: S;
  word: (s: S) => string;
  tip: string;
}) {
  return (
    <section className="flex flex-col gap-1">
      <h3 className="font-semibold">{title}</h3>
      <ul className="flex flex-wrap gap-1" aria-label={title}>
        {states.map((s) => (
          <li
            key={s}
            aria-current={s === current ? "true" : undefined}
            className="rounded-full px-2 leading-5"
            style={
              s === current
                ? { background: SEAL, color: PAPER }
                : { border: `1px solid ${MUTED}`, color: MUTED }
            }
          >
            {word(s)}
          </li>
        ))}
      </ul>
      <p className="opacity-80">{tip}</p>
    </section>
  );
}

export function LinkChip({
  t,
  link,
  selection,
  sessions,
  now,
  onEnd,
  glass = false,
}: {
  /** Match the progress bar's margin inside or outside the shared glass strip. */
  glass?: boolean;
  t: LinkWords;
  link: EvalLink;
  selection: SelectionState;
  /** The eval grants in time, each marked whether it reaches this page. */
  sessions: readonly (EvalSession & { here: boolean })[];
  now: number;
  /** End a grant (the hub deletes it at once). */
  onEnd: (pair: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const evalWord = (s: EvalLink) => t[EVAL_WORD[s][0]];
  const selWord = (s: SelectionState) => t[SEL_WORD[s][0]];
  const tip = `${t.linkEval}: ${t[EVAL_WORD[link][1]]}\n${t.linkSel}: ${t[SEL_WORD[selection][1]]}`;
  return (
    <div className={`pointer-events-auto relative flex shrink-0 ${glass ? "" : "mb-1"}`}>
      <button
        type="button"
        data-testid="debug-chat-link"
        aria-label={`${t.linkChip}: ${t.linkEval} ${evalWord(link)}, ${t.linkSel} ${selWord(selection)}`}
        aria-expanded={open}
        title={tip}
        onPointerDown={keep}
        onClick={() => setOpen((o) => !o)}
        data-state={link}
        data-selection={selection}
        style={{ color: link === "connected" ? SEAL : MUTED }}
        className="inline-flex min-w-5 items-center justify-center rounded px-1 py-0.5 fs-10 leading-none"
      >
        <span aria-hidden className="inline-flex fs-12">
          <Icon name="link" />
        </span>
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={t.linkChip}
          data-testid="debug-chat-link-details"
          className="absolute bottom-full start-0 z-40 mb-1 flex w-[min(20rem,calc(100vw-2rem))] flex-col gap-2 rounded-xl border border-current/20 bg-gray-50/95 p-2.5 fs-12 leading-snug text-gray-900 shadow-lg backdrop-blur-md dark:bg-gray-900/95 dark:text-gray-100"
        >
          <StateList
            title={t.linkEval}
            states={EVAL_LINK_STATES}
            current={link}
            word={evalWord}
            tip={t[EVAL_WORD[link][1]]}
          />
          {sessions.length > 0 && (
            <ul className="flex flex-col gap-1" data-testid="debug-chat-link-sessions">
              {sessions.map((s) => (
                <li key={s.pair} className="flex items-center gap-2">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{s.label}</span>
                    <span className="block opacity-80">
                      {t.linkLeft.replaceAll("{time}", timeLeft((s.until ?? now) - now, t))}
                      {" · "}
                      {!s.pages ? t.linkReachAll : s.here ? t.linkReachHere : t.linkReachOther}
                    </span>
                  </span>
                  <button
                    type="button"
                    data-testid="debug-chat-link-end"
                    onPointerDown={keep}
                    onClick={() => onEnd(s.pair)}
                    className="tap-40 shrink-0 rounded-full px-2.5 leading-6 font-medium"
                    style={{ background: SEAL, color: PAPER }}
                  >
                    {t.linkEnd}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <StateList
            title={t.linkSel}
            states={SELECTION_STATES}
            current={selection}
            word={selWord}
            tip={t[SEL_WORD[selection][1]]}
          />
        </div>
      )}
    </div>
  );
}
