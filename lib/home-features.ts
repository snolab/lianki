/**
 * The learning features shown as cards under Explore on /home, each over its
 * own drawing (app/(app)/home/FeatureArt.tsx). Keys index APP_NAV and the nav
 * labels.
 */
export const HOME_EXPLORE = [
  "words",
  "alphabet",
  "learn",
  "aiVocab",
  "polyglot",
  "selfIntro",
  "read",
  "roadmap",
] as const;
export type HomeFeatureKey = (typeof HOME_EXPLORE)[number];

/**
 * Where a card goes when that is not its nav item's href. Word lists opens the
 * "Add a list" tree on /words (WORDS_ADD_HASH, WordsClient), not the list this
 * tab last studied.
 */
export const WORDS_ADD_HASH = "add-list";
export const HOME_EXPLORE_HREF: Partial<Record<HomeFeatureKey, string>> = {
  words: `/words#${WORDS_ADD_HASH}`,
};
