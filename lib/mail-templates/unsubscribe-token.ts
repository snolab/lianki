/**
 * The one-click unsubscribe token of an `optional` mail kind (./kinds.ts;
 * docs/mail-templates.md, "Unsubscribe"): names one account and one mail
 * kind, and only the server can make one.
 *
 * `u1.<base64url(userId)>.<kind>.<HMAC-SHA256>`, the key derived (HKDF) from
 * AUTH_SECRET with its own label, so it is never the invite opt-out's key.
 * No expiry: an unsubscribe link in an old mail must keep working (RFC 8058).
 * What it can do is narrow: switch that one kind off or back on for that one
 * account. It never signs anyone in.
 */
const enc = new TextEncoder();
const keys = new Map<string, Promise<CryptoKey>>();

function unsubKey(secret: string | undefined): Promise<CryptoKey> {
  if (!secret || secret.length < 32)
    throw new Error("mail-unsubscribe: AUTH_SECRET missing or short");
  let k = keys.get(secret);
  if (!k) {
    k = (async () => {
      const ikm = await crypto.subtle.importKey("raw", enc.encode(secret), "HKDF", false, [
        "deriveKey",
      ]);
      return crypto.subtle.deriveKey(
        {
          name: "HKDF",
          hash: "SHA-256",
          salt: enc.encode("lianki/mail"),
          info: enc.encode("lianki/mail/unsubscribe/v1"),
        },
        ikm,
        { name: "HMAC", hash: "SHA-256", length: 256 },
        false,
        ["sign", "verify"],
      );
    })();
    keys.set(secret, k);
  }
  return k;
}

const b64url = (b: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(b)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const fromB64url = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

const KIND = /^[a-z][a-z0-9-]{0,39}$/;
const payload = (userId: string, kind: string) => `u1|${userId}|${kind}`;

/** A token for `userId` + `kind`. */
export async function signUnsubscribe(
  secret: string | undefined,
  userId: string,
  kind: string,
): Promise<string> {
  if (!userId || userId.length > 100 || !KIND.test(kind))
    throw new Error("mail-unsubscribe: bad input");
  const sig = await crypto.subtle.sign(
    "HMAC",
    await unsubKey(secret),
    enc.encode(payload(userId, kind)),
  );
  return `u1.${b64url(enc.encode(userId))}.${kind}.${b64url(sig)}`;
}

/** The account and kind a token names, or null when it is not one of ours. */
export async function verifyUnsubscribe(
  secret: string | undefined,
  token: unknown,
): Promise<{ userId: string; kind: string } | null> {
  if (typeof token !== "string" || token.length > 300) return null;
  const m = /^u1\.([A-Za-z0-9_-]{1,140})\.([a-z][a-z0-9-]{0,39})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!m) return null;
  try {
    const userId = new TextDecoder("utf-8", { fatal: true }).decode(fromB64url(m[1]!));
    const ok = await crypto.subtle.verify(
      "HMAC",
      await unsubKey(secret),
      fromB64url(m[3]!),
      enc.encode(payload(userId, m[2]!)),
    );
    return ok && userId ? { userId, kind: m[2]! } : null;
  } catch {
    return null;
  }
}

/**
 * The two links of one mail: the page a person opens (token in the fragment,
 * so no server log or Referer sees it) and the RFC 8058 endpoint the mail
 * client POSTs to (token in the query: a client POSTs the URL as it is).
 */
export function unsubscribeLinks(origin: string, locale: string, token: string) {
  const ui = locale === "zh-Hant" ? "zh" : locale;
  const t = encodeURIComponent(token);
  return {
    pageUrl: `${origin}/mail/unsubscribe?lang=${encodeURIComponent(ui)}#t=${t}`,
    oneClickUrl: `${origin}/api/mail/unsubscribe?t=${t}`,
  };
}

/** List-Unsubscribe with the https one-click URL and List-Unsubscribe-Post (RFC 8058). */
export const oneClickHeaders = (oneClickUrl: string): Record<string, string> => ({
  "List-Unsubscribe": `<${oneClickUrl}>`,
  "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
});
