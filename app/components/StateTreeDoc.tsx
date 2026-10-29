import { StateTree } from "@lianki/debug-chat/StateTree";
import { STATE_TREE_MD } from "@/lib/state-tree.generated";

/** docs/state-tree.md as the read-only outline (owner pages only: /dev/roadmap). */
export function StateTreeDoc() {
  return (
    <section
      lang="en"
      className="rounded-xl border border-black/10 bg-white/60 px-3 py-2 dark:border-white/10 dark:bg-gray-900/60"
    >
      <StateTree markdown={STATE_TREE_MD} repo="snolab/lianki" />
    </section>
  );
}
