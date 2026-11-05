/**
 * The signed-in user's title rules on the server (docs/title-clean.md). Any
 * failure gives the defaults: cleaning a title must never be able to block
 * saving or showing a card.
 */
import { activeTitleRules, DEFAULT_TITLE_RULES, type TitleRule } from "@lianki/core/titleClean";
import { authUserOrNull } from "@/app/signInEmail";
import { dbBackend, getD1 } from "@/lib/d1";
import { UserPrefsD1Repo } from "@/lib/repos/userPrefsD1";

export async function titleRulesForUser(): Promise<readonly TitleRule[]> {
  try {
    if (dbBackend() !== "d1") return DEFAULT_TITLE_RULES;
    const user = await authUserOrNull();
    if (!user?.id) return DEFAULT_TITLE_RULES;
    return activeTitleRules(await new UserPrefsD1Repo(getD1(), user.id).value("titles.rules"));
  } catch {
    return DEFAULT_TITLE_RULES;
  }
}
