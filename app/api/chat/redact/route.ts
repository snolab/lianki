import { getCloudflareContext } from "@opennextjs/cloudflare";
import { authUserOrNull } from "@/app/signInEmail";
import { isDev } from "@/lib/permissions";
import { redactLine } from "@/lib/chat-redact-api";

/**
 * Delete one chat line of the caller's own thread (lib/chat-redact-api.ts;
 * docs/chat-history.md, "Deleting a line"). A session from a lianki.com page
 * only; never a token.
 */
export const dynamic = "force-dynamic";

type Fetcher = { fetch(url: string, init?: RequestInit): Promise<Response> };

/** lianki-push over the PUSH binding; null off the Worker. */
function push(): Fetcher | null {
  try {
    const { env } = getCloudflareContext();
    return (env as unknown as { PUSH?: Fetcher }).PUSH ?? null;
  } catch {
    return null;
  }
}

export const POST = (req: Request) =>
  redactLine(req, {
    who: async () => {
      const u = await authUserOrNull();
      return u?.id && u.email ? { id: u.id, dev: isDev(u.email) } : null;
    },
    push,
  });
