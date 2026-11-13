/**
 * The mic's recordings, on their way to the account (docs/recordings.md).
 * Each finished utterance the mic hands over (mic.ts `record`) is queued here
 * and POSTed to /api/my/recordings in the background, one at a time: never
 * blocking the chat, retried with a backoff, dropped after
 * RECORDER_LIMITS.maxTries failures, and bounded in count and bytes (the
 * oldest goes first when full).
 *
 * Before anything is sent, the route is asked once whether recordings are on
 * for this account (`?status=1`: the flag `voice.recordings` and the `dev`
 * grant). Off (404): nothing is sent and the queue is emptied; the answer is
 * kept for a while, then asked again at the next utterance — never by a timer.
 * Memory only: a reload drops what had not gone yet.
 */
import type { MicRecord } from "./mic";

export const RECORDER_LIMITS = {
  /** Clips waiting at most; past it the oldest is dropped. */
  maxItems: 40,
  /** Their WAV bytes at most (about 4 min of 16 kHz audio). */
  maxBytes: 8_000_000,
  /** Attempts per clip before it is dropped. */
  maxTries: 5,
  /** Wait before each retry (the last repeats). */
  backoffMs: [2_000, 10_000, 30_000, 60_000] as readonly number[],
  /** How long an "on" answer is trusted, and an "off" one. */
  onTtlMs: 10 * 60_000,
  offTtlMs: 60 * 60_000,
} as const;

export const RECORDINGS_URL = "/api/my/recordings";

export type RecorderClip = MicRecord & { device: string };
export type RecorderDeps = {
  fetch: typeof fetch;
  now?: () => number;
  setTimer?: (f: () => void, ms: number) => unknown;
  /** A fresh clip id (16 random bytes, base64url). */
  id?: () => string;
  /** The device's own date of a time, YYYY-MM-DD. */
  day?: (at: number) => string;
  log?: (ev: Record<string, unknown>) => void;
};

/** The device's local calendar day of `at`. */
export function localDay(at: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function randomClipId(): string {
  let s = "";
  for (const b of crypto.getRandomValues(new Uint8Array(16))) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

type Item = { body: string; bytes: number; tries: number; id: string };

export type Recorder = ReturnType<typeof createRecorder>;

export function createRecorder(deps: RecorderDeps) {
  const L = RECORDER_LIMITS;
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((f, ms) => setTimeout(f, ms));
  const newId = deps.id ?? randomClipId;
  const dayOf = deps.day ?? localDay;
  const log = deps.log ?? (() => {});
  const queue: Item[] = [];
  let bytes = 0;
  let busy = false;
  let waiting = false;
  /** The route's last answer to "on?" and when it came. */
  let known: { on: boolean; at: number } | null = null;
  let dropped = 0;
  let sent = 0;

  const shift = () => {
    const it = queue.shift();
    if (it) bytes -= it.bytes;
  };
  const clear = () => {
    dropped += queue.length;
    queue.length = 0;
    bytes = 0;
  };

  /** Recordings on for this account? null: could not tell (try again later). */
  async function on(): Promise<boolean | null> {
    const t = now();
    if (known && t - known.at < (known.on ? L.onTtlMs : L.offTtlMs)) return known.on;
    try {
      const r = await deps.fetch(`${RECORDINGS_URL}?status=1`, {
        headers: { accept: "application/json" },
        credentials: "same-origin",
      });
      if (r.ok) known = { on: (await r.json())?.on === true, at: t };
      else if (r.status === 404 || r.status === 401 || r.status === 403 || r.status === 503)
        known = { on: false, at: t };
      else return null;
    } catch {
      return null;
    }
    return known.on;
  }

  const retryLater = (ms: number) => {
    if (waiting) return;
    waiting = true;
    setTimer(() => {
      waiting = false;
      void pump();
    }, ms);
  };

  async function pump(): Promise<void> {
    if (busy || waiting) return;
    busy = true;
    try {
      while (queue.length) {
        const ok = await on();
        if (ok === false) {
          log({ ev: "record-off", dropped: queue.length });
          clear();
          return;
        }
        const it = queue[0]!;
        let status = 0;
        if (ok) {
          try {
            const r = await deps.fetch(RECORDINGS_URL, {
              method: "POST",
              headers: { "content-type": "application/json" },
              credentials: "same-origin",
              body: it.body,
            });
            status = r.status;
          } catch {
            status = 0;
          }
        }
        if (status >= 200 && status < 300) {
          sent++;
          shift();
          continue;
        }
        if (status === 404 || status === 401 || status === 403) {
          // Turned off, or signed out, meanwhile: nothing more goes.
          known = { on: false, at: now() };
          log({ ev: "record-off", status, dropped: queue.length });
          clear();
          return;
        }
        if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
          // Refused as it is: sending it again changes nothing.
          log({ ev: "record-refused", status, bytes: it.bytes });
          dropped++;
          shift();
          continue;
        }
        it.tries++;
        if (it.tries >= L.maxTries) {
          log({ ev: "record-dropped", status, tries: it.tries });
          dropped++;
          shift();
          continue;
        }
        retryLater(L.backoffMs[Math.min(it.tries - 1, L.backoffMs.length - 1)]!);
        return;
      }
    } finally {
      busy = false;
    }
  }

  return {
    /** Queue one utterance (returns at once). */
    add(c: RecorderClip): void {
      // The answer was "off" a moment ago: nothing to keep.
      if (known && !known.on && now() - known.at < L.offTtlMs) return;
      const id = newId();
      const body = JSON.stringify({
        id,
        at: c.at,
        day: dayOf(c.at),
        text: c.text,
        source: c.source,
        mode: c.mode,
        device: c.device,
        ...(c.speaker ? { speaker: c.speaker } : {}),
        wav: base64(c.wav),
      });
      queue.push({ body, bytes: c.wav.length, tries: 0, id });
      bytes += c.wav.length;
      while (queue.length > L.maxItems || (bytes > L.maxBytes && queue.length > 1)) {
        dropped++;
        shift();
      }
      void pump();
    },
    /**
     * Recordings known to be on for this account right now. Unknown or stale:
     * false, and the route is asked (once) so the next utterance knows.
     */
    enabled(): boolean {
      const fresh = known && now() - known.at < (known.on ? L.onTtlMs : L.offTtlMs);
      if (!fresh) void on();
      return !!fresh && known!.on;
    },
    /** Try again now (the page came back online). */
    kick: () => void pump(),
    /** For the dev menu and the tests. */
    stats: () => ({ queued: queue.length, bytes, sent, dropped, on: known?.on ?? null }),
  };
}

/** The page's recorder, made once (globalThis, so a hot-swapped widget shares it). */
export function pageRecorder(make: () => Recorder): Recorder {
  const g = globalThis as unknown as Record<string, Recorder | undefined>;
  return (g.__lkRecorder ??= make());
}
