/**
 * Word audio (/api/words/tts) fetched ahead of the tap: the clips of the rows
 * on screen first, then their neighbours outward, so a tap plays at once —
 * and kept on the device, so next time it plays with no network at all.
 *
 * Read order: memory → disk → network.
 * - Memory: each clip once per session as a blob URL, in an LRU of
 *   `maxClips`; evicted URLs are revoked — never one of a row on screen
 *   (`pinned`, from the last `prefetch`).
 * - Disk (`disk`, lib/words/audio-disk.ts — the Cache API): every clip
 *   fetched is stored, and found there before any fetch. Offline, it is
 *   all there is. Only 200s are stored.
 * - What has no voice is remembered: a text with none (404 `X-Voice: miss`,
 *   or 400 — too long to voice) is never asked for again, and neither is a
 *   language the server cannot speak at all (any other 404). The caller
 *   goes straight to the browser's speech for those. A 503 (speech
 *   generation not configured or down) is not a dead language: recordings
 *   are served without generating, so it fails that one text only. On
 *   2026-10-31 a 503 for one meaning silenced every recorded Japanese and
 *   English word for the rest of the session.
 * - Prefetch runs at most `maxConcurrent` fetches at once and `maxSession`
 *   in all; never on Save-Data or a 2G connection; and pauses for a 429's
 *   Retry-After. Only clips that cost something count toward `maxSession`:
 *   a prefetch aborted before it was answered, one found on disk, a
 *   recording or a MeloTTS clip already in R2 (`X-Voice: recorded`,
 *   `melotts-cached`) do not — so a long session never runs the prefetch dry.
 *   Each `prefetch` replaces the last wish, in the order given: rows that
 *   left are dropped and their fetches aborted.
 * - `stock` is the lowest priority: clips put on disk only (today's due
 *   words, for offline study), at most `maxStock` at once and only while no
 *   prefetch is waiting; a prefetch or a tap takes their slots.
 * - A tap (`load`) always goes first: it takes the slot of the newest
 *   prefetch when all are busy, and is never aborted. `warm` is a tap on
 *   every part of a row at once: the meaning and the example are fetched
 *   while the word plays, not one after the other.
 *
 * Pure: the browser is passed in, so the queue is unit-tested with fakes
 * (unit/words-audio-cache.test.ts).
 */

/** Where a clip came from, for the debug log. */
export type ClipSource = "memory" | "disk" | "network";

export type ClipResult =
  | { kind: "ok"; url: string; from: ClipSource }
  /** This text has no voice: say it with the browser. */
  | { kind: "miss" }
  /** This language has no server voice. */
  | { kind: "dead" }
  /** Offline, over the limit, or an error: may work later. */
  | { kind: "fail"; status?: number };

export type ClipReq = { lang: string; text: string };

type Connection = { saveData?: boolean; effectiveType?: string };

/** The on-device store (lib/words/audio-disk.ts). */
export type ClipDisk = {
  get(url: string): Promise<Blob | null>;
  has(url: string): Promise<boolean>;
  put(url: string, blob: Blob): Promise<void>;
  pinned: ReadonlySet<string>;
};

export type AudioCacheDeps = {
  fetch: (url: string, init: { signal: AbortSignal }) => Promise<Response>;
  createObjectURL: (blob: Blob) => string;
  revokeObjectURL: (url: string) => void;
  /** `navigator.connection`, where the browser has it. */
  connection?: () => Connection | undefined;
  disk?: ClipDisk;
  now?: () => number;
  log?: (event: Record<string, unknown>) => void;
  maxConcurrent?: number;
  maxSession?: number;
  maxClips?: number;
  maxStock?: number;
};

/** Served without generating anything: no cost to prefetch. */
const FREE_VOICES = new Set(["recorded", "melotts-cached"]);

export const ttsUrl = (lang: string, text: string) =>
  `/api/words/tts?lang=${encodeURIComponent(lang)}&text=${encodeURIComponent(text)}`;

const keyOf = (r: ClipReq) => `${r.lang}\n${r.text}`;

type Kind = "tap" | "prefetch" | "stock";

type Flight = {
  req: ClipReq;
  ctrl: AbortController;
  kind: Kind;
  /** Started as a prefetch: counted toward `maxSession` (a tap may have taken it over since). */
  counted: boolean;
  promise: Promise<ClipResult>;
};

/** Save-Data, or a connection too slow to spend on clips nobody asked for yet. */
export function prefetchAllowed(c: Connection | undefined): boolean {
  if (!c) return true;
  return !c.saveData && c.effectiveType !== "2g" && c.effectiveType !== "slow-2g";
}

export type PrefetchOptions = {
  /** How many of `reqs`, from the start, are the rows on screen: never evicted. */
  pinned?: number;
};

export class AudioCache {
  private readonly d: Required<Omit<AudioCacheDeps, "connection" | "log" | "disk">> &
    Pick<AudioCacheDeps, "connection" | "log" | "disk">;
  /** Blob URLs, oldest first (a Map keeps insertion order). */
  private readonly clips = new Map<string, string>();
  private readonly misses = new Set<string>();
  private readonly dead = new Set<string>();
  /** Prefetches that failed: a tap may retry them, the prefetch does not. */
  private readonly failed = new Set<string>();
  private readonly flights = new Map<string, Flight>();
  private queue: ClipReq[] = [];
  private stockQueue: ClipReq[] = [];
  /** Keys of the rows on screen. */
  private pinned = new Set<string>();
  /** Prefetches started this session. */
  private started = 0;
  private pausedUntil = 0;

  constructor(deps: AudioCacheDeps) {
    this.d = {
      now: () => Date.now(),
      // HTTP/2: one connection carries them all. Each clip is latency-bound
      // (~0.1 s, almost all of it waiting), so more at once fills sooner.
      maxConcurrent: 6,
      maxSession: 300,
      maxClips: 200,
      maxStock: 2,
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
    return { kind: "ok", url, from: "memory" };
  }

  /** Counters, for tests and the debug log. */
  get stats() {
    return {
      clips: this.clips.size,
      queued: this.queue.length,
      stocked: this.stockQueue.length,
      inFlight: this.flights.size,
      started: this.started,
      misses: this.misses.size,
    };
  }

  private wanted(r: ClipReq, key: string) {
    return (
      !!r.text &&
      !this.dead.has(r.lang) &&
      !this.misses.has(key) &&
      !this.failed.has(key) &&
      !this.clips.has(key) &&
      !this.flights.has(key)
    );
  }

  private unique(reqs: ClipReq[]) {
    const seen = new Set<string>();
    return reqs.filter((r) => {
      const key = keyOf(r);
      if (seen.has(key)) return false;
      seen.add(key);
      return this.wanted(r, key);
    });
  }

  /**
   * The clips wanted soon, most wanted first. Replaces the previous wish:
   * queued clips no longer in it are dropped, and their prefetches in flight
   * aborted. The first `pinned` are the rows on screen: kept in memory and on
   * disk whatever else comes in.
   */
  prefetch(reqs: ClipReq[], opts: PrefetchOptions = {}): void {
    this.pinned = new Set(reqs.slice(0, opts.pinned ?? 0).map(keyOf));
    if (this.d.disk)
      this.d.disk.pinned = new Set(
        reqs.slice(0, opts.pinned ?? 0).map((r) => ttsUrl(r.lang, r.text)),
      );
    if (!prefetchAllowed(this.d.connection?.()) || this.d.now() < this.pausedUntil) {
      this.queue = [];
      return;
    }
    const want = new Set(reqs.map(keyOf));
    for (const [key, f] of this.flights)
      if (f.kind === "prefetch" && !want.has(key)) {
        this.flights.delete(key);
        f.ctrl.abort();
        // Never answered, so never paid for: scrolling past rows must not use up the session.
        this.started--;
      }
    this.queue = this.unique(reqs);
    // The visible rows jump ahead of the due-word download.
    this.yieldStock(Math.min(this.queue.length, this.d.maxConcurrent));
    this.pump();
  }

  /**
   * Clips to have on disk, at the lowest priority (today's due words, for
   * offline study): never kept in memory, skipped when already stored.
   * Replaces the previous list.
   */
  stock(reqs: ClipReq[]): void {
    if (!this.d.disk) return;
    this.stockQueue = this.unique(reqs);
    this.pump();
  }

  /** The clip to play now: ahead of every prefetch. */
  load(lang: string, text: string): Promise<ClipResult> {
    const known = this.peek(lang, text);
    if (known) return Promise.resolve(known);
    const req = { lang, text };
    const key = keyOf(req);
    const flying = this.flights.get(key);
    if (flying && flying.kind !== "stock") {
      flying.kind = "tap";
      return flying.promise;
    }
    if (flying) this.abort(key, flying);
    this.queue = this.queue.filter((r) => keyOf(r) !== key);
    this.stockQueue = this.stockQueue.filter((r) => keyOf(r) !== key);
    if (this.flights.size >= this.d.maxConcurrent && !this.yieldStock(1)) {
      // Make room: the newest prefetch steps back to the front of the queue.
      const victim = [...this.flights].reverse().find(([, f]) => f.kind === "prefetch");
      if (victim) {
        this.abort(victim[0], victim[1]);
        this.started--;
        this.queue.unshift(victim[1].req);
      }
    }
    return this.start(req, "tap");
  }

  /** Every part of what is about to play, fetched now and together, ahead of every prefetch. */
  warm(reqs: ClipReq[]): void {
    for (const r of reqs) if (r.text) void this.load(r.lang, r.text);
  }

  private abort(key: string, f: Flight) {
    this.flights.delete(key);
    f.ctrl.abort();
  }

  /** Free up to `n` slots held by the due-word download; returns how many it freed. */
  private yieldStock(n: number): number {
    const free = this.d.maxConcurrent - this.flights.size;
    let need = n - Math.max(0, free);
    let freed = 0;
    for (const [key, f] of [...this.flights].reverse()) {
      if (need <= 0) break;
      if (f.kind !== "stock") continue;
      this.abort(key, f);
      this.stockQueue.unshift(f.req);
      need--;
      freed++;
    }
    return freed;
  }

  private pump() {
    while (
      this.queue.length &&
      this.flights.size < this.d.maxConcurrent &&
      this.started < this.d.maxSession
    ) {
      this.started++;
      void this.start(this.queue.shift()!, "prefetch");
    }
    // At the cap the queue waits: a prefetch that cost nothing gives its place back.
    if (this.queue.length && this.started < this.d.maxSession) return;
    if (!prefetchAllowed(this.d.connection?.()) || this.d.now() < this.pausedUntil) return;
    const stocking = () => [...this.flights.values()].filter((f) => f.kind === "stock").length;
    while (
      this.stockQueue.length &&
      this.flights.size < this.d.maxConcurrent &&
      stocking() < this.d.maxStock
    )
      void this.start(this.stockQueue.shift()!, "stock");
  }

  private start(req: ClipReq, kind: Kind): Promise<ClipResult> {
    const key = keyOf(req);
    const ctrl = new AbortController();
    const flight = { req, ctrl, kind, counted: kind === "prefetch" } as Flight;
    flight.promise = this.fromDiskOrNetwork(req, flight)
      .catch(() => ({ kind: "fail" }) as const)
      .finally(() => {
        if (this.flights.get(key) === flight) this.flights.delete(key);
        this.pump();
      });
    this.flights.set(key, flight);
    return flight.promise;
  }

  private async fromDiskOrNetwork(req: ClipReq, flight: Flight): Promise<ClipResult> {
    const url = ttsUrl(req.lang, req.text);
    const disk = this.d.disk;
    if (disk) {
      if (flight.kind === "stock") {
        if (await disk.has(url)) return { kind: "fail" };
      } else {
        const blob = await disk.get(url);
        if (flight.ctrl.signal.aborted) throw new DOMException("aborted", "AbortError");
        if (blob) {
          // Found on the device: no fetch, so it costs nothing.
          if (flight.counted) this.started--;
          this.d.log?.({
            ev: "disk",
            lang: req.lang,
            text: req.text,
            prefetch: flight.kind !== "tap",
          });
          return this.keep(req, blob, "disk");
        }
      }
    }
    const r = await this.d.fetch(url, { signal: flight.ctrl.signal });
    return this.settle(req, r, flight, url);
  }

  /** In memory as a blob URL, past the LRU cap the oldest out — never a row on screen. */
  private keep(req: ClipReq, blob: Blob, from: ClipSource): ClipResult {
    const key = keyOf(req);
    const url = this.d.createObjectURL(blob);
    this.clips.set(key, url);
    if (this.clips.size > this.d.maxClips)
      for (const [oldKey, oldUrl] of this.clips) {
        if (this.clips.size <= this.d.maxClips) break;
        if (oldKey === key || this.pinned.has(oldKey)) continue;
        this.clips.delete(oldKey);
        this.d.revokeObjectURL(oldUrl);
      }
    return { kind: "ok", url, from };
  }

  private async settle(
    req: ClipReq,
    r: Response,
    flight: Flight,
    url: string,
  ): Promise<ClipResult> {
    const key = keyOf(req);
    const voice = r.headers.get("X-Voice");
    this.d.log?.({
      ev: "server",
      lang: req.lang,
      text: req.text,
      status: r.status,
      voice,
      prefetch: flight.kind !== "tap",
      ...(flight.kind === "stock" ? { stock: true } : {}),
    });
    if (r.ok) {
      const blob = await r.blob();
      // A prefetch of a clip that was ready anyway cost nothing: give it back.
      // (After the body: one aborted mid-download was given back already.)
      if (flight.counted && FREE_VOICES.has(voice ?? "")) this.started--;
      void this.d.disk?.put(url, blob);
      if (flight.kind === "stock") return { kind: "fail" };
      return this.keep(req, blob, "network");
    }
    if (r.status === 400 || (r.status === 404 && voice === "miss")) {
      this.misses.add(key);
      return { kind: "miss" };
    }
    if (r.status === 404) {
      this.dead.add(req.lang);
      this.queue = this.queue.filter((q) => q.lang !== req.lang);
      this.stockQueue = this.stockQueue.filter((q) => q.lang !== req.lang);
      return { kind: "dead" };
    }
    if (r.status === 429) {
      const s = Number(r.headers.get("Retry-After"));
      this.pausedUntil = this.d.now() + (s > 0 ? s : 60) * 1000;
      this.queue = [];
    }
    if (flight.kind !== "tap") this.failed.add(key);
    return { kind: "fail", status: r.status };
  }
}
