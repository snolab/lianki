/**
 * A wait written for people (owner, 2026-11-16: "782 分钟听着很奇怪，用天或者小时"):
 * under an hour in minutes, under two days in hours, else in days, rounded up,
 * in the reader's language with its own unit word (Intl, "13 小时", "13 hours").
 */
export function waitText(minutes: number, locale?: string): string {
  const m = Math.max(1, Math.ceil(minutes));
  const [n, unit] =
    m < 60
      ? [m, "minute"]
      : m < 48 * 60
        ? [Math.ceil(m / 60), "hour"]
        : [Math.ceil(m / 1440), "day"];
  try {
    return new Intl.NumberFormat(locale || "en", {
      style: "unit",
      unit,
      unitDisplay: "long",
    }).format(n);
  } catch {
    return `${n} ${unit}${n === 1 ? "" : "s"}`;
  }
}
