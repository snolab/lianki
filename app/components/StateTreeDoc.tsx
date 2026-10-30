import { STATE_TREE_MD } from "@/lib/state-tree.generated";
import { LiveStateTree } from "./LiveStateTree";

/**
 * docs/state-tree.md as the outline, with live progress laid over it
 * (owner pages only: /dev/roadmap).
 */
export function StateTreeDoc() {
  return (
    <section
      lang="en"
      className="rounded-xl border border-black/10 bg-white/60 px-3 py-2 dark:border-white/10 dark:bg-gray-900/60"
    >
      <LiveStateTree markdown={STATE_TREE_MD} repo="snolab/lianki" />
    </section>
  );
}
