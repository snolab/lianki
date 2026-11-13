/**
 * A zip archive written as a stream, one entry at a time (docs/recordings.md,
 * "Download a day"). Entries are STORED (no compression: WAV hardly
 * compresses, and a Worker's CPU is better spent decrypting), so each one is
 * its local header, its bytes and nothing else; the central directory follows
 * the last. The stream is pull-based: the next entry is asked for only when
 * the reader wants more, so memory holds one entry at a time, never the day.
 *
 * Plain zip, not zip64: at most ZIP_LIMITS.entries entries and
 * ZIP_LIMITS.bytes bytes in all; past either the stream errors rather than
 * writing a broken archive (the caller checks the totals first).
 */

export const ZIP_LIMITS = {
  /** The classic format's entry count limit. */
  entries: 65_535,
  /** Every offset and size must fit 32 bits; kept a little under. */
  bytes: 0xffff_0000,
} as const;

export type ZipEntry = { name: string; data: Uint8Array; at?: Date };

let table: Uint32Array | null = null;
/** CRC-32 (IEEE), as zip wants it. */
export function crc32(b: Uint8Array): number {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = table[(c ^ b[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** DOS time and date of `d` (UTC: the archive carries no zone). */
function dos(d: Date): { time: number; date: number } {
  const y = Math.max(1980, d.getUTCFullYear());
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
    date: ((y - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

const enc = new TextEncoder();

/** The archive of `entries` (any iterable, sync or async) as a byte stream. */
export function zipStream(
  entries: AsyncIterable<ZipEntry> | Iterable<ZipEntry>,
): ReadableStream<Uint8Array> {
  const it =
    Symbol.asyncIterator in entries
      ? (entries as AsyncIterable<ZipEntry>)[Symbol.asyncIterator]()
      : (entries as Iterable<ZipEntry>)[Symbol.iterator]();
  const central: Uint8Array[] = [];
  let offset = 0;
  let count = 0;
  return new ReadableStream<Uint8Array>({
    async pull(ctl) {
      const next = await it.next();
      if (next.done) {
        let size = 0;
        for (const c of central) {
          ctl.enqueue(c);
          size += c.length;
        }
        const end = new Uint8Array(22);
        const v = new DataView(end.buffer);
        v.setUint32(0, 0x06054b50, true);
        v.setUint16(8, count, true);
        v.setUint16(10, count, true);
        v.setUint32(12, size, true);
        v.setUint32(16, offset, true);
        ctl.enqueue(end);
        ctl.close();
        return;
      }
      const { name, data, at } = next.value;
      const nm = enc.encode(name);
      if (
        ++count > ZIP_LIMITS.entries ||
        offset + 30 + nm.length + data.length > ZIP_LIMITS.bytes
      ) {
        ctl.error(new Error("zip: too large"));
        return;
      }
      const crc = crc32(data);
      const { time, date } = dos(at ?? new Date(0));
      const head = new Uint8Array(30 + nm.length);
      const h = new DataView(head.buffer);
      h.setUint32(0, 0x04034b50, true);
      h.setUint16(4, 20, true);
      h.setUint16(6, 0x0800, true); // UTF-8 names
      h.setUint16(10, time, true);
      h.setUint16(12, date, true);
      h.setUint32(14, crc, true);
      h.setUint32(18, data.length, true);
      h.setUint32(22, data.length, true);
      h.setUint16(26, nm.length, true);
      head.set(nm, 30);
      const cd = new Uint8Array(46 + nm.length);
      const c = new DataView(cd.buffer);
      c.setUint32(0, 0x02014b50, true);
      c.setUint16(4, 20, true);
      c.setUint16(6, 20, true);
      c.setUint16(8, 0x0800, true);
      c.setUint16(12, time, true);
      c.setUint16(14, date, true);
      c.setUint32(16, crc, true);
      c.setUint32(20, data.length, true);
      c.setUint32(24, data.length, true);
      c.setUint16(28, nm.length, true);
      c.setUint32(42, offset, true);
      cd.set(nm, 46);
      central.push(cd);
      offset += head.length + data.length;
      ctl.enqueue(head);
      ctl.enqueue(data);
    },
    async cancel() {
      await it.return?.();
    },
  });
}
