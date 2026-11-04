/**
 * The learning features shown as cards under Explore on /home, each with a
 * screenshot of the feature as its background
 * (public/home-features/<key>-<light|dark>.webp). The screenshots come from a
 * throwaway demo account on a local app: `bun run shots:home`
 * (scripts/qa/home-feature-shots.mjs). Keys index APP_NAV and the nav labels.
 */
import { APP_NAV } from "@/lib/app-nav";

export const HOME_EXPLORE = [
  "alphabet",
  "learn",
  "aiVocab",
  "polyglot",
  "selfIntro",
  "read",
  "roadmap",
] as const;
export type HomeFeatureKey = (typeof HOME_EXPLORE)[number];

/** Features that have a screenshot in public/home-features/. */
export const HOME_FEATURE_SHOTS: ReadonlySet<string> = new Set<string>(HOME_EXPLORE);

/**
 * Stored size of every screenshot: an iPhone viewport (390×844) below the
 * app's 56px top bar (390×788), scaled down. Used as the img's width/height.
 */
export const HOME_FEATURE_SHOT = { width: 320, height: 647 } as const;

export const HOME_FEATURES = HOME_EXPLORE.map((key) => {
  const item = APP_NAV.find((n) => n.key === key);
  if (!item) throw new Error(`home feature ${key} is not in APP_NAV`);
  return item;
});

export function homeFeatureShot(key: string, scheme: "light" | "dark"): string | null {
  return HOME_FEATURE_SHOTS.has(key) ? `/home-features/${key}-${scheme}.webp` : null;
}
