/**
 * The browser's piece queue (docs/meetings.md, "Pieces"): every piece goes
 * to IndexedDB (`lk-meetings`, keyed `<meeting>/<track>/<seq>`) before it is
 * uploaded, and leaves only once the server has confirmed it — so a crash,
 * reload or lost network costs at most the piece being recorded.
 *
 * One upload at a time, in order. On a network error, 5xx, 408 or 429 it
 * retries after 2, 10, 30 and 60 s, then waits for the `online` event (no
 * polling). 401/403/404/409/413 stop the meeting (flag off, signed out,
 * deleted, closed, quota full). A 400 drops that piece (it can never succeed).
 *
 * The store, fetch, timers and the online event are injected, so this is
 * unit-tested without a browser; lib/meetings/idb.ts is the IndexedDB store.
 */
import { type Track, seqName } from "./core";

export type QueuedPiece = {
  meeting: string;
  track: Track;
  seq: number;
  startMs: number;
  durMs: number;
  fragOff: number | null;
  fragMs: number | null;
  sha256: string;
  bytes: ArrayBuffer;
  /** When it was recorded (ms since the epoch), for ordering left-overs. */
  at: number;
};
export const pieceKey = (p: Pick<QueuedPiece, "meeting" | "track" | "seq">) =>
  `${p.meeting}/${p.track}/${seqName(p.seq)}`;

export type PieceStore = {
  put(p: QueuedPiece): Promise<void>;
  delete(key: string): Promise<void>;
  /** Every queued piece, oldest first. */
  all(): Promise<QueuedPiece[]>;
};

/** What an answer means for the queue. */
export type Verdict = "done" | "retry" | "drop" | "stop";
export function verdictOf(status: number | null): Verdict {
  if (status === null) return "retry";
  if (status >= 200 && status < 300) return "done";
  if (status === 408 || status === 429 || status >= 500) return "retry";
  if (status === 400) return "drop";
  return "stop";
}
export const RETRY_DELAYS_MS = [2_000, 10_000, 30_000, 60_000] as const;
/** The wait before retry `n` (0-based), or null: wait for `online`. */
export const retryDelay = (n: number): number | null => RETRY_DELAYS_MS[n] ?? null;

export type UploaderDeps = {
  store: PieceStore;
  /** PUT one piece; the HTTP status, or null for a network error. */
  send(p: QueuedPiece): Promise<number | null>;
  setTimer(f: () => void, ms: number): unknown;
  clearTimer(t: unknown): void;
  /** Call `f` on the next `online` event; returns the unsubscribe. */
  onOnline(f: () => void): () => void;
  /** The server refused this meeting for good (status given). */
  onStop?(meeting: string, status: number): void;
  /** The queue changed (count of pieces waiting). */
  onChange?(waiting: number): void;
};

export class Uploader {
  private waiting: QueuedPiece[] = [];
  private busy = false;
  private tries = 0;
  private timer: unknown = null;
  private offOnline: (() => void) | null = null;
  private stopped = new Set<string>();
  private idleWaiters: (() => void)[] = [];
  constructor(private readonly d: UploaderDeps) {}

  get count() {
    return this.waiting.length;
  }

  /** Store first, then queue for upload. */
  async add(p: QueuedPiece): Promise<void> {
    if (this.stopped.has(p.meeting)) return;
    await this.d.store.put(p);
    this.waiting.push(p);
    this.changed();
    this.kick();
  }

  /** Pieces left in the store from an earlier page (resume on the next visit). */
  async loadLeftovers(skipMeeting?: string): Promise<string[]> {
    const have = new Set(this.waiting.map(pieceKey));
    const all = (await this.d.store.all()).filter(
      (p) => p.meeting !== skipMeeting && !have.has(pieceKey(p)),
    );
    all.sort((a, b) => a.at - b.at || a.seq - b.seq);
    this.waiting.push(...all);
    this.changed();
    this.kick();
    return [...new Set(all.map((p) => p.meeting))];
  }

  /** Resolves when nothing waits any more. */
  idle(): Promise<void> {
    if (!this.waiting.length) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }

  /** Pieces of this meeting still waiting. */
  pending(meeting: string) {
    return this.waiting.filter((p) => p.meeting === meeting).length;
  }

  private changed() {
    this.d.onChange?.(this.waiting.length);
    if (!this.waiting.length) for (const r of this.idleWaiters.splice(0)) r();
  }

  /** Retry now (a tap, or the `online` event). */
  kick() {
    if (this.timer !== null) {
      this.d.clearTimer(this.timer);
      this.timer = null;
    }
    this.offOnline?.();
    this.offOnline = null;
    void this.pump();
  }

  private async pump() {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.waiting.length) {
        const p = this.waiting[0];
        if (this.stopped.has(p.meeting)) {
          await this.forget(p);
          continue;
        }
        let status: number | null = null;
        try {
          status = await this.d.send(p);
        } catch {
          status = null;
        }
        const v = verdictOf(status);
        if (v === "done" || v === "drop") {
          this.tries = 0;
          await this.forget(p);
          continue;
        }
        if (v === "stop") {
          this.tries = 0;
          this.stopped.add(p.meeting);
          this.d.onStop?.(p.meeting, status as number);
          await this.forget(p);
          continue;
        }
        const wait = retryDelay(this.tries++);
        if (wait === null) {
          this.offOnline = this.d.onOnline(() => {
            this.tries = 0;
            this.kick();
          });
        } else {
          this.timer = this.d.setTimer(() => {
            this.timer = null;
            void this.pump();
          }, wait);
        }
        return;
      }
    } finally {
      this.busy = false;
    }
  }

  private async forget(p: QueuedPiece) {
    this.waiting.shift();
    await this.d.store.delete(pieceKey(p)).catch(() => {});
    this.changed();
  }
}

/** A store in memory (tests, and a fallback where IndexedDB is unavailable). */
export function memoryStore(): PieceStore & { map: Map<string, QueuedPiece> } {
  const map = new Map<string, QueuedPiece>();
  return {
    map,
    async put(p) {
      map.set(pieceKey(p), p);
    },
    async delete(k) {
      map.delete(k);
    },
    async all() {
      return [...map.values()].sort((a, b) => a.at - b.at);
    },
  };
}

/** The PUT of one piece (fetch injected). */
export async function sendPiece(p: QueuedPiece, f: typeof fetch = fetch): Promise<number | null> {
  try {
    const r = await f(`/api/my/meetings/${p.meeting}/chunks/${p.track}/${p.seq}`, {
      method: "PUT",
      headers: {
        "content-type": "application/octet-stream",
        "x-lk-sha256": p.sha256,
        "x-lk-start-ms": String(Math.max(0, Math.round(p.startMs))),
        "x-lk-dur-ms": String(Math.max(0, Math.round(p.durMs))),
        "x-lk-frag-off": p.fragOff === null ? "" : String(p.fragOff),
        "x-lk-frag-ms": p.fragMs === null ? "" : String(Math.max(0, Math.round(p.fragMs))),
      },
      body: p.bytes,
    });
    return r.status;
  } catch {
    return null;
  }
}
