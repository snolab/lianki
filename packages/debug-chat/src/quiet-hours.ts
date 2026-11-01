/**
 * Agent lines must not wake the owner (docs/dev-debug-widget.md, "Quiet
 * lines and quiet hours"). Every agent line is shown; this decides which are
 * also read aloud:
 *
 * 1. A hidden page (another tab, the app in the background, the screen
 *    locked: `document.visibilityState` "hidden") never speaks, not even a
 *    loud line.
 * 2. A loud line (`say --loud`, or an ask card: a line that needs his
 *    answer) is read by the usual rules (voice.ts), quiet hours or not. His
 *    own mute (the speaker toggle, with the mic off) still silences it.
 * 3. A quiet line (`say --quiet`: FYI, progress, deploy notices) is never
 *    read.
 * 4. Inside quiet hours (device-local, `lk:agent-quiet-hours`, default on,
 *    23:00–08:00 in the device's own time zone) nothing else is read.
 *
 * Pure apart from the storage helpers, which take a store (tests pass a
 * plain object): unit/quiet-hours.test.ts.
 */

/** localStorage: `{on, from, to}` as JSON. Device-local, never synced (docs/prefs-sync.md). */
export const QUIET_HOURS_KEY = "lk:agent-quiet-hours";
/** Fired on window when this tab saves the quiet hours (other tabs hear `storage`). */
export const QUIET_HOURS_EVENT = "lk:agent-quiet-hours";

/** Quiet hours: on/off, and the window as local "HH:MM" times (from inclusive, to exclusive). */
export type QuietHours = { on: boolean; from: string; to: string };
export const DEFAULT_QUIET_HOURS: QuietHours = { on: true, from: "23:00", to: "08:00" };

/** "HH:MM" (24 h) as minutes after midnight; anything else is null. */
export function parseHm(s: unknown): number | null {
  if (typeof s !== "string") return null;
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(s.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** Minutes after local midnight, in the device's time zone. */
export const minuteOfDay = (d: Date) => d.getHours() * 60 + d.getMinutes();

/**
 * Whether `minute` (after midnight) lies in [from, to). A window whose end
 * is before its start wraps past midnight (23:00–08:00 holds 23:30 and
 * 07:59, not 08:00). from = to is an empty window.
 */
export function inQuietWindow(minute: number, from: number, to: number): boolean {
  if (from === to) return false;
  return from < to ? minute >= from && minute < to : minute >= from || minute < to;
}

/** Whether quiet hours hold at `now` (their own clock: the device's time zone). */
export function quietNow(q: QuietHours, now: Date): boolean {
  if (!q.on) return false;
  const from = parseHm(q.from);
  const to = parseHm(q.to);
  if (from === null || to === null) return false;
  return inQuietWindow(minuteOfDay(now), from, to);
}

/** "HH:MM" from any time-like value, else the fallback. */
const hm = (v: unknown, fallback: string) => {
  const n = parseHm(v);
  return n === null
    ? fallback
    : `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
};

/** The saved quiet hours, each field checked; anything missing or broken is the default. */
export function readQuietHours(raw: string | null): QuietHours {
  if (!raw) return { ...DEFAULT_QUIET_HOURS };
  try {
    const v = JSON.parse(raw) as Partial<QuietHours> | null;
    if (!v || typeof v !== "object") return { ...DEFAULT_QUIET_HOURS };
    return {
      on: typeof v.on === "boolean" ? v.on : DEFAULT_QUIET_HOURS.on,
      from: hm(v.from, DEFAULT_QUIET_HOURS.from),
      to: hm(v.to, DEFAULT_QUIET_HOURS.to),
    };
  } catch {
    return { ...DEFAULT_QUIET_HOURS };
  }
}

type Store = { getItem(k: string): string | null; setItem(k: string, v: string): void };
const local = (): Store | null => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

/** This device's quiet hours. */
export function quietHours(s: Store | null = local()): QuietHours {
  let raw: string | null = null;
  try {
    raw = s?.getItem(QUIET_HOURS_KEY) ?? null;
  } catch {}
  return readQuietHours(raw);
}

/** Save this device's quiet hours (times normalised to "HH:MM"); tells this tab's listeners. */
export function setQuietHours(q: QuietHours, s: Store | null = local()): QuietHours {
  const clean = readQuietHours(JSON.stringify(q));
  try {
    s?.setItem(QUIET_HOURS_KEY, JSON.stringify(clean));
  } catch {}
  try {
    globalThis.dispatchEvent?.(new Event(QUIET_HOURS_EVENT));
  } catch {}
  return clean;
}

/** What a line says about being read aloud (ChatMessage's fields; `ask` = an ask card). */
export type SpeakMeta = { quiet?: unknown; loud?: unknown; ask?: unknown };

/** Loud: `say --loud`, or an ask card (it needs his answer). */
export const isLoud = (m: SpeakMeta) => m.loud === true || (m.ask != null && m.ask !== false);
/** Quiet: `say --quiet`, unless it is loud too. */
export const isQuiet = (m: SpeakMeta) => m.quiet === true && !isLoud(m);

/** Why a line is not read aloud: null = read it (by voice.ts's own rules). */
export type Silence = "hidden" | "quiet" | "quiet-hours";

export function silenceFor(
  m: SpeakMeta,
  at: { now: Date; hidden: boolean; hours: QuietHours },
): Silence | null {
  if (at.hidden) return "hidden";
  if (isLoud(m)) return null;
  if (isQuiet(m)) return "quiet";
  if (quietNow(at.hours, at.now)) return "quiet-hours";
  return null;
}

/** The page is hidden or the screen is locked (true without a document: never speak there). */
export const pageHidden = () =>
  typeof document === "undefined" || document.visibilityState === "hidden";

/** silenceFor with this page's clock, visibility and quiet hours. */
export const silenceHere = (m: SpeakMeta = {}) =>
  silenceFor(m, { now: new Date(), hidden: pageHidden(), hours: quietHours() });
