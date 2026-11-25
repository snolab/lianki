import { getCloudflareContext } from "@opennextjs/cloudflare";
import { authUserOrNull } from "@/app/signInEmail";
import { chatSites } from "@/lib/chat-sites-route";
import { readFlags } from "@/lib/flags-store";
import type { SiteThread } from "@/lib/li-thread";
import { isDev } from "@/lib/permissions";

export const dynamic = "force-dynamic";

type Fetcher = { fetch(url: string, init?: RequestInit): Promise<Response> };

/** lianki-push over the PUSH binding (lib/push-friends.ts); null off the Worker. */
function push(): Fetcher | null {
  try {
    const { env } = getCloudflareContext();
    return (env as unknown as { PUSH?: Fetcher }).PUSH ?? null;
  } catch {
    return null;
  }
}

/** The account's Li chats per website (lib/chat-sites-route.ts). */
export const GET = (req: Request) =>
  chatSites(req, {
    who: async () => {
      const u = await authUserOrNull();
      return u?.id && u.email ? { id: u.id, owner: isDev(u.email) } : null;
    },
    flags: () => readFlags(),
    list: async (base) => {
      const p = push();
      if (!p) return null;
      const res = await p.fetch(
        `https://lianki-push/internal/sub-threads?base=${encodeURIComponent(base)}`,
      );
      if (!res.ok) return null;
      return ((await res.json()) as { threads?: SiteThread[] }).threads ?? [];
    },
  });
