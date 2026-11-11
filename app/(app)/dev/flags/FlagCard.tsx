import { FLAGS, type FlagDef } from "@/lib/flags";
import type { FlagRow } from "@/lib/flags-store";
import type { PrereqFailure } from "@/lib/flag-prereqs";
import { SealSwitch } from "@/app/components/SealSwitch";

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
 * The name and the switch are always there: a box seal that names the state
 * (filled red 开 = on, dashed grey 关闭 = off; app/components/SealSwitch.tsx); tapping the name unfolds
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
        <SealSwitch
          data-flag-state={f.enabled ? "on" : "off"}
          checked={f.enabled}
          aria-label={f.key}
          aria-describedby={blocked ? `prereq-${f.key}` : undefined}
          disabled={busy || locked}
          title={locked ? "条件未满足，不能打开" : undefined}
          onClick={onToggle}
        />
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
      {expanded && (
        <div id={`details-${f.key}`} className="space-y-1 pb-1.5">
          <p className="text-sm">{f.description}</p>
          <p className="text-xs opacity-60">
            {f.updatedAt
              ? `${f.updatedBy} · ${jst(f.updatedAt)}`
              : FLAGS[f.key].default
                ? "从未改过（默认开）"
                : "从未改过（默认关）"}
          </p>
        </div>
      )}
    </section>
  );
}
