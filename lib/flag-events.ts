/**
 * The DOM event /dev/flags sends on its window after a flag is saved. The
 * userscript on lianki.com listens for it (src/pill-chat.ts
 * `watchPillChatFlag`) so a flag it mirrors for other sites (`ext.pill-chat`)
 * is read again at once, instead of only on the next lianki.com page load.
 * The detail says nothing secret: the key, the new state, and how long the
 * server may keep serving the old value.
 */
export const FLAG_CHANGED_EVENT = "lk:flag-changed";

export type FlagChangedDetail = { key: string; enabled: boolean; cacheSeconds: number };

/**
 * The event's detail travels as a JSON string: an object detail can arrive as
 * null in a userscript's isolated world (Firefox Xrays), a string always does.
 */
export const flagChangedEvent = (d: FlagChangedDetail) =>
  new CustomEvent(FLAG_CHANGED_EVENT, { detail: JSON.stringify(d) });

/** What a listener can read of the detail; fields it cannot read are left out. */
export function readFlagChanged(detail: unknown): Partial<FlagChangedDetail> {
  let v: unknown = detail;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return {};
    }
  }
  if (!v || typeof v !== "object") return {};
  const o = v as Record<string, unknown>;
  const out: Partial<FlagChangedDetail> = {};
  if (typeof o.key === "string") out.key = o.key;
  if (typeof o.enabled === "boolean") out.enabled = o.enabled;
  if (typeof o.cacheSeconds === "number" && Number.isFinite(o.cacheSeconds))
    out.cacheSeconds = o.cacheSeconds;
  return out;
}
