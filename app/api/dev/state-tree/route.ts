import { authUserOrNull } from "@/app/signInEmail";
import { boxChatCaller } from "@/lib/box-oauth/chat-ticket";
import { BOX_IDENTITY_HEADER } from "@/lib/box-oauth/identity";
import type { BoxDb } from "@/lib/box-oauth/store";
import { getD1 } from "@/lib/d1";
import { isDev } from "@/lib/permissions";
import { STATE_TREE_MD } from "@/lib/state-tree.generated";

const notFound = () => Response.json({ error: "Not found" }, { status: 404 });

/**
 * Owner-only: docs/state-tree.md, the outline of what is in flight and what
 * waits on the owner, for the chat widget's Tree view and ETA bar. Served from
 * the copy bundled at commit time (scripts/gen-state-tree.ts): the Worker has
 * no filesystem. 404 for anyone else, as /api/dev/log.
 *
 * The owner's box (docs/box-oauth.md, "Chat on the owner's box") has no
 * cookie: a box:chat token's request, checked again here as the STT route
 * does (live binding with box:chat, same account, a site owner now).
 */
export const GET = async (req: Request) => {
  if (req.headers.has(BOX_IDENTITY_HEADER)) {
    const ok = await Promise.resolve()
      .then(() => boxChatCaller(req.headers, process.env.AUTH_SECRET, getD1() as unknown as BoxDb))
      .catch(() => null);
    if (!ok) return notFound();
  } else if (!isDev((await authUserOrNull())?.email)) return notFound();
  return new Response(STATE_TREE_MD, {
    headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "no-store" },
  });
};
