import { authUserOrNull } from "@/app/signInEmail";
import { isOwner } from "@/lib/owner";
import { STATE_TREE_MD } from "@/lib/state-tree.generated";

/**
 * Owner-only: docs/state-tree.md, the outline of what is in flight and what
 * waits on the owner, for the chat widget's Tree view. Served from the copy
 * bundled at commit time (scripts/gen-state-tree.ts): the Worker has no
 * filesystem. 404 for anyone else, as /api/dev/log.
 */
export const GET = async () => {
  if (!isOwner((await authUserOrNull())?.email))
    return Response.json({ error: "Not found" }, { status: 404 });
  return new Response(STATE_TREE_MD, {
    headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "no-store" },
  });
};
