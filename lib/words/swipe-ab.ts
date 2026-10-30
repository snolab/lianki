/**
 * The two touch-swipe implementations on /words, compared side by side:
 *
 *   "js"     (A) — WordRow: pointer events, JS detents (lib/words/swipe.ts).
 *   "native" (B) — NativeSlipRow: each slip its own horizontal scroller with
 *                  scroll-snap points; the browser does the gesture.
 *
 * Everyone is on A; the Settings switch "New swipe (beta)" turns B on
 * (localStorage, synced with the account: docs/prefs-sync.md). Every swipe telemetry row carries the variant, so
 * /dev/swipe-ab can compare them.
 *
 * `?swipe=native` / `?swipe=js` overrides the stored choice for that page load
 * only (to check a variant on someone's device without touching their
 * setting — also inside an iframe). It is never written to localStorage.
 */
import { notePrefWrite } from "@lianki/ui-state";

export type SwipeVariant = "js" | "native";

export const SWIPE_AB_KEY = "lk:swipe-ab";
/** A random id per device, so the comparison can count devices, not just accounts. */
export const SWIPE_AB_DEVICE_KEY = "lk:swipe-ab-dev";

type Store = Pick<Storage, "getItem" | "setItem">;

function storage(): Store | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function search(): string {
  try {
    return typeof location === "undefined" ? "" : location.search;
  } catch {
    return "";
  }
}

/** The page-load-only `?swipe=` override, or null. */
export function swipeOverride(query = search()): SwipeVariant | null {
  const v = new URLSearchParams(query).get("swipe");
  return v === "native" || v === "js" ? v : null;
}

/** This device's variant: a `?swipe=` override, else "js" unless B was turned on. */
export function swipeVariant(store = storage(), query = search()): SwipeVariant {
  const forced = swipeOverride(query);
  if (forced) return forced;
  try {
    return store?.getItem(SWIPE_AB_KEY) === "native" ? "native" : "js";
  } catch {
    return "js";
  }
}

export function setSwipeVariant(v: SwipeVariant, store = storage()) {
  try {
    store?.setItem(SWIPE_AB_KEY, v);
  } catch {}
  notePrefWrite();
}

/** The telemetry tag: `ab=<variant>;dev=<id>`. */
export function swipeAbTag(store = storage(), random = Math.random): string {
  const ab = swipeVariant(store);
  let dev = "";
  try {
    dev = store?.getItem(SWIPE_AB_DEVICE_KEY) ?? "";
    if (!dev && store) {
      dev = Math.floor(random() * 36 ** 8)
        .toString(36)
        .padStart(8, "0");
      store.setItem(SWIPE_AB_DEVICE_KEY, dev);
    }
  } catch {}
  return `ab=${ab}${dev ? `;dev=${dev}` : ""}`;
}

/** The `key=value;…` pairs of a telemetry params string. */
export function parseParams(params: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const kv of (params ?? "").split(";")) {
    const i = kv.indexOf("=");
    if (i > 0) out[kv.slice(0, i)] = kv.slice(i + 1);
  }
  return out;
}

/** One swipe_log row, as the comparison reads it. */
export type SwipeLogRow = {
  email: string;
  finger: number;
  rating: number | null;
  params: string | null;
};

export type SwipeAbStats = {
  variant: SwipeVariant;
  /** Sideways gestures: graded ones plus those that graded nothing. */
  swipes: number;
  users: number;
  devices: number;
  /** Swipes per grade, 1–4. */
  grades: [number, number, number, number];
  /** Swipes that slid but graded nothing. */
  cancels: number;
  cancelRate: number;
  /** Undos within 5 s of a swipe's grade. */
  undos: number;
  /** Undos per graded swipe. */
  undoRate: number;
  /** Median finger travel of graded swipes, px (absolute). */
  medianTravel: number | null;
};

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Per variant, from swipe_log rows. Rows without an `ab` tag (older ones) are left out. */
export function summarizeSwipeAb(rows: SwipeLogRow[]): SwipeAbStats[] {
  return (["js", "native"] as const).map((variant) => {
    const mine = rows
      .map((r) => ({ r, p: parseParams(r.params) }))
      .filter(({ p }) => p.ab === variant);
    const swipes = mine.filter(({ p }) => !p.ev);
    const graded = swipes.filter(({ r }) => r.rating != null);
    const grades: [number, number, number, number] = [0, 0, 0, 0];
    for (const { r } of graded) if (r.rating! >= 1 && r.rating! <= 4) grades[r.rating! - 1]++;
    const cancels = swipes.length - graded.length;
    const undos = mine.filter(({ p }) => p.ev === "undo").length;
    return {
      variant,
      swipes: swipes.length,
      users: new Set(mine.map(({ r }) => r.email)).size,
      devices: new Set(mine.map(({ p }) => p.dev).filter(Boolean)).size,
      grades,
      cancels,
      cancelRate: swipes.length ? cancels / swipes.length : 0,
      undos,
      undoRate: graded.length ? undos / graded.length : 0,
      medianTravel: median(graded.map(({ r }) => Math.abs(r.finger))),
    };
  });
}
