/**
 * Voiceprint tickets from lianki.com (app/api/dev/voiceprint-ticket;
 * docs/local-stt.md, "Voiceprint: who may enrol and delete"). Status needs
 * the owner's session only; enrol and delete need the owner's passkey with
 * user verification (Face ID / Touch ID): the browser shows its own prompt,
 * which page code cannot answer for him. Minimal WebAuthn JSON plumbing, so
 * the widget needs no extra package.
 */

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
  if (!c) throw new Error("passkey cancelled");
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
}

/** A one-time voiceprint ticket for this op and device (status: no passkey). */
export async function voiceprintTicket(
  op: "status" | "enrol" | "delete",
  device: string,
  d: {
    fetch?: typeof fetch;
    creds?: Pick<CredentialsContainer, "get">;
    /** Enrol: keep the sentences' audio on the Mac, approved with the passkey. */
    keepAudio?: boolean;
  } = {},
): Promise<string> {
  const f = d.fetch ?? fetch;
  const post = async (body: object) => {
    const res = await f(VOICEPRINT_TICKET_PATH, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new Error(typeof j.error === "string" ? j.error : `HTTP ${res.status}`);
    return j;
  };
  if (op === "status") {
    const j = await post({ op });
    if (typeof j.ticket !== "string") throw new Error("no ticket");
    return j.ticket;
  }
  const keepAudio = op === "enrol" && d.keepAudio === true;
  const o = await post({ op, device, step: "options", keepAudio });
  const response = await getAssertion(o.options as OptionsJSON, d.creds ?? navigator.credentials);
  const j = await post({ op, device, step: "verify", token: o.token, response, keepAudio });
  if (typeof j.ticket !== "string") throw new Error("no ticket");
  return j.ticket;
}
