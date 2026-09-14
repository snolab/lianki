// Per-video watch-time accounting. Framework-neutral: no DOM, no DB, no network.
//
// The model is a grow-only CRDT keyed by device id. Every field merges
// monotonically (max / bitwise-OR / min for `first`), which buys the two
// properties the sync path depends on:
//
//   idempotent  — re-POSTing a payload after a failed response can't double-count
//   commutative — two devices watching the same video merge without coordination
//
// A running total would break the first; last-writer-wins would break the second
// (whichever device synced last would erase the other device's hours). Totals are
// derived at read time by summing across devices — see `summarizeWatch`.

/** Seconds of media per coverage bit. */
export const COV_BUCKET_S = 5;
/** Above this many buckets (≈5.7 h) coverage is skipped; wall/media still count. */
export const COV_MAX_BUCKETS = 4096;

/** One device's grow-only view of a single piece of media. */
export type DeviceWatch = {
  /** Active wall-clock seconds — real time spent, independent of playback rate. */
  wall: number;
  /** Seconds of media consumed. At 1.5× this outruns `wall`; at 0.7× it lags. */
  media: number;
  /** Distinct viewing sessions (a long idle gap starts a new one). */
  sessions: number;
  /** Local-calendar day (YYYY-MM-DD) → wall seconds, for streaks and heatmaps. */
  days: Record<string, number>;
  /** base64 bitset, one bit per COV_BUCKET_S of the timeline. */
  cov?: string;
  /** Media duration in seconds. */
  dur?: number;
  /** BCP-47 audio language. */
  lang?: string;
  /** ISO timestamps of the first and most recent activity. */
  first?: string;
  last?: string;
};

export type WatchStats = {
  v: 1;
  by: Record<string, DeviceWatch>;
};

/** Flattened, human-facing view of a WatchStats. Derived, never stored. */
export type WatchSummary = {
  wall: number;
  media: number;
  sessions: number;
  days: Record<string, number>;
  devices: number;
  dur?: number;
  lang?: string;
  first?: string;
  last?: string;
  /** Fraction of the timeline actually seen, 0..1. Undefined when untracked. */
  coverage?: number;
};

export const emptyDeviceWatch = (): DeviceWatch => ({
  wall: 0,
  media: 0,
  sessions: 0,
  days: {},
});

export const emptyWatchStats = (): WatchStats => ({ v: 1, by: {} });

/** YYYY-MM-DD in the *viewer's* local timezone — en-CA formats as ISO-like. */
export const localDayKey = (d: Date = new Date()): string => d.toLocaleDateString("en-CA");

// ── Coverage bitset ──────────────────────────────────────────────────────────

/**
 * Bucket count for a given duration, or 0 when coverage should not be tracked
 * (unknown duration, or media too long to bound the bitset). Derived purely from
 * `dur` so two devices watching the same video always agree on the layout —
 * bitsets of differing layouts could not be OR-merged.
 */
export function coverageBuckets(durSeconds?: number): number {
  if (durSeconds == null || !Number.isFinite(durSeconds) || durSeconds <= 0) return 0;
  const n = Math.ceil(durSeconds / COV_BUCKET_S);
  return n > COV_MAX_BUCKETS ? 0 : n;
}

export const newCoverage = (buckets: number): Uint8Array => new Uint8Array(Math.ceil(buckets / 8));

/** Set every bucket touched by the media interval [fromS, toS]. Clamps to range. */
export function markCoverage(bytes: Uint8Array, fromS: number, toS: number): void {
  const buckets = bytes.length * 8;
  if (!buckets) return;
  const a = Math.min(fromS, toS);
  const b = Math.max(fromS, toS);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return;
  const lo = Math.max(0, Math.floor(a / COV_BUCKET_S));
  const hi = Math.min(buckets - 1, Math.floor(b / COV_BUCKET_S));
  for (let i = lo; i <= hi; i++) bytes[i >> 3] |= 1 << (i & 7);
}

export function coverageCount(bytes: Uint8Array): number {
  let n = 0;
  for (const byte of bytes) {
    let v = byte;
    while (v) {
      v &= v - 1;
      n++;
    }
  }
  return n;
}

export function encodeCoverage(bytes: Uint8Array): string {
  let bin = "";
  // Chunked: String.fromCharCode(...huge) overflows the argument stack.
  for (let i = 0; i < bytes.length; i += 0x400)
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x400));
  return btoa(bin);
}

export function decodeCoverage(b64?: string): Uint8Array {
  if (!b64) return new Uint8Array(0);
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return new Uint8Array(0);
  }
}

/** Bitwise OR, zero-padding the shorter side. Grow-only: bits are never cleared. */
export function mergeCoverage(a?: string, b?: string): string | undefined {
  if (!a) return b;
  if (!b) return a;
  const x = decodeCoverage(a);
  const y = decodeCoverage(b);
  const out = new Uint8Array(Math.max(x.length, y.length));
  out.set(x);
  for (let i = 0; i < y.length; i++) out[i] |= y[i];
  return encodeCoverage(out);
}

// ── Merge ────────────────────────────────────────────────────────────────────

const maxNum = (a?: number, b?: number) => (a == null ? b : b == null ? a : Math.max(a, b));
const minStr = (a?: string, b?: string) => (a == null ? b : b == null ? a : a < b ? a : b);
const maxStr = (a?: string, b?: string) => (a == null ? b : b == null ? a : a > b ? a : b);

/**
 * Language of the more recent observation. Ties break lexicographically so the
 * result stays independent of argument order (merge must be commutative).
 */
function mergeLang(a: DeviceWatch, b: DeviceWatch): string | undefined {
  if (!a.lang || !b.lang || a.lang === b.lang) return a.lang ?? b.lang;
  const al = a.last ?? "";
  const bl = b.last ?? "";
  if (al !== bl) return al > bl ? a.lang : b.lang;
  return a.lang < b.lang ? a.lang : b.lang;
}

export function mergeDeviceWatch(a: DeviceWatch, b: DeviceWatch): DeviceWatch {
  const days: Record<string, number> = { ...a.days };
  for (const [day, secs] of Object.entries(b.days ?? {}))
    days[day] = Math.max(days[day] ?? 0, secs);
  return {
    wall: Math.max(a.wall, b.wall),
    media: Math.max(a.media, b.media),
    sessions: Math.max(a.sessions, b.sessions),
    days,
    cov: mergeCoverage(a.cov, b.cov),
    dur: maxNum(a.dur, b.dur),
    lang: mergeLang(a, b),
    first: minStr(a.first, b.first),
    last: maxStr(a.last, b.last),
  };
}

/** Commutative, associative, idempotent. Safe to apply to a replayed payload. */
export function mergeWatchStats(a?: WatchStats | null, b?: WatchStats | null): WatchStats {
  const out: WatchStats = { v: 1, by: { ...a?.by } };
  for (const [device, watch] of Object.entries(b?.by ?? {})) {
    const mine = out.by[device];
    out.by[device] = mine ? mergeDeviceWatch(mine, watch) : watch;
  }
  return out;
}

// ── Read model ───────────────────────────────────────────────────────────────

/**
 * Collapse the per-device counters into totals. Wall/media/sessions SUM across
 * devices (each is that device's own grow-only count); coverage is the union.
 */
export function summarizeWatch(stats?: WatchStats | null): WatchSummary {
  const devices = Object.values(stats?.by ?? {});
  const out: WatchSummary = { wall: 0, media: 0, sessions: 0, days: {}, devices: devices.length };
  let cov: string | undefined;
  let langAt = "";
  for (const d of devices) {
    out.wall += d.wall || 0;
    out.media += d.media || 0;
    out.sessions += d.sessions || 0;
    for (const [day, secs] of Object.entries(d.days ?? {}))
      out.days[day] = (out.days[day] ?? 0) + secs;
    out.dur = maxNum(out.dur, d.dur);
    out.first = minStr(out.first, d.first);
    out.last = maxStr(out.last, d.last);
    cov = mergeCoverage(cov, d.cov);
    // Report the language seen most recently, matching mergeLang's rule.
    if (d.lang && (d.last ?? "") >= langAt) {
      langAt = d.last ?? "";
      out.lang = d.lang;
    }
  }
  const buckets = coverageBuckets(out.dur);
  if (buckets && cov) out.coverage = Math.min(1, coverageCount(decodeCoverage(cov)) / buckets);
  return out;
}

/** Tolerant parse of the JSON stored in the DB — never throws, worst case empty. */
export function parseWatchStats(raw?: string | null): WatchStats {
  if (!raw) return emptyWatchStats();
  try {
    return sanitizeWatchStats(JSON.parse(raw));
  } catch {
    return emptyWatchStats();
  }
}

// ── Untrusted input ──────────────────────────────────────────────────────────
// The sync endpoint stores whatever a client POSTs, so bound every dimension a
// buggy or hostile client could grow without limit. Plain TS rather than a zod
// schema so the worker, the Next route, and the userscript all share one copy.

export const MAX_DEVICES = 32;
export const MAX_DAYS = 400;
/** base64 of COV_MAX_BUCKETS bits = 512 bytes → 684 chars, plus slack. */
export const MAX_COV_CHARS = 700;
const MAX_SECONDS = 1e9;
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

const num = (v: unknown, max: number): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.min(v, max) : undefined;

const str = (v: unknown, max: number): string | undefined =>
  typeof v === "string" && v.length > 0 && v.length <= max ? v : undefined;

/** Coerce untrusted input into a WatchStats, clamping every unbounded field. */
export function sanitizeWatchStats(input: unknown): WatchStats {
  const by = (input as WatchStats | null)?.by;
  if (!by || typeof by !== "object") return emptyWatchStats();
  const out = emptyWatchStats();
  for (const [device, raw] of Object.entries(by).slice(0, MAX_DEVICES)) {
    if (device.length > 64 || !raw || typeof raw !== "object") continue;
    const d = raw as DeviceWatch;
    const days: Record<string, number> = {};
    for (const [day, secs] of Object.entries(d.days ?? {}).slice(0, MAX_DAYS)) {
      if (!DAY_KEY.test(day)) continue;
      const v = num(secs, 86_400);
      if (v != null) days[day] = v;
    }
    const cov = str(d.cov, MAX_COV_CHARS);
    out.by[device] = {
      wall: num(d.wall, MAX_SECONDS) ?? 0,
      media: num(d.media, MAX_SECONDS) ?? 0,
      sessions: num(d.sessions, 1e6) ?? 0,
      days,
      cov: cov && /^[A-Za-z0-9+/=]*$/.test(cov) ? cov : undefined,
      dur: num(d.dur, MAX_SECONDS),
      lang: str(d.lang, 32),
      first: str(d.first, 32),
      last: str(d.last, 32),
    };
  }
  return out;
}
