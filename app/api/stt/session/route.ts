import { authUserOrNull } from "@/app/signInEmail";
import { cfg } from "@/lib/config-store";
import { dbBackend, getD1 } from "@/lib/d1";
import { flagOn } from "@/lib/flags-store";
import { sameOriginJsonPost } from "@/lib/security/same-origin";
import { importTicketKey } from "@/lib/stt-ticket";
import { cloudflareTurn, handleSttSession, type SttSessionDeps } from "@/lib/stt-worker/session";
import { sttAllowed, type SttDb } from "@/lib/stt-worker/store";

/**
 * A session on Lianki's speech servers (lib/stt-worker/session.ts;
 * docs/local-stt.md, "Lianki's speech servers for everyone"). 404 while the
 * flag stt.worker is off. GET: may this account use them (204 / 404). POST,
 * same-origin JSON only (else 404), so nothing caches or prefetches a ticket
 * and no other site can ask on a user's behalf.
 */
async function deps(sameOrigin: boolean): Promise<SttSessionDeps> {
  const db = dbBackend() === "d1" ? (getD1() as unknown as SttDb) : null;
  const user = await authUserOrNull();
  return {
    flag: async () => sameOrigin && (await flagOn("stt.worker")),
    user: user?.id ? { id: user.id } : null,
    allowed: (id) => (db ? sttAllowed(db, id) : Promise.resolve(false)),
    db,
    num: (k) => cfg(k),
    text: (k) => cfg(k),
    key: async () => {
      const raw = process.env.STT_TICKET_KEY;
      return raw ? importTicketKey(raw) : null;
    },
    turn: async () =>
      cloudflareTurn(
        {
          STT_TURN_KEY_ID: process.env.STT_TURN_KEY_ID,
          STT_TURN_KEY_TOKEN: process.env.STT_TURN_KEY_TOKEN,
        },
        await cfg("stt.worker.sessionMaxS"),
      ),
  };
}

export const GET = async (req: Request) => handleSttSession(req, await deps(true));

export const POST = async (req: Request) =>
  handleSttSession(req, await deps(sameOriginJsonPost(req)));
