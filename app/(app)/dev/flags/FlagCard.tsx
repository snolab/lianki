import { FLAGS, type FlagDef } from "@/lib/flags";
import type { FlagRow } from "@/lib/flags-store";
import type { PrereqFailure } from "@/lib/flag-prereqs";

/** Shown under every flag that moves real money (policy: typed Slack confirmation). */
export const MONEY_NOTE = "打开正式收款前请在 Slack 打字确认";

/** Written out, in JST, labelled — the owner reads every time in JST. */
export const jst = (iso: string) =>
  `${new Date(iso).toLocaleString("zh-CN", {
    timeZone: "Asia/Tokyo",
    dateStyle: "long",
    timeStyle: "short",
  })} JST`;

export const card =
  "rounded-lg border border-[oklch(0_0_0/0.1)] dark:border-[oklch(1_0_0/0.1)] p-4 space-y-2";

export const FLAG_HIGHLIGHT =
  "bg-[oklch(0.95_0.07_95)] dark:bg-[oklch(0.35_0.07_95)] outline-2 outline-[oklch(0.75_0.15_85)]";

/** A caret that points down when its section or row is open. */
export function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={`shrink-0 opacity-60 transition-transform motion-reduce:transition-none ${open ? "rotate-90" : ""}`}
    >
      <path d="M6 3.5 10.5 8 6 12.5" />
    </svg>
  );
}

/**
 * One row on /dev/flags; its `id` is the key, so /dev/flags#<key> links to it.
 * The name, the state and the switch are always there; tapping the name unfolds
 * the description and the last change. A flag whose prerequisites fail cannot be
 * turned on: its switch is greyed and disabled, with every reason listed, folded
 * or not, because they say why the switch does nothing. If it is on anyway
 * (turned on before the check existed, or a secret removed since), the switch
 * stays usable so it can always be turned off — the kill switch.
 */
export function FlagCard({
  flag: f,
  failed = [],
  busy,
  highlighted = false,
  expanded = false,
  note,
  onExpand,
  onToggle,
}: {
  flag: FlagRow;
  failed?: PrereqFailure[];
  busy: boolean;
  /** Reached by a /dev/flags#<key> link just now. */
  highlighted?: boolean;
  /** Showing the description and the last change. */
  expanded?: boolean;
  /** What the last tap on this switch did. */
  note?: string | null;
  onExpand?: () => void;
  onToggle: () => void;
}) {
  const blocked = failed.length > 0;
  const locked = blocked && !f.enabled;
  const money = (FLAGS[f.key] as FlagDef).money === true;
  return (
    <section
      id={f.key}
      className={`px-3 py-1.5 space-y-1.5 scroll-mt-20 transition-colors duration-500 ${highlighted ? FLAG_HIGHLIGHT : ""}`}
      data-flag={f.key}
      data-blocked={blocked || undefined}
      data-highlighted={highlighted || undefined}
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={expanded ? `details-${f.key}` : undefined}
          onClick={onExpand}
          className="flex min-h-9 min-w-0 flex-1 items-center gap-1.5 text-start"
        >
          <Chevron open={expanded} />
          <code className="font-mono text-sm break-all">{f.key}</code>
        </button>
        <span
          data-flag-state
          className={`shrink-0 text-xs ${f.enabled ? "font-bold text-[oklch(0.5_0.15_150)] dark:text-[oklch(0.78_0.15_150)]" : "opacity-60"}`}
        >
          {f.enabled ? "开" : "关"}
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={f.enabled}
          aria-label={f.key}
          aria-describedby={blocked ? `prereq-${f.key}` : undefined}
          disabled={busy || locked}
          title={locked ? "条件未满足，不能打开" : undefined}
          onClick={onToggle}
          className={`relative h-7 w-12 shrink-0 rounded-full transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
            f.enabled ? "bg-[oklch(0.62_0.17_150)]" : "bg-[oklch(0.8_0_0)] dark:bg-[oklch(0.4_0_0)]"
          }`}
        >
          <span
            className={`absolute top-1 h-5 w-5 rounded-full bg-[oklch(1_0_0)] transition-all ${
              f.enabled ? "left-6" : "left-1"
            }`}
          />
        </button>
      </div>
      {blocked && (
        <ul
          id={`prereq-${f.key}`}
          className="text-xs space-y-0.5 text-[oklch(0.55_0.17_45)] dark:text-[oklch(0.78_0.14_60)]"
        >
          {failed.map((r) => (
            <li key={r.check} data-reason={r.reason}>
              {f.enabled ? "条件未满足（只能关闭）：" : "不能打开："}
              {r.text}
            </li>
          ))}
        </ul>
      )}
      {money && <p className="text-xs font-bold">{MONEY_NOTE}</p>}
      {note && (
        <p role="status" className="text-xs">
          {note}
        </p>
      )}
      {expanded && (
        <div id={`details-${f.key}`} className="space-y-1 pb-1.5">
          <p className="text-sm">{f.description}</p>
          <p className="text-xs opacity-60">
            {f.updatedAt ? `${f.updatedBy} · ${jst(f.updatedAt)}` : "从未改过（默认关）"}
          </p>
        </div>
      )}
    </section>
  );
}
