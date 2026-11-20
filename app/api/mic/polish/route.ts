import { authUserOrNull } from "@/app/signInEmail";
import { readConfig } from "@/lib/config-store";
import { dbBackend, getD1 } from "@/lib/d1";
import { readFlags } from "@/lib/flags-store";
import { handleMicPolish } from "@/lib/mic-polish";
import type { D1WithBatch } from "@/lib/payments/credits-store";
import { workersAiComplete } from "@/lib/read/gloss-server";
import { isWorkersAiConfigured } from "@/lib/workers-ai";

export const dynamic = "force-dynamic";

/**
 * A speech transcript polished by our Workers AI, paid from the caller's
 * credits with a daily maximum (lib/mic-polish.ts; docs/mic-polish-api.md).
 * 404 while the flag `mic.polish-api` is off. No CORS: the caller is the
 * otoji.org Worker, server to server; a cookie counts only from our own pages.
 */
export const POST = (req: Request) =>
  handleMicPolish(req, {
    flags: readFlags,
    d1: () => (dbBackend() === "d1" ? (getD1() as unknown as D1WithBatch) : null),
    config: () => readConfig(),
    session: async () => {
      const u = await authUserOrNull();
      return u?.id ? { id: u.id as string, email: u.email ?? null } : null;
    },
    complete: isWorkersAiConfigured() ? workersAiComplete : null,
  });
