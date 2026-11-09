/**
 * OpenTimestamps (https://opentimestamps.org) receipts for a chain hash: the
 * small subset of the format a stamp and an upgrade need, written from the
 * spec of the reference client (python-opentimestamps, core/serialize.py,
 * core/timestamp.py, core/op.py, core/notary.py).
 *
 * A detached .ots file:
 *   MAGIC ‖ varuint(1) ‖ 0x08 (sha256) ‖ digest(32) ‖ timestamp
 * timestamp = items, each but the last prefixed by 0xff; an item is either
 *   0x00 ‖ attestation   (tag(8) ‖ varbytes(payload))
 *   op ‖ timestamp        (the op applied to this message)
 * The digest we stamp is the chain hash itself, so `ots verify -d <chainHash>
 * <day>.ots` checks it with the reference client.
 *
 * Calendars: POST <cal>/digest with the 32 raw bytes answers a timestamp that
 * ends in a pending attestation (the calendar's URL); hours later
 * GET <url>/timestamp/<hex commitment> answers the path to a Bitcoin block.
 */
import { type Bytes, concat, equalBytes, fromHex, sha256, toHex, utf8 } from "./bytes";

export const OTS_CALENDARS = [
  "https://a.pool.opentimestamps.org",
  "https://b.pool.opentimestamps.org",
  "https://a.pool.eternitywall.com",
  "https://ots.btc.catallaxy.com",
];

const MAGIC = concat(
  new Uint8Array([0]),
  utf8("OpenTimestamps"),
  new Uint8Array([0, 0]),
  utf8("Proof"),
  new Uint8Array([0, 0xbf, 0x89, 0xe2, 0xe8, 0x84, 0xe8, 0x92, 0x94]),
);
const PENDING = fromHex("83dfe30d2ef90c8e");
const BITCOIN = fromHex("0588960d73d71901");

const OP_SHA256 = 0x08;
const OP_SHA1 = 0x02;
const OP_APPEND = 0xf0;
const OP_PREPEND = 0xf1;
const OP_REVERSE = 0xf2;
const OP_HEXLIFY = 0xf3;
const BINARY = new Set([OP_APPEND, OP_PREPEND]);
const UNARY = new Set([OP_SHA256, OP_SHA1, OP_REVERSE, OP_HEXLIFY, 0x03, 0x67]);

export type Attestation =
  | { kind: "pending"; uri: string }
  | { kind: "bitcoin"; height: number }
  | { kind: "unknown"; tag: string; payload: Bytes };

export type Op = { tag: number; arg?: Bytes };

export type Timestamp = {
  msg: Bytes;
  attestations: Attestation[];
  ops: { op: Op; stamp: Timestamp }[];
};

// ---------------------------------------------------------------- ops

async function applyOp(op: Op, msg: Bytes): Promise<Bytes> {
  switch (op.tag) {
    case OP_APPEND:
      return concat(msg, op.arg!);
    case OP_PREPEND:
      return concat(op.arg!, msg);
    case OP_SHA256:
      return sha256(msg);
    case OP_SHA1:
      return new Uint8Array(await crypto.subtle.digest("SHA-1", msg as BufferSource));
    case OP_REVERSE:
      return msg.slice().reverse();
    case OP_HEXLIFY:
      return utf8(toHex(msg));
    default:
      // ripemd160 / keccak256: not in Web Crypto, and no calendar path uses them.
      throw new Error(`ots: op 0x${op.tag.toString(16)} not supported`);
  }
}

const sameOp = (a: Op, b: Op) =>
  a.tag === b.tag && (a.arg && b.arg ? equalBytes(a.arg, b.arg) : !a.arg && !b.arg);

// ---------------------------------------------------------------- bytes in / out

class Reader {
  at = 0;
  constructor(private readonly b: Bytes) {}
  byte(): number {
    if (this.at >= this.b.length) throw new Error("ots: truncated");
    return this.b[this.at++];
  }
  bytes(n: number): Bytes {
    if (this.at + n > this.b.length) throw new Error("ots: truncated");
    const out = this.b.slice(this.at, this.at + n);
    this.at += n;
    return out;
  }
  varuint(): number {
    let v = 0;
    let shift = 0;
    for (;;) {
      const b = this.byte();
      v += (b & 0x7f) * 2 ** shift;
      if (!(b & 0x80)) return v;
      shift += 7;
      if (shift > 49) throw new Error("ots: varuint too long");
    }
  }
  varbytes(max = 8192): Bytes {
    const n = this.varuint();
    if (n > max) throw new Error("ots: too long");
    return this.bytes(n);
  }
  done(): boolean {
    return this.at === this.b.length;
  }
}

function varuint(n: number): Bytes {
  const out: number[] = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    out.push(b);
  } while (n > 0);
  return new Uint8Array(out);
}

const varbytes = (b: Bytes) => concat(varuint(b.length), b);

function readAttestation(r: Reader): Attestation {
  const tag = r.bytes(8);
  const raw = r.varbytes();
  const payload = new Reader(raw);
  if (equalBytes(tag, PENDING)) {
    const uri = new TextDecoder().decode(payload.varbytes(1000));
    if (!/^https:\/\/[A-Za-z0-9.\-:/_]+$/.test(uri)) throw new Error("ots: bad calendar uri");
    return { kind: "pending", uri };
  }
  if (equalBytes(tag, BITCOIN)) return { kind: "bitcoin", height: payload.varuint() };
  return { kind: "unknown", tag: toHex(tag), payload: raw };
}

function writeAttestation(a: Attestation): Bytes {
  if (a.kind === "pending") return concat(PENDING, varbytes(varbytes(utf8(a.uri))));
  if (a.kind === "bitcoin") return concat(BITCOIN, varbytes(varuint(a.height)));
  return concat(fromHex(a.tag), varbytes(a.payload));
}

async function readTimestamp(r: Reader, msg: Bytes, depth = 0): Promise<Timestamp> {
  if (depth > 256) throw new Error("ots: too deep");
  const t: Timestamp = { msg, attestations: [], ops: [] };
  const item = async (tag: number) => {
    if (tag === 0x00) {
      t.attestations.push(readAttestation(r));
      return;
    }
    let op: Op;
    if (BINARY.has(tag)) op = { tag, arg: r.varbytes(4096) };
    else if (UNARY.has(tag)) op = { tag };
    else throw new Error(`ots: unknown op 0x${tag.toString(16)}`);
    t.ops.push({ op, stamp: await readTimestamp(r, await applyOp(op, msg), depth + 1) });
  };
  let tag = r.byte();
  while (tag === 0xff) {
    await item(r.byte());
    tag = r.byte();
  }
  await item(tag);
  return t;
}

function writeTimestamp(t: Timestamp): Bytes {
  const items: Bytes[] = [
    ...t.attestations.map((a) => concat(new Uint8Array([0]), writeAttestation(a))),
    ...t.ops.map(({ op, stamp }) =>
      concat(new Uint8Array([op.tag]), op.arg ? varbytes(op.arg) : new Uint8Array(), writeTimestamp(stamp)),
    ),
  ];
  if (!items.length) throw new Error("ots: empty timestamp");
  return concat(...items.flatMap((b, i) => (i < items.length - 1 ? [new Uint8Array([0xff]), b] : [b])));
}

/** Merge `b` (a timestamp of the same message) into `a`. */
function merge(a: Timestamp, b: Timestamp): void {
  for (const att of b.attestations)
    if (!a.attestations.some((x) => JSON.stringify(x) === JSON.stringify(att))) a.attestations.push(att);
  for (const o of b.ops) {
    const mine = a.ops.find((x) => sameOp(x.op, o.op));
    if (mine) merge(mine.stamp, o.stamp);
    else a.ops.push(o);
  }
}

// ---------------------------------------------------------------- files

export type OtsFile = { digest: Bytes; timestamp: Timestamp };

export function serializeOts(f: OtsFile): Bytes {
  return concat(MAGIC, varuint(1), new Uint8Array([OP_SHA256]), f.digest, writeTimestamp(f.timestamp));
}

export async function parseOts(b: Bytes): Promise<OtsFile> {
  const r = new Reader(b);
  if (!equalBytes(r.bytes(MAGIC.length), MAGIC)) throw new Error("ots: not an .ots file");
  if (r.varuint() !== 1) throw new Error("ots: unknown version");
  if (r.byte() !== OP_SHA256) throw new Error("ots: only sha256 files");
  const digest = r.bytes(32);
  const timestamp = await readTimestamp(r, digest);
  if (!r.done()) throw new Error("ots: trailing bytes");
  return { digest, timestamp };
}

/** Every attestation in the tree with the message it attests. */
export function attestations(t: Timestamp): { msg: Bytes; att: Attestation }[] {
  return [
    ...t.attestations.map((att) => ({ msg: t.msg, att })),
    ...t.ops.flatMap((o) => attestations(o.stamp)),
  ];
}

/** "bitcoin" once any branch reaches a block; else "pending". */
export function otsStatus(f: OtsFile): { status: "bitcoin" | "pending"; height: number | null } {
  const heights = attestations(f.timestamp)
    .map((x) => (x.att.kind === "bitcoin" ? x.att.height : null))
    .filter((h): h is number => h !== null);
  return heights.length
    ? { status: "bitcoin", height: Math.min(...heights) }
    : { status: "pending", height: null };
}

// ---------------------------------------------------------------- calendars

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const HEADERS = { Accept: "application/vnd.opentimestamps.v1", "User-Agent": "lianki-lian" };

/**
 * Submit `digest` (a chain hash, 32 bytes hex) to each calendar; the answers
 * become one .ots file. At least `min` calendars must answer.
 */
export async function stamp(
  digestHex: string,
  { calendars = OTS_CALENDARS, fetch: f = fetch, min = 1 }: { calendars?: string[]; fetch?: Fetch; min?: number } = {},
): Promise<{ ots: Bytes; answered: string[]; failed: string[] }> {
  const digest = fromHex(digestHex);
  if (digest.length !== 32) throw new Error("ots: a digest is 32 bytes");
  const root: Timestamp = { msg: digest, attestations: [], ops: [] };
  const answered: string[] = [];
  const failed: string[] = [];
  for (const cal of calendars) {
    try {
      const res = await f(`${cal}/digest`, { method: "POST", headers: HEADERS, body: digest as BodyInit });
      if (!res.ok) throw new Error(String(res.status));
      const r = new Reader(new Uint8Array(await res.arrayBuffer()));
      merge(root, await readTimestamp(r, digest));
      answered.push(cal);
    } catch {
      failed.push(cal);
    }
  }
  if (answered.length < Math.max(1, min)) throw new Error(`ots: ${answered.length} calendars answered`);
  return { ots: serializeOts({ digest, timestamp: root }), answered, failed };
}

/**
 * Ask each pending calendar for the path to a Bitcoin block; a branch that
 * has one replaces its pending attestation. Unchanged when no calendar has
 * it yet (a few hours after a stamp).
 */
export async function upgrade(
  ots: Bytes,
  { fetch: f = fetch }: { fetch?: Fetch } = {},
): Promise<{ ots: Bytes; changed: boolean; status: "bitcoin" | "pending"; height: number | null }> {
  const file = await parseOts(ots);
  let changed = false;
  const walk = async (t: Timestamp) => {
    for (const o of t.ops) await walk(o.stamp);
    for (const att of [...t.attestations]) {
      if (att.kind !== "pending") continue;
      try {
        const res = await f(`${att.uri}/timestamp/${toHex(t.msg)}`, { headers: HEADERS });
        if (!res.ok) continue;
        const got = await readTimestamp(new Reader(new Uint8Array(await res.arrayBuffer())), t.msg);
        if (!attestations(got).some((x) => x.att.kind === "bitcoin")) continue;
        t.attestations = t.attestations.filter((x) => x !== att);
        merge(t, got);
        changed = true;
      } catch {
        // that calendar is down or answered nonsense: try again later
      }
    }
  };
  await walk(file.timestamp);
  return { ots: changed ? serializeOts(file) : ots, changed, ...otsStatus(file) };
}
