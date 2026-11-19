/**
 * The hub's check of a voice line's speaker attestation (docs/local-stt.md,
 * "Voiceprint: the signed speaker tag"). The owner's Mac signs each final's
 * speaker tag with an Ed25519 key only it holds (scripts/local-stt/voiceprint.py
 * Attestor); the page passes the signatures along with the line
 * (`speakerProof`), and the hub keeps a `speaker` tag on the stored line only
 * when every proof verifies with a key of the ring (`STT_SPEAKER_PUBS`, or
 * `STT_SPEAKER_PUB` as `mac`), is fresh, was signed for
 * this thread, has never been used (burned durably by the hub), and the
 * signed texts, in order, ARE the line. A page can neither forge a tag nor
 * move one onto other words, nor drop or add a word. Future voice approvals
 * must rely on this verified tag, never on anything the page reports itself.
 *
 * Wire form of one proof: `<payload b64url>.<signature b64url>`, the signature
 * over the ASCII of the first part; payload
 * `{v:1, uid, thread, at (ms), text, decision, score, model, device, speechS, snrDb[, kid, reason, voice, cluster, clusterScore]}`.
 *
 * The key ring (docs/voiceprint-service.md, "Trust: who may sign"): `kid`
 * names the signer, inside the signed payload so it cannot be swapped. A
 * proof without `kid` is `mac` (every proof the Mac signs today). The stored
 * tag records the signer (`kid`) and its trust: `signed` when every proof
 * signed the line's words; a proof with `text: null` (a signer that did not
 * decode the words itself) keeps its tag only under `speaker.advisory`, with
 * the line's own decision `unknown`, so it never shows the check and never
 * backs an approval.
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

/** The signers the hub knows: the owner's Mac, and later Lianki's own voiceprint service. */
export const SPEAKER_KIDS = ["mac", "service"] as const;
export type SpeakerKid = (typeof SPEAKER_KIDS)[number];
/** Public keys (raw Ed25519, base64url) by signer. */
export type SpeakerKeyRing = Partial<Record<SpeakerKid, string>>;
const isKid = (k: unknown): k is SpeakerKid =>
  typeof k === "string" && (SPEAKER_KIDS as readonly string[]).includes(k);

/**
 * The hub's key ring from its env: `STT_SPEAKER_PUBS` (JSON `{"mac": "<b64>",
 * "service": "<b64>"}`; unknown signers and non-string keys are ignored), and
 * `STT_SPEAKER_PUB` as `mac` when the ring names no `mac` of its own. A ring
 * that is not JSON counts as absent (the single key still works). Undefined
 * when no key is set: then no tag is ever kept.
 */
export function speakerKeyRing(env: unknown): SpeakerKeyRing | undefined {
  const e = (env ?? {}) as { STT_SPEAKER_PUBS?: unknown; STT_SPEAKER_PUB?: unknown };
  const ring: SpeakerKeyRing = {};
  if (typeof e.STT_SPEAKER_PUBS === "string" && e.STT_SPEAKER_PUBS.trim()) {
    try {
      const j: unknown = JSON.parse(e.STT_SPEAKER_PUBS);
      if (j && typeof j === "object" && !Array.isArray(j))
        for (const [k, v] of Object.entries(j))
          if (isKid(k) && typeof v === "string" && v.trim()) ring[k] = v.trim();
    } catch {}
  }
  if (!ring.mac && typeof e.STT_SPEAKER_PUB === "string" && e.STT_SPEAKER_PUB.trim())
    ring.mac = e.STT_SPEAKER_PUB.trim();
  return Object.keys(ring).length ? ring : undefined;
}

const keyCache = new Map<string, CryptoKey>();
async function pubKey(raw: string): Promise<CryptoKey> {
  const hit = keyCache.get(raw);
  if (hit) return hit;
  const key = await crypto.subtle.importKey(
    "raw",
    fromB64url(raw.trim()) as BufferSource,
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  if (keyCache.size >= 8) keyCache.clear();
  keyCache.set(raw, key);
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
 * uids only when everything else holds. `keys`: the ring, or one key alone
 * (counted as `mac`).
 */
export async function verifySpeakerProofs(
  proofs: string[] | undefined,
  lineText: string,
  thread: string,
  keys: SpeakerKeyRing | string | undefined,
  burn: BurnProofs,
  now = Date.now(),
): Promise<SpeakerTag | undefined> {
  const ring: SpeakerKeyRing | undefined = typeof keys === "string" ? { mac: keys } : keys;
  if (!proofs?.length || !ring) return undefined;
  const tags: SpeakerTag[] = [];
  const uids: string[] = [];
  const texts: string[] = [];
  const kids = new Set<SpeakerKid>();
  let unbound = false;
  for (const proof of proofs) {
    const parts = proof.split(".");
    if (parts.length !== 2) return undefined;
    let p: Record<string, unknown>;
    try {
      p = JSON.parse(new TextDecoder().decode(fromB64url(parts[0]!)));
      if (!p || typeof p !== "object") return undefined;
      // The signer, from the signed payload itself; none = the Mac (every proof before the ring).
      const kid = p.kid === undefined ? "mac" : p.kid;
      if (!isKid(kid)) return undefined;
      const raw = ring[kid];
      if (!raw) return undefined;
      const ok = await crypto.subtle.verify(
        { name: "Ed25519" },
        await pubKey(raw),
        fromB64url(parts[1]!) as BufferSource,
        new TextEncoder().encode(parts[0]!),
      );
      if (!ok) return undefined;
      kids.add(kid);
    } catch {
      return undefined;
    }
    if (p.v !== 1 || typeof p.uid !== "string" || !UID.test(p.uid)) return undefined;
    if (typeof p.at !== "number" || Math.abs(now - p.at) > PROOF_WINDOW_MS) return undefined;
    // Signed for this thread (the page's hello to the Mac), and for nothing else.
    if (p.thread !== thread || uids.includes(p.uid)) return undefined;
    // `text: null`: the signer did not decode these words itself (speaker only).
    if (p.text === null) unbound = true;
    else if (typeof p.text !== "string") return undefined;
    const tag = cleanSpeaker(p);
    if (!tag) return undefined;
    tags.push(tag);
    uids.push(p.uid);
    if (typeof p.text === "string") texts.push(p.text);
  }
  // The signed words must be the line's words, exactly, in order.
  if (!unbound && !lineIsSigned(lineText, texts)) return undefined;
  if (!(await burn(uids, now + 2 * PROOF_WINDOW_MS))) return undefined;
  const kid = [...kids].sort().join("+");
  const tag = combineSpeaker(tags)!;
  // Speaker only, not these words: advisory. The line itself stays undecided,
  // so no check, no merge as his and no approval rests on it.
  if (unbound)
    return { decision: "unknown", reason: "advisory", trust: "advisory", kid, advisory: tag };
  // The signed words themselves ride on the stored tag: a decision (a voice
  // approval later) must read these, never the displayed line.
  return { ...tag, trust: "signed", kid, signed: texts };
}
