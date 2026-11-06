/**
 * The learning features shown as cards under Explore on /home, each over its
 * own drawing (app/(app)/home/FeatureArt.tsx). Keys index APP_NAV and the nav
 * labels.
 */
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
