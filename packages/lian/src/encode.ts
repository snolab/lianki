/**
 * Canonical JSON: one byte string per value, so the same entry always hashes
 * the same on the server, in a browser, and in a script years later.
 *
 * - object keys sorted by UTF-16 code unit (JS default sort), no whitespace;
 * - numbers: safe integers only (no floats, NaN, −0 is written 0) — counts,
 *   never measurements;
 * - strings as JSON.stringify writes them (deterministic);
 * - `undefined` and functions are refused, not dropped.
 *
 * An entry is always a tagged tuple `[tag, ...fields]` whose tag carries the
 * version (e.g. "lian/study-day/1"), so a new layout is a new tag.
 */
import { sha256, toHex, utf8 } from "./bytes";

export type Canon = null | boolean | number | string | Canon[] | { [k: string]: Canon };

export function canonical(v: unknown): string {
  if (v === null) return "null";
  switch (typeof v) {
    case "boolean":
      return v ? "true" : "false";
    case "number":
      if (!Number.isSafeInteger(v)) throw new Error("lian: only safe integers are canonical");
      return String(v === 0 ? 0 : v);
    case "string":
      return JSON.stringify(v);
    case "object": {
      if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null)
        throw new Error("lian: only plain objects are canonical");
      const o = v as Record<string, unknown>;
      return `{${Object.keys(o)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
        .join(",")}}`;
    }
    default:
      throw new Error(`lian: ${typeof v} is not canonical`);
  }
}

/** SHA-256 of an entry's canonical JSON, as hex. */
export async function entryHash(entry: Canon): Promise<string> {
  return toHex(await sha256(utf8(canonical(entry))));
}
