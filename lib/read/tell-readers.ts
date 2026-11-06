// Tell a user's open readers that a book changed (reader-stream.tsx), through
// lianki-push. A miss only means they update on the next change.
import { getCloudflareContext } from "@opennextjs/cloudflare";
import type { TailOp } from "./gdoc-tail";

export function tellReaders(
  userId: string,
  message: { book: string; hash: string } | { book: string; ops: TailOp[] },
) {
  try {
    const { env, ctx } = getCloudflareContext();
    const push = (env as unknown as { PUSH?: { fetch: typeof fetch } }).PUSH;
    if (!push) return;
    ctx.waitUntil(
      push
        .fetch("https://lianki-push/internal/read-stream", {
          method: "POST",
          body: JSON.stringify({ user: userId, ...message }),
        })
        .catch(() => undefined),
    );
  } catch {
    // Not on the Worker.
  }
}
