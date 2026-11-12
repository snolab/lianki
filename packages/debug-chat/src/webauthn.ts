/**
 * Voiceprint tickets from lianki.com (app/api/dev/voiceprint-ticket;
 * docs/local-stt.md, "Voiceprint: who may enrol and delete"). Status needs
 * the owner's session only; enrol and delete need the owner's passkey with
 * user verification (Face ID / Touch ID): the browser shows its own prompt,
 * which page code cannot answer for him. One approval then covers every
 * voiceprint op on this device for `voiceprint.passkeyWindowMs` (the passkey
 * window below; docs/local-stt.md, "One approval for ten minutes"). Minimal
 * WebAuthn JSON plumbing, so the widget needs no extra package.
 */

import { reportPageError } from "./page-errors";

export const VOICEPRINT_TICKET_PATH = "/api/dev/voiceprint-ticket";

const toBuf = (s: string): ArrayBuffer => {
  const p = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(p + "=".repeat((4 - (p.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0)).buffer;
};
const toB64url = (b: ArrayBuffer | null | undefined): string => {
  if (!b) return "";
  let s = "";
  for (const x of new Uint8Array(b)) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

type OptionsJSON = {
  challenge: string;
  rpId?: string;
  timeout?: number;
  userVerification?: UserVerificationRequirement;
  allowCredentials?: { id: string; type: "public-key"; transports?: string[] }[];
};

/** The browser's passkey prompt for these options; the assertion as JSON for the server. */
export async function getAssertion(
  o: OptionsJSON,
  creds: Pick<CredentialsContainer, "get"> = navigator.credentials,
): Promise<Record<string, unknown>> {
  try {
    const c = (await creds.get({
      publicKey: {
        challenge: toBuf(o.challenge),
        rpId: o.rpId,
        timeout: o.timeout,
        userVerification: o.userVerification ?? "required",
        allowCredentials: (o.allowCredentials ?? []).map((a) => ({
          id: toBuf(a.id),
          type: "public-key" as const,
          ...(a.transports ? { transports: a.transports as AuthenticatorTransport[] } : {}),
        })),
      },
    })) as PublicKeyCredential | null;
    if (!c) {
      reportPageError({ kind: "voiceprint", message: "passkey cancelled by user or window" });
      throw new Error("passkey cancelled");
    }
    const r = c.response as AuthenticatorAssertionResponse;
    return {
      id: c.id,
      rawId: toB64url(c.rawId),
      type: c.type,
      response: {
        clientDataJSON: toB64url(r.clientDataJSON),
        authenticatorData: toB64url(r.authenticatorData),
        signature: toB64url(r.signature),
        ...(r.userHandle ? { userHandle: toB64url(r.userHandle) } : {}),
      },
      clientExtensionResults: c.getClientExtensionResults?.() ?? {},
      ...(c.authenticatorAttachment ? { authenticatorAttachment: c.authenticatorAttachment } : {}),
    };
  } catch (err: any) {
    const msg = err instanceof Error ? err.message : String(err);
    reportPageError({
      kind: "voiceprint",
      message: `WebAuthn getAssertion failed: ${msg} (rpId=${o.rpId ?? "default"}, timeout=${o.timeout ?? "default"})`,
      stack: err instanceof Error ? err.stack : undefined,
    });
    throw err;
  }
}

export type VoiceprintTicketOp = "status" | "enrol" | "delete" | "delete-audio" | "export" | "restore";

/**
 * The passkey window (docs/local-stt.md, "One approval for ten minutes"): the
 * grant the last verified assertion gave this page, so the voiceprint ops that
 * follow need no new Face ID until it ends. In this module's memory only:
 * never in storage or on globalThis, so a reload (a sign-out reloads too)
 * drops it, and lianki.com refuses it from any other session or device.
 * It covers voiceprint tickets and nothing else.
 */
let held: { grant: string; exp: number; client: string } | null = null;
const windowSubs = new Set<() => void>();
const changed = () => {
  for (const f of windowSubs) f();
};
/** Until when (ms) one approval still covers voiceprint ops on this page, or null. */
export function voiceprintWindow(now = Date.now()): number | null {
  if (held && held.exp * 1000 <= now) {
    held = null;
    changed();
  }
  return held ? held.exp * 1000 : null;
}
/** End the window now ("End now" in the panel; a sign-out): the next op asks for the passkey. */
export function endVoiceprintWindow(): void {
  if (!held) return;
  held = null;
  changed();
}
/** The window opened or ended; returns an unsubscribe. */
export function subscribeVoiceprintWindow(f: () => void): () => void {
  windowSubs.add(f);
  return () => void windowSubs.delete(f);
}
/** A grant this close to its end is not used: the ticket would expire on the way to the Mac. */
const WINDOW_MARGIN_MS = 5_000;

/**
 * A one-time voiceprint ticket for this op and device (status: no passkey).
 * Inside the passkey window, from the grant with no prompt; otherwise (or if
 * lianki.com refuses the grant) the passkey prompt, which opens a new window.
 */
export async function voiceprintTicket(
  op: VoiceprintTicketOp,
  device: string,
  d: {
    fetch?: typeof fetch;
    creds?: Pick<CredentialsContainer, "get">;
    /** Enrol: keep the sentences' audio on the Mac, approved with the passkey. */
    keepAudio?: boolean;
    /** This page's device slug: the grant is bound to it. */
    client?: string;
    now?: () => number;
  } = {},
): Promise<string> {
  const f = d.fetch ?? fetch;
  const now = d.now ?? Date.now;
  const post = async (body: object) => {
    const res = await f(VOICEPRINT_TICKET_PATH, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw Object.assign(new Error(typeof j.error === "string" ? j.error : `HTTP ${res.status}`), { status: res.status });
    return j;
  };
  if (op === "status") {
    const j = await post({ op });
    if (typeof j.ticket !== "string") throw new Error("no ticket");
    return j.ticket;
  }
  const keepAudio = op === "enrol" && d.keepAudio === true;
  const client = d.client;
  const g = held;
  if (g && client && g.client === client && g.exp * 1000 - now() > WINDOW_MARGIN_MS) {
    try {
      const j = await post({ op, device, step: "grant", grant: g.grant, client, keepAudio });
      if (typeof j.ticket === "string") return j.ticket;
    } catch (e) {
      // Refused (the window ended, another session, the config shortened it): ask again.
      if ((e as { status?: number }).status !== 401) throw e;
    }
    if (held === g) endVoiceprintWindow();
  }
  const o = await post({ op, device, step: "options", keepAudio });
  const response = await getAssertion(o.options as OptionsJSON, d.creds ?? navigator.credentials);
  const j = await post({
    op,
    device,
    step: "verify",
    token: o.token,
    response,
    keepAudio,
    ...(client ? { client } : {}),
  });
  if (typeof j.ticket !== "string") throw new Error("no ticket");
  if (client && typeof j.grant === "string" && typeof j.grantExp === "number") {
    held = { grant: j.grant, exp: j.grantExp, client };
    changed();
  }
  return j.ticket;
}
