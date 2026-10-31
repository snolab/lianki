/**
 * The account sync engine (docs/prefs-sync.md): keeps a device's local
 * preferences in step with the account's, per field, last write wins by HLC.
 *
 * It knows nothing of the app. The app hands it:
 * - `bindings`: one per server key — how to read the local value (`get`,
 *   undefined = never set here), write a server value locally (`set`), and
 *   the default (`fallback`);
 * - `validate(key, value)`: the key's schema (lib/prefs/schema.ts), applied
 *   to everything that comes in and goes out;
 * - `fetch` and the endpoint.
 *
 * Change detection is by comparison, not by hooks: `scan()` compares each
 * binding's value with the last one it saw (kept in `lk:pref-sync`, shared by
 * the device's tabs), and stamps what changed. So a writer only has to call
 * `notePrefWrite()` to be prompt; one that forgets is still caught by the scan
 * on the next tab switch or page hide. A change seen by one tab is not seen
 * again by another, because the record is shared.
 *
 * Event-driven: the app calls scan/pull/flush on load, sign-in, visibility,
 * `online`, `pagehide` and `lk:pref-write`. Nothing here polls.
 */

export type PrefHlc = { timestamp: number; counter: number; deviceId: string };
export type PrefRow = { value: unknown; hlc: PrefHlc };

export type PrefBinding = {
  key: string;
  /** The local value, or undefined when it was never set on this device. */
  get(): unknown;
  /** Apply a (validated) server value locally. */
  set(value: unknown): void;
  /** The value when nothing is set. Never uploaded by the first sync. */
  fallback: unknown;
};

type Storage = { getItem(k: string): string | null; setItem(k: string, v: string): void };

export type PrefSyncOptions = {
  bindings: () => PrefBinding[];
  validate: (key: string, value: unknown) => unknown;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  endpoint?: string;
  storage: Storage;
  now?: () => number;
  random?: () => number;
  /** Push this long after the last change. */
  debounceMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  log?: (ev: string, data?: Record<string, unknown>) => void;
};

/** What the device remembers, in localStorage `lk:pref-sync`. */
export type PrefSyncRecord = {
  v: 1;
  /** The account the record belongs to; null before the first answer. */
  userId: string | null;
  deviceId: string;
  /** Accounts this device has done the first sync for (server wins, local fills gaps). */
  migrated: string[];
  /** The server's cursor (its clock at the newest row read). */
  cursor: number;
  /** The newest HLC this device made or saw. */
  last: PrefHlc | null;
  /** key → JSON of the value last seen locally. */
  seen: Record<string, string>;
  /** key → HLC of the value held locally. */
  hlc: Record<string, PrefHlc>;
  /** Changes not yet accepted by the server. */
  outbox: Record<string, PrefRow>;
};

export const SYNC_KEY = "lk:pref-sync";
/** Fired (on globalThis) after a local preference was written; the engine scans. */
export const PREF_WRITE_EVENT = "lk:pref-write";
/** Fired (on globalThis) after a server value was applied locally; detail: {key}. */
export const PREF_APPLIED_EVENT = "lk:pref-applied";

/** Tell the engine a preference was just written, so it is pushed promptly. */
export function notePrefWrite() {
  try {
    globalThis.dispatchEvent?.(new Event(PREF_WRITE_EVENT));
  } catch {}
}

/** Tell the page a server value was applied (React hooks re-read). */
export function notePrefApplied(key: string) {
  try {
    globalThis.dispatchEvent?.(new CustomEvent(PREF_APPLIED_EVENT, { detail: { key } }));
  } catch {}
}

export function comparePrefHlc(a: PrefHlc | undefined, b: PrefHlc | undefined): number {
  if (!a) return b ? -1 : 0;
  if (!b) return 1;
  if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
  if (a.counter !== b.counter) return a.counter - b.counter;
  return a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : 0;
}

const UNSET = "∅";
const json = (v: unknown) => (v === undefined ? UNSET : JSON.stringify(v));

export function createPrefSync(opts: PrefSyncOptions) {
  const endpoint = opts.endpoint ?? "/api/prefs";
  const now = opts.now ?? Date.now;
  const random = opts.random ?? Math.random;
  const debounceMs = opts.debounceMs ?? 1000;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  const log = opts.log ?? (() => {});

  const newDeviceId = () =>
    Array.from({ length: 16 }, () => Math.floor(random() * 36).toString(36)).join("");

  function load(): PrefSyncRecord {
    try {
      const r = JSON.parse(opts.storage.getItem(SYNC_KEY) ?? "null") as PrefSyncRecord | null;
      if (r && r.v === 1 && typeof r.deviceId === "string" && /^[a-z0-9]{8,40}$/.test(r.deviceId))
        return {
          ...r,
          migrated: Array.isArray(r.migrated) ? r.migrated : [],
          seen: r.seen ?? {},
          hlc: r.hlc ?? {},
          outbox: r.outbox ?? {},
          cursor: Number(r.cursor) || 0,
        };
    } catch {}
    return {
      v: 1,
      userId: null,
      deviceId: newDeviceId(),
      migrated: [],
      cursor: 0,
      last: null,
      seen: {},
      hlc: {},
      outbox: {},
    };
  }
  function save(r: PrefSyncRecord) {
    try {
      opts.storage.setItem(SYNC_KEY, JSON.stringify(r));
    } catch {}
  }

  function tick(r: PrefSyncRecord): PrefHlc {
    const t = now();
    const last = r.last;
    const h =
      !last || t > last.timestamp
        ? { timestamp: t, counter: 0, deviceId: r.deviceId }
        : { timestamp: last.timestamp, counter: last.counter + 1, deviceId: r.deviceId };
    r.last = h;
    return h;
  }
  /** The HLC receive rule: never stamp behind a clock we have seen. */
  function observe(r: PrefSyncRecord, h: PrefHlc) {
    const l = r.last;
    if (!l || h.timestamp > l.timestamp || (h.timestamp === l.timestamp && h.counter > l.counter))
      r.last = { timestamp: h.timestamp, counter: h.counter, deviceId: r.deviceId };
  }

  const byKey = () => new Map(opts.bindings().map((b) => [b.key, b]));
  const read = (b: PrefBinding) => {
    try {
      return b.get();
    } catch {
      return undefined;
    }
  };

  function apply(r: PrefSyncRecord, b: PrefBinding, row: PrefRow): boolean {
    const v = opts.validate(b.key, row.value);
    if (v === undefined) {
      log("prefs-bad-value", { key: b.key });
      return false;
    }
    try {
      b.set(v);
    } catch {
      return false;
    }
    r.seen[b.key] = json(read(b));
    r.hlc[b.key] = row.hlc;
    observe(r, row.hlc);
    const out = r.outbox[b.key];
    if (out && comparePrefHlc(out.hlc, row.hlc) <= 0) delete r.outbox[b.key];
    notePrefApplied(b.key);
    return true;
  }

  let timer: unknown;
  function schedulePush() {
    if (timer !== undefined) clearTimer(timer);
    timer = setTimer(() => {
      timer = undefined;
      void push();
    }, debounceMs);
  }

  /** Stamp every local change since the last scan. Returns how many. */
  function scan(): number {
    const r = load();
    let changed = 0;
    for (const b of opts.bindings()) {
      const v = read(b);
      const cur = json(v);
      const seen = r.seen[b.key];
      if (seen === undefined) {
        // First look on this device: what is here predates sync. The first
        // sync decides what happens to it (server wins, local fills gaps).
        r.seen[b.key] = cur;
        continue;
      }
      if (cur === seen) continue;
      r.seen[b.key] = cur;
      const value = opts.validate(b.key, v === undefined ? b.fallback : v);
      const hlc = tick(r);
      r.hlc[b.key] = hlc;
      if (value !== undefined) r.outbox[b.key] = { value, hlc };
      changed++;
    }
    save(r);
    if (changed) {
      log("prefs-changed", { n: changed });
      schedulePush();
    }
    return changed;
  }

  let pulling: Promise<void> | null = null;
  /** Read the account's values (newer ones only, after the first time), then push the outbox. */
  function pull(): Promise<void> {
    pulling ??= (async () => {
      try {
        scan();
        let r = load();
        const since = r.userId && r.cursor ? r.cursor : 0;
        let res = await opts.fetch(since ? `${endpoint}?since=${since}` : endpoint, {
          credentials: "same-origin",
        });
        if (res.status === 401) return;
        if (!res.ok) throw new Error(`GET ${res.status}`);
        let body = (await res.json()) as { user: string; prefs: Record<string, PrefRow>; cursor: number };
        r = load();
        if (body.user !== r.userId) {
          if (r.userId !== null) {
            // Another account (sync-merge-rules.md, edge case 13): its pending
            // changes are not this one's, and its values never fill the new
            // account's gaps: that is only for the device's first account.
            r.outbox = {};
            r.hlc = {};
            if (!r.migrated.includes(body.user)) r.migrated.push(body.user);
            log("prefs-account-switch");
          }
          r.userId = body.user;
          r.cursor = 0;
          save(r);
          if (since) {
            res = await opts.fetch(endpoint, { credentials: "same-origin" });
            if (!res.ok) throw new Error(`GET ${res.status}`);
            body = (await res.json()) as typeof body;
            r = load();
          }
        }
        merge(r, body.prefs ?? {});
        r.cursor = Math.max(r.cursor, Number(body.cursor) || 0);
        save(r);
      } catch (e) {
        log("prefs-pull-failed", { error: String(e) });
      } finally {
        pulling = null;
      }
      if (Object.keys(load().outbox).length) await push();
    })();
    return pulling;
  }

  function merge(r: PrefSyncRecord, rows: Record<string, PrefRow>) {
    const user = r.userId!;
    const bindings = byKey();
    if (!r.migrated.includes(user)) {
      // The first sync of this account on this device: the server wins, and
      // local values fill the gaps (docs/prefs-sync.md, decision A).
      for (const b of bindings.values()) {
        const row = rows[b.key];
        const out = r.outbox[b.key];
        if (row) {
          // A change made here while signed out, after the server's: it is
          // the later choice, so it is pushed (last write wins).
          if (!out || comparePrefHlc(out.hlc, row.hlc) <= 0) apply(r, b, row);
          continue;
        }
        if (out) continue;
        const v = read(b);
        if (v === undefined || json(v) === json(b.fallback)) continue;
        const value = opts.validate(b.key, v);
        if (value === undefined) continue;
        r.outbox[b.key] = { value, hlc: r.hlc[b.key] ?? tick(r) };
        r.seen[b.key] = json(v);
      }
      r.migrated.push(user);
      log("prefs-first-sync", { up: Object.keys(r.outbox).length });
      return;
    }
    for (const [key, row] of Object.entries(rows)) {
      const b = bindings.get(key);
      if (!b) continue;
      if (comparePrefHlc(row.hlc, r.hlc[key]) > 0) apply(r, b, row);
    }
  }

  let pushing: Promise<void> | null = null;
  /** Send the outbox. `keepalive` for a page that is going away. */
  function push(keepalive = false): Promise<void> {
    if (pushing) return pushing;
    pushing = (async () => {
      try {
        const r0 = load();
        if (!r0.userId || !r0.migrated.includes(r0.userId)) return; // pull first
        const ops = Object.entries(r0.outbox)
          .slice(0, 50)
          .map(([key, row]) => ({ key, value: row.value, hlc: row.hlc }));
        if (!ops.length) return;
        const res = await opts.fetch(endpoint, {
          method: "PATCH",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ops }),
          keepalive,
        });
        if (!res.ok) throw new Error(`PATCH ${res.status}`);
        const body = (await res.json()) as {
          user: string;
          prefs: Record<string, PrefRow>;
          rejected?: string[];
        };
        const r = load();
        if (body.user !== r.userId) return;
        const bindings = byKey();
        for (const op of ops) {
          const out = r.outbox[op.key];
          if (out && comparePrefHlc(out.hlc, op.hlc) === 0) delete r.outbox[op.key];
          const row = body.prefs?.[op.key];
          const b = bindings.get(op.key);
          if (row && b && comparePrefHlc(row.hlc, r.hlc[op.key]) > 0) apply(r, b, row);
        }
        for (const k of body.rejected ?? []) {
          delete r.outbox[k];
          log("prefs-rejected", { key: k });
        }
        save(r);
      } catch (e) {
        log("prefs-push-failed", { error: String(e) });
      } finally {
        pushing = null;
      }
    })();
    return pushing;
  }

  /** Scan, then push now (for pagehide / hidden). */
  function flush(keepalive = false): Promise<void> {
    scan();
    if (timer !== undefined) {
      clearTimer(timer);
      timer = undefined;
    }
    return push(keepalive);
  }

  return { scan, pull, push, flush, load };
}

export type PrefSync = ReturnType<typeof createPrefSync>;
