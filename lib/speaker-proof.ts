/**
 * The hub's check of a voice line's speaker attestation (docs/local-stt.md,
 * "Voiceprint: the signed speaker tag"). The owner's Mac signs each final's
 * speaker tag with an Ed25519 key only it holds (scripts/local-stt/voiceprint.py
 * Attestor); the page passes the signatures along with the line
 * (`speakerProof`), and the hub keeps a `speaker` tag on the stored line only
 * when every proof verifies with STT_SPEAKER_PUB, is fresh, was signed for
 * this thread, has never been used (burned durably by the hub), and the
 * signed texts, in order, ARE the line. A page can neither forge a tag nor
 * move one onto other words, nor drop or add a word. Future voice approvals
 * must rely on this verified tag, never on anything the page reports itself.
 *
 * Wire form of one proof: `<payload b64url>.<signature b64url>`, the signature
 * over the ASCII of the first part; payload
 * `{v:1, uid, thread, at (ms), text, decision, score, model, device, speechS, snrDb[, reason]}`.
 */
import { type SpeakerTag, cleanSpeaker, combineSpeaker } from "../packages/debug-chat/src/wire";

/** A proof older (or newer, clock skew) than this is refused; its uid stays burned this long. */
export const PROOF_WINDOW_MS = 10 * 60_000;
export const MAX_PROOFS = 8;
export const MAX_PROOF_LEN = 6000;
const UID = /^[A-Za-z0-9_-]{16,64}$/;

/**
 * The only differences allowed between the signed texts and the line, each
 * one meaning-neutral:
 * - Unicode NFKC (full-width ↔ half-width forms: ？ and ? are the same mark);
 * - whitespace runs collapsed to one space, and trimmed; utterances joined
 *   by a space or by nothing;
 * - one full stop appended: "。" or "." right after a signed text that has
 *   no final punctuation of its own (the mic's punctuate() adds it), and
 *   nothing else.
 * Signed punctuation is never stripped or substituted: a signed ？ must stay
 * ？ (not ！, not dropped), a signed … must stay …, and no ！ or ？ may be
 * added. Anything else (a word dropped, added or replaced, a negation
 * removed, a question made an order) leaves the line unverified.
 */
export const canon = (s: string) => s.normalize("NFKC").replace(/\s+/gu, " ").trim();
const ENDS_PUNCT = /\p{P}$/u;
const FULL_STOP = /^[。.]/u;

/** The line is exactly the signed texts, in order, up to the safe differences above. */
export function lineIsSigned(line: string, texts: string[]): boolean {
  const l = canon(line);
  let pos = 0;
  for (const [i, t] of texts.entries()) {
    const seg = canon(t);
    if (!seg) return false;
    if (i > 0 && l[pos] === " ") pos++;
    if (!l.startsWith(seg, pos)) return false;
    pos += seg.length;
    // The mic's own full stop, only where the signed text ended without punctuation.
    if (!ENDS_PUNCT.test(seg) && FULL_STOP.test(l.slice(pos))) pos++;
  }
  return pos === l.length && texts.length > 0;
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

/**
 * Burn these uids durably until `until` (ms): true when none was burned
 * before (and now all are), false when any was. The hub does it in Durable
 * Object storage, so a restart, hibernation or deploy forgets none.
 */
export type BurnProofs = (uids: string[], until: number) => Promise<boolean>;

/**
 * The verified tag for a line, or undefined (drop it). Burns the proofs'
 * uids only when everything else holds.
 */
export async function verifySpeakerProofs(
  proofs: string[] | undefined,
  lineText: string,
  thread: string,
  pubRaw: string | undefined,
  burn: BurnProofs,
  now = Date.now(),
): Promise<SpeakerTag | undefined> {
  if (!proofs?.length || !pubRaw) return undefined;
  let key: CryptoKey;
  try {
    key = await pubKey(pubRaw);
  } catch {
    return undefined;
  }
  const tags: SpeakerTag[] = [];
  const uids: string[] = [];
  const texts: string[] = [];
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
    if (!p || p.v !== 1 || typeof p.uid !== "string" || !UID.test(p.uid)) return undefined;
    if (typeof p.at !== "number" || Math.abs(now - p.at) > PROOF_WINDOW_MS) return undefined;
    // Signed for this thread (the page's hello to the Mac), and for nothing else.
    if (p.thread !== thread || typeof p.text !== "string" || uids.includes(p.uid)) return undefined;
    const tag = cleanSpeaker(p);
    if (!tag) return undefined;
    tags.push(tag);
    uids.push(p.uid);
    texts.push(p.text);
  }
  // The signed words must be the line's words, exactly, in order.
  if (!lineIsSigned(lineText, texts)) return undefined;
  if (!(await burn(uids, now + 2 * PROOF_WINDOW_MS))) return undefined;
  // The signed words themselves ride on the stored tag: a decision (a voice
  // approval later) must read these, never the displayed line.
  return { ...combineSpeaker(tags)!, signed: texts };
}
