import { chatExtra } from "./chat-ui-locales";

/**
 * The consent card for Lianki's speech servers (public-stt.ts; docs/local-stt.md,
 * "Lianki's speech servers for everyone"): shown once per device when the mic
 * turns on for an account that may use them. Nothing goes to the speech servers
 * before the tap on the main button; "Not now" keeps the cloud recognition, as
 * before, until the next page. Synthetic clicks (page code) are ignored.
 */
export function SttServersCard({ onAgree, onLater }: { onAgree: () => void; onLater: () => void }) {
  const x = chatExtra();
  return (
    <div
      role="dialog"
      aria-labelledby="lk-stt-servers-title"
      data-testid="debug-stt-servers-consent"
      // The chat's own text colour on a seal tint, as the attached-quote chip (light and dark).
      className="pointer-events-auto mb-1 rounded-lg border p-2.5 fs-13 backdrop-blur"
      style={{
        borderColor: "oklch(0.53 0.207 22.3 / 0.45)",
        background: "oklch(0.6 0.11 22.3 / 0.12)",
      }}
    >
      <p id="lk-stt-servers-title" className="m-0 font-semibold">
        {x.sttServersTitle}
      </p>
      <p className="mt-1 mb-2 leading-snug">{x.sttServersBody}</p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          data-testid="debug-stt-servers-agree"
          className="rounded-lg px-3 py-1.5 font-medium text-white"
          style={{ background: "oklch(0.53 0.207 22.3)" }}
          onClick={(e) => e.isTrusted && onAgree()}
        >
          {x.sttServersAgree}
        </button>
        <button
          type="button"
          data-testid="debug-stt-servers-later"
          className="rounded-lg border px-3 py-1.5"
          style={{ borderColor: "oklch(0.6 0.02 60 / 0.6)" }}
          onClick={onLater}
        >
          {x.sttServersLater}
        </button>
      </div>
    </div>
  );
}
