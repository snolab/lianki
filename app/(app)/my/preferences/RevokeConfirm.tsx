/**
 * The Revoke control at the end of a token's row in Settings → API tokens
 * (TokenManager.tsx). Revoking cannot be undone and stops every program using
 * the token at once, so the first click only asks: the row shows the question
 * with Revoke and Cancel, Cancel takes the focus (the safe choice under a
 * stray Enter), and Esc backs out like Cancel. Stateless — the parent holds
 * which row is asking — so every branch renders and is tested without a DOM.
 */

export type RevokeLabels = {
  /** "Revoke" — the row's button, and the confirm button in the question. */
  revoke: string;
  /** "Revoke {name}? Apps using it stop working at once." */
  question: string;
  cancel: string;
};

/** The question with the token's name in it (plain text; React escapes it). */
export function revokeQuestion(template: string, name: string): string {
  return template.split("{name}").join(name);
}

/** Esc backs out of the question, as Cancel does. */
export function escapeCancels(onCancel: () => void) {
  return (e: { key: string; preventDefault?: () => void }) => {
    if (e.key !== "Escape") return;
    e.preventDefault?.();
    onCancel();
  };
}

const button = "shrink-0 px-3 py-1.5 rounded text-xs";
const danger =
  "border border-red-300 dark:border-red-700 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20";

export function RevokeConfirm({
  id,
  name,
  confirming,
  busy = false,
  focusRevoke = false,
  labels,
  onAsk,
  onConfirm,
  onCancel,
}: {
  /** The token's id, for the question's element id. */
  id: string;
  name: string;
  confirming: boolean;
  busy?: boolean;
  /** Put the focus back on Revoke (after Cancel), so the keyboard stays in the row. */
  focusRevoke?: boolean;
  labels: RevokeLabels;
  onAsk: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!confirming)
    return (
      <button
        type="button"
        onClick={onAsk}
        autoFocus={focusRevoke}
        data-testid="token-revoke"
        className={`${button} ${danger}`}
      >
        {labels.revoke}
      </button>
    );
  const qid = `revoke-q-${id}`;
  return (
    <div
      role="group"
      aria-labelledby={qid}
      onKeyDown={escapeCancels(onCancel)}
      data-testid="token-revoke-confirm"
      className="shrink-0 max-w-[16rem] space-y-2 text-right"
    >
      <p id={qid} className="text-xs text-red-700 dark:text-red-300 break-words">
        {revokeQuestion(labels.question, name)}
      </p>
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          autoFocus
          data-testid="token-revoke-cancel"
          className={`${button} border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-800`}
        >
          {labels.cancel}
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy}
          data-testid="token-revoke-yes"
          className={`${button} bg-red-700 text-white hover:bg-red-800 disabled:opacity-50`}
        >
          {labels.revoke}
        </button>
      </div>
    </div>
  );
}
