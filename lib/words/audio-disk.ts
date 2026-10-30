/**
 * Word clips kept on the device (the Cache API, "lianki-audio-v1"), so a clip
 * played or prefetched once plays the next time with no network at all —
 * offline too. The browser's HTTP cache would do the same in theory, but on
 * an iOS home-screen app it is dropped too often to count on.
 *
 * - Only 200s are stored (audio-cache.ts never hands over a miss or an error).
 * - Least recently used first out, past `maxEntries` clips or `maxBytes` —
 *   never a clip in `pinned` (the rows on screen).
 * - The index (size and last use of each clip) lives in the same cache, as
 *   one JSON entry: no IndexedDB schema change. An index lost or behind the
 *   cache is harmless — a clip found without an entry gets one, an entry
 *   whose clip is gone is dropped.
 *
 * Pure: the cache is passed in, so eviction is unit-tested with fakes
 * (unit/words-audio-disk.test.ts).
 */

export const AUDIO_CACHE_NAME = "lianki-audio-v1";
const INDEX_URL = "/__lianki-audio-index.json";

export type CacheLike = {
  match(url: string): Promise<Response | undefined>;
  put(url: string, res: Response): Promise<void>;
  delete(url: string): Promise<boolean>;
};

export type DiskEntry = { size: number; used: number };
export type DiskIndex = Record<string, DiskEntry>;

export type AudioDiskDeps = {
  open: () => Promise<CacheLike>;
  now?: () => number;
  maxEntries?: number;
  maxBytes?: number;
};

/**
 * Which clips to drop so the rest fit: oldest use first, skipping `pinned`.
 * When only pinned clips are left over the limit, they stay — over the cap
 * beats a silent row on screen.
 */
export function pickEvictions(
  index: DiskIndex,
  maxEntries: number,
  maxBytes: number,
  pinned: ReadonlySet<string> = new Set(),
): string[] {
  const urls = Object.keys(index);
  let count = urls.length;
  let bytes = urls.reduce((n, u) => n + index[u].size, 0);
  if (count <= maxEntries && bytes <= maxBytes) return [];
  const out: string[] = [];
  const oldest = urls.filter((u) => !pinned.has(u)).sort((a, b) => index[a].used - index[b].used);
  for (const u of oldest) {
    if (count <= maxEntries && bytes <= maxBytes) break;
    out.push(u);
    count--;
    bytes -= index[u].size;
  }
  return out;
}

export class AudioDisk {
  private readonly d: Required<AudioDiskDeps>;
  private cache: Promise<CacheLike> | null = null;
  private index: Promise<DiskIndex> | null = null;
  private saving: Promise<void> | null = null;
  private dirty = false;
  /** URLs that must not be evicted: the rows on screen. */
  pinned: ReadonlySet<string> = new Set();

  constructor(deps: AudioDiskDeps) {
    this.d = {
      now: () => Date.now(),
      // Clips are ~10–40 KB: a few thousand is every word of a long list.
      maxEntries: 4000,
      maxBytes: 120 * 1024 * 1024,
      ...deps,
    };
  }

  private open() {
    return (this.cache ??= this.d.open());
  }

  private loadIndex(): Promise<DiskIndex> {
    return (this.index ??= this.open()
      .then((c) => c.match(INDEX_URL))
      .then((r) => (r ? (r.json() as Promise<DiskIndex>) : {}))
      .catch(() => ({})));
  }

  /** Write the index once for any number of changes made meanwhile. */
  private save() {
    this.dirty = true;
    this.saving ??= (async () => {
      await Promise.resolve();
      while (this.dirty) {
        this.dirty = false;
        const [c, idx] = await Promise.all([this.open(), this.loadIndex()]);
        await c.put(
          INDEX_URL,
          new Response(JSON.stringify(idx), { headers: { "Content-Type": "application/json" } }),
        );
      }
    })()
      .catch(() => {})
      .finally(() => {
        this.saving = null;
      });
    return this.saving;
  }

  /** Settles once pending index writes are done (for tests). */
  flush() {
    return this.saving ?? Promise.resolve();
  }

  /** The stored clip, or null. A hit counts as a use. */
  async get(url: string): Promise<Blob | null> {
    try {
      const [c, idx] = await Promise.all([this.open(), this.loadIndex()]);
      const r = await c.match(url);
      if (!r) {
        if (idx[url]) {
          delete idx[url];
          void this.save();
        }
        return null;
      }
      const blob = await r.blob();
      idx[url] = { size: blob.size, used: this.d.now() };
      void this.save();
      return blob;
    } catch {
      return null;
    }
  }

  /** Known to be stored, without reading it (for the due-word download). */
  async has(url: string): Promise<boolean> {
    try {
      return !!(await this.loadIndex())[url];
    } catch {
      return false;
    }
  }

  /** Keep a clip, then drop the least recently used past the caps. */
  async put(url: string, blob: Blob): Promise<void> {
    try {
      const [c, idx] = await Promise.all([this.open(), this.loadIndex()]);
      await c.put(
        url,
        new Response(blob, { headers: { "Content-Type": blob.type || "audio/mpeg" } }),
      );
      idx[url] = { size: blob.size, used: this.d.now() };
      const pinned = new Set([...this.pinned, url]);
      for (const old of pickEvictions(idx, this.d.maxEntries, this.d.maxBytes, pinned)) {
        delete idx[old];
        await c.delete(old).catch(() => false);
      }
      void this.save();
    } catch {
      // Storage full or refused: the clip still plays from memory.
    }
  }

  async stats() {
    const idx = await this.loadIndex();
    const urls = Object.keys(idx);
    return { clips: urls.length, bytes: urls.reduce((n, u) => n + idx[u].size, 0) };
  }
}
