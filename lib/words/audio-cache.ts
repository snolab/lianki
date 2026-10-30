/**
 * Word audio (/api/words/tts) fetched ahead of the tap: the clips of the rows
 * on screen and just below are prefetched, so a tap plays at once.
 *
 * - Each clip is fetched once per session and kept as a blob URL, in an LRU
 *   of `maxClips`; evicted URLs are revoked.
 * - What has no voice is remembered: a text with none (404 `X-Voice: miss`,
 *   or 400 — too long to voice) is never asked for again, and neither is a
 *   language the server cannot speak at all (any other 404, 503). The caller
 *   goes straight to the browser's speech for those.
 * - Prefetch runs at most `maxConcurrent` fetches at once and `maxSession`
 *   in all; never on Save-Data or a 2G connection; and pauses for a 429's
 *   Retry-After. A tap (`load`) always goes first: it takes the slot of the
 *   newest prefetch when all are busy, and is never aborted.
 *
 * Pure: the browser is passed in, so the queue is unit-tested with fakes
 * (unit/words-audio-cache.test.ts).
 */

export type ClipResult =
  | { kind: "ok"; url: string }
  /** This text has no voice: say it with the browser. */
  | { kind: "miss" }
  /** This language has no server voice. */
  | { kind: "dead" }
  /** Offline, over the limit, or an error: may work later. */
  | { kind: "fail"; status?: number };

export type ClipReq = { lang: string; text: string };

type Connection = { saveData?: boolean; effectiveType?: string };

export type AudioCacheDeps = {
  fetch: (url: string, init: { signal: AbortSignal }) => Promise<Response>;
  createObjectURL: (blob: Blob) => string;
  revokeObjectURL: (url: string) => void;
  /** `navigator.connection`, where the browser has it. */
  connection?: () => Connection | undefined;
  now?: () => number;
  log?: (event: Record<string, unknown>) => void;
  maxConcurrent?: number;
  maxSession?: number;
  maxClips?: number;
};

export const ttsUrl = (lang: string, text: string) =>
  `/api/words/tts?lang=${encodeURIComponent(lang)}&text=${encodeURIComponent(text)}`;

const keyOf = (r: ClipReq) => `${r.lang}\n${r.text}`;

type Flight = {
  req: ClipReq;
  ctrl: AbortController;
  priority: boolean;
  promise: Promise<ClipResult>;
};

/** Save-Data, or a connection too slow to spend on clips nobody asked for yet. */
export function prefetchAllowed(c: Connection | undefined): boolean {
  if (!c) return true;
  return !c.saveData && c.effectiveType !== "2g" && c.effectiveType !== "slow-2g";
}

export class AudioCache {
  private readonly d: Required<Omit<AudioCacheDeps, "connection" | "log">> &
    Pick<AudioCacheDeps, "connection" | "log">;
  /** Blob URLs, oldest first (a Map keeps insertion order). */
  private readonly clips = new Map<string, string>();
  private readonly misses = new Set<string>();
  private readonly dead = new Set<string>();
  /** Prefetches that failed: a tap may retry them, the prefetch does not. */
  private readonly failed = new Set<string>();
  private readonly flights = new Map<string, Flight>();
  private queue: ClipReq[] = [];
  /** Prefetches started this session. */
  private started = 0;
  private pausedUntil = 0;

  constructor(deps: AudioCacheDeps) {
    this.d = {
      now: () => Date.now(),
      maxConcurrent: 3,
      maxSession: 300,
      maxClips: 200,
      ...deps,
    };
  }

  /** Language with no server voice. */
  isDead(lang: string) {
    return this.dead.has(lang);
  }

  /** What is known without a fetch: a ready clip, a miss, a dead language. */
  peek(lang: string, text: string): ClipResult | undefined {
    if (this.dead.has(lang)) return { kind: "dead" };
    const key = keyOf({ lang, text });
    if (this.misses.has(key)) return { kind: "miss" };
    const url = this.clips.get(key);
    if (url === undefined) return undefined;
    // Used now: the newest in the LRU.
    this.clips.delete(key);
    this.clips.set(key, url);
    return { kind: "ok", url };
  }

  /** Counters, for tests and the debug log. */
  get stats() {
    return {
      clips: this.clips.size,
      queued: this.queue.length,
      inFlight: this.flights.size,
      started: this.started,
      misses: this.misses.size,
    };
  }

  /**
   * The clips wanted soon, most wanted first. Replaces the previous wish:
   * queued clips no longer in it are dropped, and their prefetches in flight
   * aborted.
   */
  prefetch(reqs: ClipReq[]): void {
    if (!prefetchAllowed(this.d.connection?.()) || this.d.now() < this.pausedUntil) {
      this.queue = [];
      return;
    }
    const want = new Set(reqs.map(keyOf));
    for (const [key, f] of this.flights)
      if (!f.priority && !want.has(key)) {
        this.flights.delete(key);
        f.ctrl.abort();
      }
    const seen = new Set<string>();
    this.queue = reqs.filter((r) => {
      const key = keyOf(r);
      if (seen.has(key)) return false;
      seen.add(key);
      return (
        !!r.text &&
        !this.dead.has(r.lang) &&
        !this.misses.has(key) &&
        !this.failed.has(key) &&
        !this.clips.has(key) &&
        !this.flights.has(key)
      );
    });
    this.pump();
  }

  /** The clip to play now: ahead of every prefetch. */
  load(lang: string, text: string): Promise<ClipResult> {
    const known = this.peek(lang, text);
    if (known) return Promise.resolve(known);
    const req = { lang, text };
    const key = keyOf(req);
    const flying = this.flights.get(key);
    if (flying) {
      flying.priority = true;
      return flying.promise;
    }
    this.queue = this.queue.filter((r) => keyOf(r) !== key);
    if (this.flights.size >= this.d.maxConcurrent) {
      // Make room: the newest prefetch steps back to the front of the queue.
      const victim = [...this.flights].reverse().find(([, f]) => !f.priority);
      if (victim) {
        this.flights.delete(victim[0]);
        victim[1].ctrl.abort();
        this.started--;
        this.queue.unshift(victim[1].req);
      }
    }
    return this.start(req, true);
  }

  private pump() {
    while (
      this.queue.length &&
      this.flights.size < this.d.maxConcurrent &&
      this.started < this.d.maxSession
    ) {
      this.started++;
      void this.start(this.queue.shift()!, false);
    }
    if (this.started >= this.d.maxSession) this.queue = [];
  }

  private start(req: ClipReq, priority: boolean): Promise<ClipResult> {
    const key = keyOf(req);
    const ctrl = new AbortController();
    const flight = { req, ctrl, priority } as Flight;
    flight.promise = this.d
      .fetch(ttsUrl(req.lang, req.text), { signal: ctrl.signal })
      .then((r) => this.settle(req, r, flight))
      .catch(() => ({ kind: "fail" }) as const)
      .finally(() => {
        if (this.flights.get(key) === flight) this.flights.delete(key);
        this.pump();
      });
    this.flights.set(key, flight);
    return flight.promise;
  }

  private async settle(req: ClipReq, r: Response, flight: Flight): Promise<ClipResult> {
    const key = keyOf(req);
    const voice = r.headers.get("X-Voice");
    this.d.log?.({
      ev: "server",
      lang: req.lang,
      text: req.text,
      status: r.status,
      voice,
      prefetch: !flight.priority,
    });
    if (r.ok) {
      const url = this.d.createObjectURL(await r.blob());
      this.clips.set(key, url);
      while (this.clips.size > this.d.maxClips) {
        const [oldKey, oldUrl] = this.clips.entries().next().value!;
        this.clips.delete(oldKey);
        this.d.revokeObjectURL(oldUrl);
      }
      return { kind: "ok", url };
    }
    if (r.status === 400 || (r.status === 404 && voice === "miss")) {
      this.misses.add(key);
      return { kind: "miss" };
    }
    if (r.status === 404 || r.status === 503) {
      this.dead.add(req.lang);
      this.queue = this.queue.filter((q) => q.lang !== req.lang);
      return { kind: "dead" };
    }
    if (r.status === 429) {
      const s = Number(r.headers.get("Retry-After"));
      this.pausedUntil = this.d.now() + (s > 0 ? s : 60) * 1000;
      this.queue = [];
    }
    if (!flight.priority) this.failed.add(key);
    return { kind: "fail", status: r.status };
  }
}
