/**
 * A SHA-256 Merkle tree over leaf hashes, with inclusion proofs.
 *
 * Domain-separated as in RFC 6962 (Certificate Transparency), so a leaf can
 * never pass for an inner node or the other way round:
 *   node(leaf)   = H(0x00 ‖ leaf)
 *   node(l, r)   = H(0x01 ‖ l ‖ r)
 * A level with an odd count carries its last node up unchanged (never
 * duplicated — duplicating lets two different leaf lists share a root).
 * The root of no leaves is H("") (e3b0c442…).
 *
 * Leaves are 32-byte hashes in hex, in the order given (callers sort them).
 */
import { type Bytes, concat, equalBytes, fromHex, isHash, sha256, toHex } from "./bytes";

/** One step up from a leaf: the sibling's hash, and which side it is on. */
export type ProofStep = { side: "L" | "R"; hash: string };

const LEAF = new Uint8Array([0]);
const NODE = new Uint8Array([1]);

const leafNode = (h: Bytes) => sha256(concat(LEAF, h));
const innerNode = (l: Bytes, r: Bytes) => sha256(concat(NODE, l, r));

function leafBytes(leaves: string[]): Bytes[] {
  return leaves.map((h) => {
    if (!isHash(h)) throw new Error("lian: a leaf is a 32-byte hex hash");
    return fromHex(h);
  });
}

/** Every level of the tree, leaves' nodes first, the root last. */
async function levels(leaves: string[]): Promise<Bytes[][]> {
  let level = await Promise.all(leafBytes(leaves).map(leafNode));
  const out = [level];
  while (level.length > 1) {
    const next: Bytes[] = [];
    for (let i = 0; i < level.length; i += 2)
      next.push(i + 1 < level.length ? await innerNode(level[i], level[i + 1]) : level[i]);
    out.push(next);
    level = next;
  }
  return out;
}

export async function merkleRoot(leaves: string[]): Promise<string> {
  if (leaves.length === 0) return toHex(await sha256(new Uint8Array()));
  const ls = await levels(leaves);
  return toHex(ls[ls.length - 1][0]);
}

/** The inclusion proof of `leaves[index]`, bottom up. */
export async function merkleProof(leaves: string[], index: number): Promise<ProofStep[]> {
  if (!Number.isInteger(index) || index < 0 || index >= leaves.length)
    throw new Error("lian: no leaf at that index");
  const ls = await levels(leaves);
  const proof: ProofStep[] = [];
  let i = index;
  for (const level of ls.slice(0, -1)) {
    const sib = i % 2 === 0 ? i + 1 : i - 1;
    if (sib < level.length) proof.push({ side: i % 2 === 0 ? "R" : "L", hash: toHex(level[sib]) });
    i = Math.floor(i / 2);
  }
  return proof;
}

/** Does `leaf` (hex hash) with `proof` lead to `root`? Never throws on bad input. */
export async function verifyProof(leaf: string, proof: ProofStep[], root: string): Promise<boolean> {
  if (!isHash(leaf) || !isHash(root) || !Array.isArray(proof)) return false;
  let at = await leafNode(fromHex(leaf));
  for (const step of proof) {
    if (!step || !isHash(step.hash) || (step.side !== "L" && step.side !== "R")) return false;
    const sib = fromHex(step.hash);
    at = step.side === "L" ? await innerNode(sib, at) : await innerNode(at, sib);
  }
  return equalBytes(at, fromHex(root));
}
