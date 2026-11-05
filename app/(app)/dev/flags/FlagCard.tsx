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

/**
 * One flag on /dev/flags; its `id` is the key, so /dev/flags#<key> links to it. A flag whose prerequisites fail cannot be turned on:
 * its switch is greyed and disabled, with every reason listed. If it is on
 * anyway (turned on before the check existed, or a secret removed since), the
 * switch stays usable so it can always be turned off — the kill switch.
 */
export function FlagCard({
  flag: f,
  failed = [],
  busy,
  highlighted = false,
  onToggle,
}: {
  flag: FlagRow;
  failed?: PrereqFailure[];
  busy: boolean;
  /** Reached by a /dev/flags#<key> link just now. */
  highlighted?: boolean;
  onToggle: () => void;
}) {
  const blocked = failed.length > 0;
  const locked = blocked && !f.enabled;
  const money = (FLAGS[f.key] as FlagDef).money === true;
  return (
    <section
      id={f.key}
      className={`${card} scroll-mt-20 transition-colors duration-500 ${highlighted ? FLAG_HIGHLIGHT : ""}`}
      data-flag={f.key}
      data-blocked={blocked || undefined}
      data-highlighted={highlighted || undefined}
    >
      <div className="flex items-center justify-between gap-3">
        <code className="font-mono text-sm break-all">{f.key}</code>
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
      <p className="text-sm">{f.description}</p>
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
      <p className="text-xs opacity-60">
        {f.enabled ? "开" : "关"}
        {f.updatedAt ? ` · ${f.updatedBy} · ${jst(f.updatedAt)}` : " · 从未改过（默认关）"}
      </p>
    </section>
  );
}
