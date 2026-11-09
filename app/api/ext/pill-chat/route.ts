import { authUserOrNull } from "@/app/signInEmail";
import { dbBackend, getD1 } from "@/lib/d1";
import type { D1Like } from "@/lib/d1/types";
import { readFlags } from "@/lib/flags-store";
import { isDev } from "@/lib/permissions";
import { refreshPermissions } from "@/lib/permission-store";
import { pillChatState } from "@/lib/pill-chat-route";

export const dynamic = "force-dynamic";

/** Li chat from the userscript pill: on for this account? lib/pill-chat-route.ts. */
export const GET = (req: Request) =>
  pillChatState(req, {
    backend: dbBackend,
    d1: () => getD1() as unknown as D1Like,
    sessionEmail: async () => (await authUserOrNull())?.email ?? null,
    isDev: async (email) => {
      await refreshPermissions();
      return isDev(email);
    },
    flags: () => readFlags(),
  });
