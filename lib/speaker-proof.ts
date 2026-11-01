/**
 * The hub's check of a voice line's speaker attestation (docs/local-stt.md,
 * "Voiceprint: the signed speaker tag"). The owner's Mac signs each final's
 * speaker tag with an Ed25519 key only it holds (scripts/local-stt/voiceprint.py
 * Attestor); the page passes the signatures along with the line
 * (`speakerProof`), and the hub keeps a `speaker` tag on the stored line only
 * when every proof verifies with STT_SPEAKER_PUB, is fresh and unused, and
 * the signed texts make up the line. A page can neither forge a tag nor move
 * one onto other words. Future voice approvals must rely on this verified tag,
 * never on anything the page reports itself.
 *
 * Wire form of one proof: `<payload b64url>.<signature b64url>`, the signature
 * over the ASCII of the first part; payload
 * `{v:1, uid, at (ms), text, decision, score, model, device, speechS, snrDb[, reason]}`.
 */
import { type SpeakerTag, cleanSpeaker, combineSpeaker } from "../packages/debug-chat/src/wire";

/** A proof older (or newer, clock skew) than this is refused. */
export const PROOF_WINDOW_MS = 10 * 60_000;
export const MAX_PROOFS = 8;
export const MAX_PROOF_LEN = 6000;
/** Longest line (normalised characters) checked; a longer one carries no tag. */
export const MAX_LINE = 1500;
/** The signed texts must cover at least this share of the line. */
export const COVER = 0.8;

/** Letters and digits only, NFKC, lower case: punctuation, spaces and width do not count. */
export const normText = (s: string) =>
  s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");

/** Longest common subsequence length (O(n·m), both capped). */
export function lcs(a: string, b: string): number {
  const A = [...a];
  const B = [...b];
  const row = new Array<number>(B.length + 1).fill(0);
  for (let i = 1; i <= A.length; i++) {
    let diag = 0;
    for (let j = 1; j <= B.length; j++) {
      const up = row[j]!;
      row[j] = A[i - 1] === B[j - 1] ? diag + 1 : Math.max(row[j]!, row[j - 1]!);
      diag = up;
    }
  }
  return row[B.length]!;
}

/** The page's proofs from the wire: strings only, bounded. */
export function cleanProofs(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = raw
    .filter((p): p is string => typeof p === "string" && p.length > 0 && p.length <= MAX_PROOF_LEN)
    .slice(0, MAX_PROOFS);
  return out.length ? out : undefined;
}

const fromB64url = (s: string) => {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("not base64url");
  const p = s.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(p + "=".repeat((4 - (p.length % 4)) % 4)), (c) => c.charCodeAt(0));
};

let keyCache: { raw: string; key: CryptoKey } | null = null;
async function pubKey(raw: string): Promise<CryptoKey> {
  if (keyCache?.raw === raw) return keyCache.key;
  const key = await crypto.subtle.importKey(
    "raw",
    fromB64url(raw.trim()) as BufferSource,
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  keyCache = { raw, key };
  return key;
}

/** uid → when it was used, so one proof serves one line only. */
export type SeenProofs = Map<string, number>;

/**
 * The verified tag for a line, or undefined (drop it). `seen` is updated
 * only when the whole set verifies.
 */
export async function verifySpeakerProofs(
  proofs: string[] | undefined,
  lineText: string,
  pubRaw: string | undefined,
  seen: SeenProofs,
  now = Date.now(),
): Promise<SpeakerTag | undefined> {
  if (!proofs?.length || !pubRaw) return undefined;
  for (const [u, t] of seen) if (t + 2 * PROOF_WINDOW_MS < now) seen.delete(u);
  let key: CryptoKey;
  try {
    key = await pubKey(pubRaw);
  } catch {
    return undefined;
  }
  const tags: SpeakerTag[] = [];
  const uids: string[] = [];
  let texts = "";
  for (const proof of proofs) {
    const parts = proof.split(".");
    if (parts.length !== 2) return undefined;
    let p: Record<string, unknown>;
    try {
      const ok = await crypto.subtle.verify(
        { name: "Ed25519" },
        key,
        fromB64url(parts[1]!) as BufferSource,
        new TextEncoder().encode(parts[0]!),
      );
      if (!ok) return undefined;
      p = JSON.parse(new TextDecoder().decode(fromB64url(parts[0]!)));
    } catch {
      return undefined;
    }
    if (!p || p.v !== 1 || typeof p.uid !== "string" || typeof p.at !== "number") return undefined;
    if (typeof p.text !== "string" || Math.abs(now - p.at) > PROOF_WINDOW_MS) return undefined;
    if (seen.has(p.uid) || uids.includes(p.uid)) return undefined;
    const tag = cleanSpeaker(p);
    if (!tag) return undefined;
    tags.push(tag);
    uids.push(p.uid);
    texts += normText(p.text);
  }
  // The signed words must be the line's words: no tag moves onto other text.
  const line = normText(lineText);
  if (!line || line.length > MAX_LINE || texts.length > MAX_LINE * 2) return undefined;
  if (lcs(line, texts) < Math.ceil(line.length * COVER)) return undefined;
  for (const u of uids) seen.set(u, now);
  return combineSpeaker(tags);
}
