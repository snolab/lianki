/** Account-private original recordings. Never uses the public language/text audio cache. */
import {
  AUDIO_LIMITS,
  collectNativeMember,
  nativeWordIndex,
  parseNativeManifest,
  validateArchiveMembers,
  type NativeChapter,
  type NativeWord,
} from "../../vendor/otoji/packages/private-word-audio/src/index";

export const NATIVE_AUDIO_PREF = "words.nativeAudioManifest";
export type NativeCard = { listId: string; term: string; key?: string };
export type NativeClip = { url: string; startMs: number; endMs: number; estimated: true };
type Reference = { version: 1; fileId: string; sha256: string };
export type NativeAudioDeps = {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  timeoutMs: () => number;
  createObjectURL: (blob: Blob) => string;
  revokeObjectURL: (url: string) => void;
  extract?: (bytes: Uint8Array, chapter: NativeChapter, signal: AbortSignal) => Promise<Uint8Array>;
  digest?: (bytes: Uint8Array) => Promise<string>;
};
const digest = async (bytes: Uint8Array) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.buffer as ArrayBuffer))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

function reference(value: unknown): Reference | null {
  const r = value as Partial<Reference> | null;
  if (
    !r ||
    r.version !== 1 ||
    typeof r.fileId !== "string" ||
    !/^[a-f0-9]{20}$/.test(r.fileId) ||
    typeof r.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(r.sha256)
  )
    return null;
  return r as Reference;
}

async function boundedBody(
  response: Response,
  max: number,
  signal: AbortSignal,
  progress?: () => void,
): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > max || !response.body) throw Error("native-audio-size");
  const reader = response.body.getReader(),
    parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      progress?.();
      if (size > max) throw Error("native-audio-size");
      parts.push(value);
    }
    signal.throwIfAborted();
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const p of parts) {
      bytes.set(p, at);
      at += p.length;
    }
    return bytes;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
    for (const p of parts) p.fill(0);
  }
}

/** jszip is loaded only after a private binding is selected; streamed output stays bounded. */
export async function extractNativeChapter(
  bytes: Uint8Array,
  chapter: NativeChapter,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(bytes);
  signal.throwIfAborted();
  validateArchiveMembers(Object.keys(zip.files), chapter.memberPath);
  const member = zip.file(chapter.memberPath);
  if (!member) throw Error("native-audio-member");
  type Stream = {
    on(event: "data", listener: (value: Uint8Array) => void): Stream;
    on(event: "end", listener: () => void): Stream;
    on(event: "error", listener: (error: Error) => void): Stream;
    pause(): Stream;
    resume(): Stream;
  };
  const stream = (
    member as unknown as { internalStream(type: "uint8array"): Stream }
  ).internalStream("uint8array");
  async function* chunks() {
    let ended = false,
      error: unknown,
      queuedBytes = 0;
    const queued: Uint8Array[] = [];
    let notify: (() => void) | undefined;
    const abort = () => {
      error = signal.reason ?? Error("native-audio-canceled");
      stream.pause();
      notify?.();
    };
    stream.on("data", (value) => {
      stream.pause();
      queuedBytes += value.byteLength;
      if (queuedBytes > chapter.bytes) error = Error("native-audio-size");
      else queued.push(value);
      notify?.();
    });
    stream.on("end", () => {
      ended = true;
      notify?.();
    });
    stream.on("error", (e) => {
      error = e;
      notify?.();
    });
    signal.addEventListener("abort", abort, { once: true });
    try {
      for (;;) {
        signal.throwIfAborted();
        if (error) throw error;
        if (queued.length) {
          const value = queued.shift()!;
          queuedBytes -= value.length;
          yield value;
          continue;
        }
        if (ended) break;
        await new Promise<void>((resolve) => {
          notify = resolve;
          stream.resume();
        });
        notify = undefined;
      }
    } finally {
      stream.pause();
      signal.removeEventListener("abort", abort);
      for (const value of queued) value.fill(0);
    }
  }
  return collectNativeMember(chunks(), chapter.bytes, bytes.byteLength, signal);
}

/** Wait for `task` until `signal` aborts; the task itself goes on. */
function until<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    task.then(
      (v) => {
        signal.removeEventListener("abort", abort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", abort);
        reject(e);
      },
    );
  });
}

export class NativeAudioClient {
  private readonly life = new AbortController();
  private assets = new AbortController();
  private epoch = 0;
  private account: string | null = null;
  private refKey = "";
  private find: ReturnType<typeof nativeWordIndex> | null = null;
  private archive: { id: string; bytes: Uint8Array } | null = null;
  private clip: { id: string; url: string } | null = null;
  /**
   * The archive being downloaded. It belongs to the client, not to a card: a
   * card change stops waiting for it but never aborts it, so a slow archive
   * finishes in the background and the next card uses it. Only a stall
   * (no bytes for `timeoutMs`), a fence (clear/dispose) or a failure ends it.
   */
  private download: { id: string; epoch: number; task: Promise<void> } | null = null;
  private preparing: Promise<void> | null = null;
  private prepared = false;
  private disposed = false;
  constructor(private readonly d: NativeAudioDeps) {}
  get ready() {
    return this.prepared;
  }
  get enabled() {
    return this.find !== null;
  }
  has(card: NativeCard) {
    return !!this.find?.(card.listId, card.term, card.key);
  }

  private signal(signal?: AbortSignal, files = false) {
    return AbortSignal.any([
      this.life.signal,
      ...(files ? [this.assets.signal] : []),
      ...(signal ? [signal] : []),
      AbortSignal.timeout(this.d.timeoutMs()),
    ]);
  }
  private check(epoch: number, signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.disposed || epoch !== this.epoch) throw Error("native-audio-stale");
  }
  private clearAssets() {
    this.epoch++;
    this.download = null;
    this.assets.abort();
    this.assets = new AbortController();
    this.archive?.bytes.fill(0);
    this.archive = null;
    if (this.clip) this.d.revokeObjectURL(this.clip.url);
    this.clip = null;
    this.find = null;
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.life.abort();
    this.clearAssets();
    this.account = null;
    this.refKey = "";
  }
  /** Visibility/logout fences drop all private assets before any pending callback can reuse them. */
  clear() {
    this.clearAssets();
    this.refKey = "";
    this.prepared = false;
  }
  async prepare() {
    this.preparing ??= this.refresh()
      .then(() => {
        this.prepared = true;
      })
      .catch(() => {
        this.prepared = false;
      })
      .finally(() => {
        this.preparing = null;
      });
    await this.preparing;
  }
  private async ownFile(id: string, max: number, signal: AbortSignal, progress?: () => void) {
    const response = await this.d.fetch(`/api/my/files/${id}`, {
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      signal,
    });
    if (!response.ok) {
      if ([401, 403, 404].includes(response.status)) this.dispose();
      throw Error("native-audio-unavailable");
    }
    return boundedBody(response, max, signal, progress);
  }
  /** Fetch (or join the fetch of) a chapter's archive; it ends only on a stall or a fence. */
  private fetchArchive(chapter: NativeChapter, id: string): Promise<void> {
    if (this.download?.id === id && this.download.epoch === this.epoch) return this.download.task;
    const run = this.epoch,
      stall = new AbortController(),
      signal = AbortSignal.any([this.life.signal, this.assets.signal, stall.signal]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const progress = () => {
      clearTimeout(timer);
      timer = setTimeout(() => stall.abort(Error("native-audio-stalled")), this.d.timeoutMs());
    };
    progress();
    const task = (async () => {
      const bytes = await this.ownFile(
        chapter.inboxItemId,
        AUDIO_LIMITS.archiveBytes,
        signal,
        progress,
      );
      try {
        clearTimeout(timer);
        if ((await (this.d.digest ?? digest)(bytes)) !== chapter.archiveSha256)
          throw Error("native-audio-hash");
        this.check(run, signal);
        if (this.archive?.id !== id) this.archive?.bytes.fill(0);
        this.archive = { id, bytes };
      } catch (e) {
        bytes.fill(0);
        throw e;
      }
    })().finally(() => {
      clearTimeout(timer);
      if (this.download?.task === task) this.download = null;
    });
    // Nobody may be waiting any more: a failure here is only a retry next time.
    task.catch(() => {});
    this.download = { id, epoch: run, task };
    return task;
  }
  private async refresh(signal?: AbortSignal) {
    const request = this.signal(signal),
      before = this.epoch;
    const response = await this.d.fetch("/api/prefs", {
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      signal: request,
    });
    if (!response.ok) {
      this.dispose();
      throw Error("native-audio-account");
    }
    const body = await response.json();
    this.check(before, request);
    if (typeof body?.user !== "string" || (this.account && body.user !== this.account)) {
      this.dispose();
      throw Error("native-audio-account");
    }
    this.account = body.user;
    const ref = reference(body?.prefs?.[NATIVE_AUDIO_PREF]?.value);
    const key = ref ? `${ref.fileId}:${ref.sha256}` : "none";
    if (key === this.refKey) return;
    this.clearAssets();
    this.refKey = "";
    if (!ref) {
      this.refKey = key;
      return;
    }
    const run = this.epoch,
      fileSignal = this.signal(signal, true);
    const bytes = await this.ownFile(ref.fileId, AUDIO_LIMITS.manifestBytes, fileSignal);
    try {
      if ((await (this.d.digest ?? digest)(bytes)) !== ref.sha256) throw Error("native-audio-hash");
      this.check(run, fileSignal);
      this.find = nativeWordIndex(parseNativeManifest(new TextDecoder().decode(bytes)));
      this.refKey = key;
    } finally {
      bytes.fill(0);
    }
  }

  /** Reauthenticate even a memory hit; another account never inherits an unlocked chapter. */
  async load(card: NativeCard, signal: AbortSignal): Promise<NativeClip | null> {
    if (this.disposed) return null;
    try {
      if (this.preparing) await this.preparing;
      await this.refresh(signal);
      this.prepared = true;
      const word: NativeWord | undefined = this.find?.(card.listId, card.term, card.key);
      if (!word) return null;
      const run = this.epoch,
        request = this.signal(signal, true),
        chapter = word.chapter;
      const archiveId = `${chapter.inboxItemId}:${chapter.archiveSha256}`;
      const clipId = `${archiveId}:${chapter.sha256}`;
      if (this.clip?.id !== clipId) {
        if (this.archive?.id !== archiveId) {
          await until(this.fetchArchive(chapter, archiveId), request);
          this.check(run, request);
          if (this.archive?.id !== archiveId) throw Error("native-audio-stale");
        }
        const bytes = await (this.d.extract ?? extractNativeChapter)(
          this.archive!.bytes,
          chapter,
          request,
        );
        try {
          if ((await (this.d.digest ?? digest)(bytes)) !== chapter.sha256)
            throw Error("native-audio-hash");
          this.check(run, request);
          const url = this.d.createObjectURL(
            new Blob([bytes.buffer as ArrayBuffer], { type: "audio/mpeg" }),
          );
          if (this.clip) this.d.revokeObjectURL(this.clip.url);
          this.clip = { id: clipId, url };
        } finally {
          bytes.fill(0);
        }
      }
      this.check(run, request);
      return {
        url: this.clip!.url,
        startMs: word.entry.startMs,
        endMs: word.entry.endMs,
        estimated: true,
      };
    } catch {
      return null;
    }
  }
}
