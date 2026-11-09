// Which material the Free / Pro plan cards on /membership are drawn in
// (app/(app)/membership/PlanCards.tsx). Marble is the design (owner,
// 2026-11-09); ?card=paper|wood still previews the other two.

export const PLAN_SKINS = ["marble", "paper", "wood"] as const;
export type PlanSkin = (typeof PLAN_SKINS)[number];
export const DEFAULT_PLAN_SKIN: PlanSkin = "marble";

/** The skin for a page's query string: a known ?card= value, else marble. */
export function planSkinFrom(search: string): PlanSkin {
  const v = new URLSearchParams(search).get("card");
  return PLAN_SKINS.find((s) => s === v) ?? DEFAULT_PLAN_SKIN;
}
