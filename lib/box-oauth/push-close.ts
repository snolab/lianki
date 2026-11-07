/**
 * A box lost box:chat (removed, or the box revoked): tell lianki-push's hub,
 * over the PUSH service binding, to close that box's chat sockets now
 * (docs/box-oauth.md, "Chat on the owner's box"). Best effort and never
 * throws: the hub also asks the main Worker (DebugSessions.boxChat) before it
 * takes each line from a box socket, so a lost notice leaves a socket that can
 * say nothing. Only the client id is sent.
 */
import { getCloudflareContext } from "@opennextjs/cloudflare";

type Fetcher = { fetch(url: string, init?: RequestInit): Promise<Response> };

export const BOX_CLOSED_URL = "https://lianki-push/internal/box-closed";

export async function notifyBoxClosed(
  clientId: string,
  push: Fetcher | null = pushBinding(),
): Promise<boolean> {
  if (!push) {
    console.error(JSON.stringify({ event: "box.closed-notice", ok: false, why: "no binding" }));
    return false;
  }
  try {
    const res = await push.fetch(BOX_CLOSED_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client: clientId }),
    });
    if (!res.ok)
      console.error(JSON.stringify({ event: "box.closed-notice", ok: false, status: res.status }));
    return res.ok;
  } catch (e) {
    console.error(
      JSON.stringify({ event: "box.closed-notice", ok: false, why: String(e).slice(0, 160) }),
    );
    return false;
  }
}

function pushBinding(): Fetcher | null {
  try {
    return ((getCloudflareContext().env as { PUSH?: Fetcher }).PUSH ?? null) as Fetcher | null;
  } catch {
    return null;
  }
}
