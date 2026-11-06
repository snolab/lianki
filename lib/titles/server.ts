/**
 * The signed-in user's title rules on the server (docs/title-clean.md). Any
 * failure gives the defaults: cleaning a title must never be able to block
 * saving or showing a card.
 */
import { activeTitleRules, DEFAULT_TITLE_RULES, type TitleRule } from "@lianki/core/titleClean";
import { authUserOrNull } from "@/app/signInEmail";
import { dbBackend, getD1 } from "@/lib/d1";
import type { D1Like } from "@/lib/d1/types";
import { UserPrefsD1Repo } from "@/lib/repos/userPrefsD1";

export async function titleRulesFrom(
  user: () => Promise<{ id?: string } | null | undefined>,
  db: () => D1Like,
): Promise<readonly TitleRule[]> {
  try {
    const id = (await user())?.id;
    if (!id) return DEFAULT_TITLE_RULES;
    return activeTitleRules(await new UserPrefsD1Repo(db(), id).value("titles.rules"));
  } catch {
    return DEFAULT_TITLE_RULES;
  }
}

/** Off D1 (the frozen Mongo copy) no rules are stored. */
export const titleRulesForUser = (): Promise<readonly TitleRule[]> =>
  dbBackend() === "d1"
    ? titleRulesFrom(authUserOrNull, getD1)
    : Promise.resolve(DEFAULT_TITLE_RULES);
