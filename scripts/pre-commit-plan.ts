/**
 * Which of scripts/pre-commit.ts's generation steps a commit needs, decided
 * from the staged paths alone — so a commit that touches none of their inputs
 * pays for none of them. Pure, so unit/pre-commit-plan.test.ts can pin it.
 *
 * Each generated file is also checked by a unit test that pre-push and CI run
 * (state-tree.test.ts, blog-corpus.test.ts, userscript-version.test.ts), so a
 * step skipped here wrongly would still be caught before main.
 */
import { CORPUS_PATH } from "./gen-blog-corpus";
import { STATE_TREE_MODULE, STATE_TREE_PATH } from "./gen-state-tree";

export const USERSCRIPT_SRC = "src/lianki.user.ts";
export const USERSCRIPT_OUT = "public/lianki.user.js";

export type PreCommitPlan = {
  /** Regenerate lib/state-tree.generated.ts from docs/state-tree.md. */
  stateTree: boolean;
  /** Rebuild public/lianki.user.js from src/lianki.user.ts. */
  buildUserscript: boolean;
  /** Regenerate lib/blog.corpus.json from blog/<locale>/*.md. */
  blogCorpus: boolean;
};

/** `staged` is `git diff --cached --name-only`: repo-relative, forward slashes. */
export function planPreCommit(staged: readonly string[]): PreCommitPlan {
  const has = (p: string) => staged.includes(p);
  return {
    // The generator itself counts as an input: a change to its output format
    // must land with the regenerated file.
    stateTree: has(STATE_TREE_PATH) || has(STATE_TREE_MODULE) || has("scripts/gen-state-tree.ts"),
    buildUserscript: has(USERSCRIPT_SRC),
    blogCorpus:
      has(CORPUS_PATH) ||
      has("scripts/gen-blog-corpus.ts") ||
      staged.some((f) => f.startsWith("blog/") && f.endsWith(".md")),
  };
}
