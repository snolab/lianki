/**
 * The spend alert's names and defaults (docs/payments.md, "Spend alert"),
 * with no imports so lib/config.ts and lib/flags.ts can read them. The live
 * values are config keys (/dev/config); these are only the defaults.
 */

/** Flag: post a line in the owner's thread each time a spend counter passes a step. */
export const SPEND_ALERT_FLAG = "partner.spend-alert";
/** The hub's internal path (lianki-push, the PUSH binding's hostname only). */
export const SPEND_ALERT_PATH = "/internal/spend-alert";
/** The line's label and agent id in the owner's thread. */
export const SPEND_ALERT_LABEL = "spend";

/** One step, USD: a line each time a counter passes the next multiple of it. */
export const SPEND_STEP_USD = 1;
export const SPEND_STEP_MIN = 0.1;
export const SPEND_STEP_MAX = 100;

/** The lines. {n} = the step reached, {today} / {month} = spent today / this month (UTC). */
export const SPEND_SITE_TEXT = "AI 全站花费已达 ${n}（今日 ${today}，本月 ${month}）";
export const SPEND_MINE_TEXT = "我的 AI 花费已达 ${n}（今日 ${today}，本月 ${month}）";

/** The longest line the hub posts (the config text is at most 200, plus the amounts). */
export const SPEND_LINE_MAX = 300;

export type SpendNotice = { scope: "site" | "mine"; step: number; text: string };

/** The main Worker's POST body to SPEND_ALERT_PATH, bounded; null when it is not one. */
export function parseSpendNotice(raw: unknown): SpendNotice | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.scope !== "site" && r.scope !== "mine") return null;
  if (typeof r.step !== "number" || !Number.isFinite(r.step) || r.step <= 0) return null;
  const text = typeof r.text === "string" ? r.text.trim() : "";
  if (!text || text.length > SPEND_LINE_MAX) return null;
  return { scope: r.scope, step: r.step, text };
}
