/**
 * "Don't ask again", spaced (owner, 2026-11-10): no such choice sticks for
 * good. After a person picks it, the question comes back once the interval is
 * over; each time they pick it again the next interval is longer (7 days, 30,
 * 90, a year, then a year each time), and a re-asked question answered
 * without the box drops the choice. Every dialog with a "don't ask again"
 * goes through here; /my/preferences lists the choices for review
 * (app/components/DontAskReview.tsx). docs/prefs-sync.md, "Don't ask again".
 *
 * Kept with the account (`asks.dontAsk`, docs/prefs-sync.md): one small map,
 * choice id → [times chosen, day chosen, day it asks again], days counted
 * from 1970-01-01 (UTC). The dialog's own setting (`links.confirm`, …) still
 * says what was chosen; this map says until when it holds. A choice with no
 * entry here asks: that is also how a choice made before this map existed,
 * or one dropped to stay under the size cap, is asked about again.
 *
 * Pure, apart from the storage helpers at the end.
 */
import { notePrefWrite } from "@lianki/ui-state/account";
import { isAllowedHost } from "@lianki/core/externalLink";

/** Defaults, one named place (ready for the config store under `key`). */
export const DONT_ASK_CONFIG = {
  key: "dontAsk",
  /**
   * Days until the question comes back: the first "don't ask again" waits the
   * first, each one after the next; the last repeats.
   */
  reaskDays: [7, 30, 90, 365] as readonly number[],
  /** Choices kept; the oldest chosen is dropped first (and so asked about again). */
  max: 40,
  /** The stored JSON stays under the account pref's 2 KB cap. */
  maxBytes: 1900,
} as const;

/** Every dialog that offers "don't ask again". A new one adds its kind here. */
export const DONT_ASK_KINDS = {
  /** The disclaimer before another website, "for any site" (lib/external-link.ts). */
  "link-any": { subject: false },
  /** The same, "for this site": the subject is the host. */
  "link-site": { subject: true },
  /** The reader's offer to tidy a raw transcript (lib/read/polish-offer.ts). */
  "read-polish": { subject: false },
} as const;
export type DontAskKind = keyof typeof DONT_ASK_KINDS;

/** times chosen (1…), day chosen, day it asks again. */
export type DontAskRecord = readonly [n: number, chosen: number, due: number];
export type DontAskMap = Readonly<Record<string, DontAskRecord>>;

export const DONT_ASK_KEY = "lk:dont-ask";
/** Fired on window after this tab changed a choice. */
export const DONT_ASK_EVENT = "lk:dont-ask";

const DAY_MS = 86_400_000;
export const dayOf = (ms: number): number => Math.floor(ms / DAY_MS);
export const dayStart = (day: number): number => day * DAY_MS;

export const dontAskId = (kind: DontAskKind, subject?: string): string =>
  DONT_ASK_KINDS[kind].subject ? `${kind}:${subject ?? ""}` : kind;

/** An id's kind and subject, or null when it is not one we know. */
export function parseDontAskId(id: string): { kind: DontAskKind; subject?: string } | null {
  const i = id.indexOf(":");
  const kind = (i < 0 ? id : id.slice(0, i)) as DontAskKind;
  if (!Object.prototype.hasOwnProperty.call(DONT_ASK_KINDS, kind)) return null;
  if (!DONT_ASK_KINDS[kind].subject) return i < 0 ? { kind } : null;
  const subject = i < 0 ? "" : id.slice(i + 1);
  if (kind === "link-site" && !isAllowedHost(subject)) return null;
  return { kind, subject };
}

/** Days until it asks again after the n-th "don't ask again" (n from 1). */
export function reaskAfter(n: number, days: readonly number[] = DONT_ASK_CONFIG.reaskDays): number {
  const i = Math.min(Math.max(1, Math.floor(n)), days.length) - 1;
  return Math.max(1, days[i] ?? 7);
}

/** Quiet today: chosen, and its day to ask again has not come. */
export const isQuiet = (map: DontAskMap, id: string, today: number): boolean => {
  const r = map[id];
  return !!r && today < r[2];
};

const okInt = (x: unknown, lo: number, hi: number) =>
  typeof x === "number" && Number.isInteger(x) && x >= lo && x <= hi;

/** A stored map (untrusted): the entries that make sense, trimmed to the caps. */
export function checkDontAsk(v: unknown): Record<string, DontAskRecord> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, DontAskRecord> = {};
  for (const [id, r] of Object.entries(v as Record<string, unknown>)) {
    if (!parseDontAskId(id) || !Array.isArray(r) || r.length !== 3) continue;
    const [n, chosen, due] = r;
    if (!okInt(n, 1, 999) || !okInt(chosen, 0, 200_000) || !okInt(due, 0, 200_000)) continue;
    out[id] = [n, chosen, due] as const;
  }
  return trim(out);
}

/** The newest chosen, under the count and byte caps. */
function trim(map: Record<string, DontAskRecord>): Record<string, DontAskRecord> {
  let entries = Object.entries(map).sort((a, b) => a[1][1] - b[1][1]);
  if (entries.length > DONT_ASK_CONFIG.max) entries = entries.slice(-DONT_ASK_CONFIG.max);
  while (
    entries.length &&
    JSON.stringify(Object.fromEntries(entries)).length > DONT_ASK_CONFIG.maxBytes
  )
    entries = entries.slice(1);
  return Object.fromEntries(entries);
}

/**
 * "Don't ask again" picked (again): one more time chosen, so the next wait is
 * the next interval.
 */
export function chooseIn(
  map: DontAskMap,
  id: string,
  today: number,
): Record<string, DontAskRecord> {
  const n = (map[id]?.[0] ?? 0) + 1;
  return trim({ ...map, [id]: [n, today, today + reaskAfter(n)] });
}

/** "Ask again now": due today, and the times chosen are kept for the next pick. */
export function askNowIn(
  map: DontAskMap,
  id: string,
  today: number,
): Record<string, DontAskRecord> {
  const r = map[id];
  return r ? { ...map, [id]: [r[0], r[1], Math.min(r[2], today)] } : { ...map };
}

/** The choice is gone: the question was answered without the box, or turned back on. */
export function forgetIn(map: DontAskMap, id: string): Record<string, DontAskRecord> {
  const { [id]: _gone, ...rest } = map;
  return rest;
}

export type DontAskRow = {
  id: string;
  kind: DontAskKind;
  subject?: string;
  n: number;
  /** Day chosen and day it asks again (dayStart() for a Date). */
  chosen: number;
  due: number;
  /** It asks the next time the question comes up. */
  isDue: boolean;
};

/** The review list: due first, then by the day each asks again. */
export function dontAskRows(map: DontAskMap, today: number): DontAskRow[] {
  const rows: DontAskRow[] = [];
  for (const [id, [n, chosen, due]] of Object.entries(map)) {
    const p = parseDontAskId(id);
    if (p) rows.push({ id, ...p, n, chosen, due, isDue: today >= due });
  }
  return rows.sort((a, b) => a.due - b.due || a.id.localeCompare(b.id));
}

// ── storage (localStorage, synced through lib/prefs/bindings.ts) ─────────────

const today = () => dayOf(Date.now());

export function readDontAsk(): Record<string, DontAskRecord> {
  try {
    return checkDontAsk(JSON.parse(localStorage.getItem(DONT_ASK_KEY) ?? "{}"));
  } catch {
    return {};
  }
}

function write(map: DontAskMap) {
  try {
    localStorage.setItem(DONT_ASK_KEY, JSON.stringify(map));
    notePrefWrite();
  } catch {
    // a private window: for this visit only
  }
  try {
    window.dispatchEvent(new Event(DONT_ASK_EVENT));
  } catch {}
}

/** Is this choice holding today (so the question stays away)? */
export const dontAskQuiet = (id: string): boolean => isQuiet(readDontAsk(), id, today());

/** "Don't ask again" was picked, or kept from the review. */
export const chooseDontAsk = (id: string) => write(chooseIn(readDontAsk(), id, today()));

/** From the review: ask the next time the question comes up. */
export const askAgainNow = (id: string) => write(askNowIn(readDontAsk(), id, today()));

/** The choice is gone (answered without the box, or the setting turned back on). */
export function forgetDontAsk(id: string) {
  const map = readDontAsk();
  if (map[id]) write(forgetIn(map, id));
}

/** The review's "keep all" / "ask all again", as one write. */
export function reviewAll(ids: readonly string[], keep: boolean) {
  const d = today();
  let map: Record<string, DontAskRecord> = readDontAsk();
  for (const id of ids) map = keep ? chooseIn(map, id, d) : askNowIn(map, id, d);
  write(map);
}
