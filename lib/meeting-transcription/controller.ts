import {
  checkAbort,
  MeetingTranscriptionError,
  validateFrame,
  validateCaptureFrame,
  type Embed,
  type LiveTranscriber,
  type MeetingLine,
  type MeetingLiveSettings,
  type MeetingOfflineSettings,
  type MeetingTrack,
  type MeetingTranscriptSdk,
  type PcmFrame,
  type Transcribe,
  type TranscriptGap,
} from "./contracts";

export interface AudioChunk {
  seq: number;
  startMs: number;
  durMs: number;
}
export interface TranscriptionLimits {
  maxFrameSamples: number;
  maxQueuedSamplesPerTrack: number;
  maxPendingLines: number;
  maxRowsPerWrite: number;
  maxLineChars: number;
  maxChunkBytes: number;
  maxChunkMs: number;
  maxMetadataBytes: number;
  maxChunksPerTrack: number;
  maxDecodeDriftMs: number;
}
export interface TranscriptionStatus {
  phase: "idle" | "starting" | "live" | "final" | "backpressure" | "stopped" | "done" | "error";
  code?: string;
  status?: number;
  gap?: TranscriptGap;
  range?: { track: MeetingTrack; startMs: number; endMs: number };
}
export interface MeetingTranscriptionOptions {
  meetingId: string;
  sdk: MeetingTranscriptSdk;
  transcribe: Transcribe & { close?(): void };
  embed?: Embed & { close?(): void };
  /** Read these through publicCfg at the host boundary; no hidden app defaults. */
  limits: TranscriptionLimits;
  live?: MeetingLiveSettings;
  final?: MeetingOfflineSettings;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  decodeChunk(bytes: ArrayBuffer, chunk: AudioChunk, signal: AbortSignal): Promise<Float32Array>;
  /** meetingRecorder().onPcm; this observes capture and never starts/stops the recorder. */
  subscribePcm?: (
    listener: (frame: { track: MeetingTrack; offset: number; samples: Float32Array }) => void,
  ) => () => void;
  onDraft(line: MeetingLine | null, track: MeetingTrack): void;
  onStatus(status: TranscriptionStatus): void;
}
type Run = {
  controller: AbortController;
  mode: "live" | "final";
  sdk?: LiveTranscriber;
  queues: Record<MeetingTrack, PcmFrame[]>;
  queued: Record<MeetingTrack, number>;
  ends: Record<MeetingTrack, number>;
  seenEnds: Record<MeetingTrack, number>;
  worker: Promise<void> | null;
  writes: Promise<void>;
  lines: number;
  accepting: boolean;
  unlinkAbort?: () => void;
  unsubscribePcm?: () => void;
};
const tracks: MeetingTrack[] = ["me", "others"];
const failure = (error: unknown) =>
  error instanceof MeetingTranscriptionError ? error : new MeetingTranscriptionError("provider");

/** Capture calls push synchronously and always continues its independent archival path. */
export function createMeetingTranscription(options: MeetingTranscriptionOptions) {
  const limitKeys: (keyof TranscriptionLimits)[] = [
    "maxFrameSamples",
    "maxQueuedSamplesPerTrack",
    "maxPendingLines",
    "maxRowsPerWrite",
    "maxLineChars",
    "maxChunkBytes",
    "maxChunkMs",
    "maxMetadataBytes",
    "maxChunksPerTrack",
  ];
  if (
    !/^[A-Za-z0-9_-]{1,128}$/.test(options.meetingId) ||
    limitKeys.some(
      (key) => !Number.isSafeInteger(options.limits[key]) || options.limits[key] < 1,
    ) ||
    options.limits.maxFrameSamples > options.limits.maxQueuedSamplesPerTrack
  )
    throw new MeetingTranscriptionError("config");
  if (!Number.isSafeInteger(options.limits.maxDecodeDriftMs) || options.limits.maxDecodeDriftMs < 0)
    throw new MeetingTranscriptionError("config");
  const base = `/api/my/meetings/${encodeURIComponent(options.meetingId)}`;
  const request = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  let current: Run | null = null;
  let closed = false;
  const alive = (run: Run) => current === run && !run.controller.signal.aborted && !closed;
  const guard = (run: Run) => {
    checkAbort(run.controller.signal);
    if (!alive(run)) throw new MeetingTranscriptionError("aborted");
  };
  const clear = (run: Run) => {
    run.accepting = false;
    run.unlinkAbort?.();
    run.unsubscribePcm?.();
    run.controller.abort();
    run.sdk?.close();
    options.transcribe.close?.();
    options.embed?.close?.();
    for (const track of tracks) {
      for (const frame of run.queues[track]) frame.samples.fill(0);
      run.queues[track] = [];
      run.queued[track] = 0;
    }
    if (current === run) current = null;
  };
  const fail = (run: Run, error: unknown) => {
    if (!alive(run)) return;
    const e = failure(error);
    clear(run);
    for (const track of tracks) options.onDraft(null, track);
    options.onStatus({ phase: "error", code: e.code, ...(e.status ? { status: e.status } : {}) });
  };
  const response = async (run: Run, path: string, init: RequestInit = {}) => {
    guard(run);
    let res: Response;
    try {
      res = await request(path, {
        credentials: "same-origin",
        redirect: "error",
        cache: "no-store",
        ...init,
        signal: run.controller.signal,
      });
    } catch {
      guard(run);
      throw new MeetingTranscriptionError("server");
    }
    guard(run);
    if (!res.ok) {
      try {
        await res.body?.cancel();
      } catch {
        /* Refusal still closes this run. */
      }
      throw new MeetingTranscriptionError("server", res.status);
    }
    return res;
  };
  const bytes = async (run: Run, res: Response, maximum: number): Promise<Uint8Array> => {
    const size = Number(res.headers.get("content-length"));
    if (Number.isFinite(size) && size > maximum) {
      try {
        await res.body?.cancel();
      } catch {
        /* Oversized input remains rejected. */
      }
      throw new MeetingTranscriptionError("output");
    }
    const reader = res.body?.getReader();
    if (!reader) return new Uint8Array();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        guard(run);
        const item = await reader.read();
        guard(run);
        if (item.done) break;
        length += item.value.length;
        if (length > maximum) throw new MeetingTranscriptionError("output");
        chunks.push(item.value);
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        /* A disconnected reader needs no retry. */
      }
      reader.releaseLock();
    }
    const result = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  };
  const line = (run: Run, value: MeetingLine): MeetingLine => {
    if (
      !value ||
      !tracks.includes(value.track) ||
      !Number.isSafeInteger(value.startMs) ||
      !Number.isSafeInteger(value.endMs) ||
      value.startMs < 0 ||
      value.endMs <= value.startMs ||
      value.endMs > Math.ceil(run.ends[value.track] / 16) ||
      value.id !== `${value.track}:${value.startMs}` ||
      typeof value.text !== "string" ||
      !value.text.trim() ||
      value.text.length > options.limits.maxLineChars ||
      typeof value.speaker !== "string" ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(value.speaker) ||
      (value.lang !== undefined && !/^[A-Za-z-]{1,32}$/.test(value.lang))
    )
      throw new MeetingTranscriptionError("output");
    return {
      id: value.id,
      track: value.track,
      startMs: value.startMs,
      endMs: value.endMs,
      speaker: value.speaker,
      text: value.text,
      ...(value.lang ? { lang: value.lang } : {}),
    };
  };
  const put = async (
    run: Run,
    source: "live" | "final",
    lines: MeetingLine[],
    replace?: { track: MeetingTrack; startMs: number; endMs: number },
  ) => {
    guard(run);
    if (lines.length > options.limits.maxRowsPerWrite)
      throw new MeetingTranscriptionError("output");
    const stored = lines.map((value) => {
      const { id: _id, ...row } = line(run, value);
      return row;
    });
    await response(run, `${base}/lines`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source, lines: stored, ...(replace ? { replace } : {}) }),
    });
  };
  const begin = async (
    choice: { userInitiated: true },
    mode: Run["mode"],
    signal?: AbortSignal,
  ): Promise<Run> => {
    if (choice?.userInitiated !== true) throw new MeetingTranscriptionError("choice");
    if (closed) throw new MeetingTranscriptionError("aborted");
    if (current) throw new MeetingTranscriptionError("busy");
    const run: Run = {
      controller: new AbortController(),
      mode,
      queues: { me: [], others: [] },
      queued: { me: 0, others: 0 },
      ends: { me: 0, others: 0 },
      seenEnds: { me: 0, others: 0 },
      worker: null,
      writes: Promise.resolve(),
      lines: 0,
      accepting: false,
    };
    current = run;
    options.onStatus({ phase: "starting" });
    if (signal) {
      const cancel = () => clear(run);
      signal.addEventListener("abort", cancel, { once: true });
      run.unlinkAbort = () => signal.removeEventListener("abort", cancel);
      if (signal.aborted) cancel();
    }
    try {
      await response(run, base);
      return run;
    } catch (error) {
      fail(run, error);
      throw failure(error);
    }
  };
  const pump = (run: Run) => {
    if (run.worker || !alive(run)) return;
    run.worker = (async () => {
      let turn = 0;
      while (alive(run)) {
        const track = run.queues[tracks[turn % 2]].length
          ? tracks[turn % 2]
          : tracks[(turn + 1) % 2];
        turn++;
        const frame = run.queues[track].shift();
        if (!frame) break;
        try {
          await run.sdk!.push(frame);
          guard(run);
        } finally {
          frame.samples.fill(0);
          if (alive(run)) run.queued[track] -= frame.samples.length;
        }
      }
    })()
      .catch((error) => fail(run, error))
      .finally(() => {
        run.worker = null;
        if (alive(run) && tracks.some((track) => run.queues[track].length)) pump(run);
      });
  };
  const consumer = {
    async startLive(choice: { userInitiated: true }) {
      const run = await begin(choice, "live");
      try {
        guard(run);
        run.sdk = options.sdk.createLiveTranscriber({
          ...options.live,
          transcribe: options.transcribe,
          onDraft(value, track) {
            if (!alive(run)) return;
            try {
              options.onDraft(value ? line(run, value) : null, track);
            } catch (error) {
              fail(run, error);
            }
          },
          onGap(gap) {
            if (alive(run)) options.onStatus({ phase: "backpressure", code: "gap", gap });
          },
          onStatus(status) {
            if (alive(run))
              options.onStatus({
                phase: "live",
                code: status.kind,
                range: { track: status.track, startMs: status.startMs, endMs: status.endMs },
              });
          },
          onStable(values) {
            if (!alive(run)) return;
            try {
              const owned = values.map((value) => line(run, value));
              if (!owned.length) return;
              if (
                run.lines + owned.length > options.limits.maxPendingLines ||
                owned.length > options.limits.maxRowsPerWrite
              )
                throw new MeetingTranscriptionError("busy");
              run.lines += owned.length;
              run.writes = run.writes
                .then(async () => {
                  guard(run);
                  await put(run, "live", owned);
                })
                .catch((error) => fail(run, error))
                .finally(() => {
                  run.lines -= owned.length;
                });
            } catch (error) {
              fail(run, error);
            }
          },
        });
        run.accepting = true;
        run.unsubscribePcm = options.subscribePcm?.((frame) => {
          if (alive(run))
            consumer.push({
              track: frame.track,
              startSample: frame.offset,
              samples: frame.samples,
            });
        });
        options.onStatus({ phase: "live" });
      } catch (error) {
        fail(run, error);
        throw failure(error);
      }
    },
    push(frame: PcmFrame): boolean {
      const run = current;
      if (!run || run.mode !== "live" || !alive(run) || !run.accepting) return false;
      try {
        validateCaptureFrame(frame, options.limits.maxFrameSamples);
        if (frame.startSample < run.seenEnds[frame.track])
          throw new MeetingTranscriptionError("timeline");
        run.seenEnds[frame.track] = frame.startSample + frame.samples.length;
        if (
          run.queued[frame.track] + frame.samples.length >
          options.limits.maxQueuedSamplesPerTrack
        ) {
          options.onStatus({
            phase: "backpressure",
            code: "queue",
            gap: {
              track: frame.track,
              startSample: frame.startSample,
              endSample: frame.startSample + frame.samples.length,
            },
          });
          return false;
        }
        const samples = frame.samples.slice();
        for (let i = 0; i < samples.length; i++) samples[i] = Math.max(-1, Math.min(1, samples[i]));
        const owned = { track: frame.track, startSample: frame.startSample, samples };
        run.ends[frame.track] = frame.startSample + frame.samples.length;
        run.queued[frame.track] += frame.samples.length;
        run.queues[frame.track].push(owned);
        pump(run);
        return true;
      } catch (error) {
        fail(run, error);
        return false;
      }
    },
    /** Drain and flush at the end of capture; drafts themselves are never written. */
    async finishLive() {
      const run = current;
      if (!run || run.mode !== "live") return;
      run.accepting = false;
      run.unsubscribePcm?.();
      run.unsubscribePcm = undefined;
      try {
        await run.worker;
        guard(run);
        await run.sdk!.flush();
        guard(run);
        await run.writes;
        guard(run);
        clear(run);
        for (const track of tracks) options.onDraft(null, track);
        options.onStatus({ phase: "done" });
      } catch (error) {
        if (run.controller.signal.aborted) throw new MeetingTranscriptionError("aborted");
        fail(run, error);
        throw failure(error);
      }
    },
    stop() {
      if (current) clear(current);
      for (const track of tracks) options.onDraft(null, track);
      options.onStatus({ phase: "stopped" });
    },
    async runFinal(choice: { userInitiated: true }, signal?: AbortSignal) {
      if (signal?.aborted) throw new MeetingTranscriptionError("aborted");
      const run = await begin(choice, "final", signal);
      options.onStatus({ phase: "final" });
      const completed: Record<MeetingTrack, number> = { me: 0, others: 0 };
      const frames = async function* (): AsyncGenerator<PcmFrame> {
        for (const track of tracks) {
          const res = await response(run, `${base}/chunks?track=${track}`);
          let chunks: (AudioChunk & { track: MeetingTrack })[];
          try {
            chunks = JSON.parse(
              new TextDecoder().decode(await bytes(run, res, options.limits.maxMetadataBytes)),
            ).chunks;
          } catch (error) {
            if (error instanceof MeetingTranscriptionError) throw error;
            throw new MeetingTranscriptionError("output");
          }
          if (!Array.isArray(chunks) || chunks.length > options.limits.maxChunksPerTrack)
            throw new MeetingTranscriptionError("output");
          let end = 0,
            seq = -1;
          for (const chunk of chunks) {
            guard(run);
            if (
              !chunk ||
              chunk.track !== track ||
              !Number.isSafeInteger(chunk.seq) ||
              chunk.seq <= seq ||
              !Number.isSafeInteger(chunk.startMs) ||
              chunk.startMs < end ||
              !Number.isSafeInteger(chunk.durMs) ||
              chunk.durMs < 1 ||
              chunk.durMs > options.limits.maxChunkMs ||
              !Number.isSafeInteger((chunk.startMs + chunk.durMs) * 16)
            )
              throw new MeetingTranscriptionError("timeline");
            seq = chunk.seq;
            end = chunk.startMs + chunk.durMs;
            const audio = await response(run, `${base}/chunks/${track}/${chunk.seq}`);
            const headerStart = audio.headers.get("x-lk-start-ms"),
              headerDuration = audio.headers.get("x-lk-dur-ms");
            if (
              headerStart === null ||
              headerDuration === null ||
              Number(headerStart) !== chunk.startMs ||
              Number(headerDuration) !== chunk.durMs
            ) {
              try {
                await audio.body?.cancel();
              } catch {
                /* Mismatched metadata remains rejected. */
              }
              throw new MeetingTranscriptionError("timeline");
            }
            const encoded = await bytes(run, audio, options.limits.maxChunkBytes);
            const decodeBytes = encoded.slice();
            let samples: Float32Array | undefined;
            try {
              guard(run);
              try {
                samples = await options.decodeChunk(
                  decodeBytes.buffer as ArrayBuffer,
                  chunk,
                  run.controller.signal,
                );
              } catch {
                guard(run);
                throw new MeetingTranscriptionError("decode");
              }
              guard(run);
              const frame = { track, startSample: chunk.startMs * 16, samples };
              validateFrame(frame, options.limits.maxChunkMs * 16);
              if (
                samples.length > chunk.durMs * 16 ||
                chunk.durMs * 16 - samples.length > options.limits.maxDecodeDriftMs * 16
              )
                throw new MeetingTranscriptionError("timeline");
              run.ends[track] = frame.startSample + samples.length;
              yield frame;
            } finally {
              samples?.fill(0);
              encoded.fill(0);
              // Native decodeAudioData is allowed to detach its input buffer.
              try {
                decodeBytes.fill(0);
              } catch {
                /* Detached storage is no longer readable here. */
              }
            }
          }
        }
      };
      try {
        const output = options.sdk.transcribeMeeting(
          frames(),
          {
            ...options.final,
            transcribe: options.transcribe,
            ...(options.embed ? { embed: options.embed } : {}),
            onGap(gap) {
              if (alive(run)) options.onStatus({ phase: "backpressure", code: "gap", gap });
            },
            async onWindow(window) {
              guard(run);
              if (
                !tracks.includes(window.track) ||
                !Number.isSafeInteger(window.startMs) ||
                !Number.isSafeInteger(window.endMs) ||
                window.startMs < completed[window.track] ||
                window.endMs <= window.startMs ||
                window.endMs > Math.ceil(run.ends[window.track] / 16) ||
                !Array.isArray(window.lines) ||
                window.lines.some(
                  (value) =>
                    value.track !== window.track ||
                    value.startMs < window.startMs ||
                    value.endMs > window.endMs,
                )
              )
                throw new MeetingTranscriptionError("output");
              await put(run, "final", window.lines, {
                track: window.track,
                startMs: window.startMs,
                endMs: window.endMs,
              });
              guard(run);
              completed[window.track] = window.endMs;
            },
          },
          run.controller.signal,
        );
        for await (const _line of output) guard(run);
        guard(run);
        if (tracks.some((track) => completed[track] !== Math.round(run.ends[track] / 16)))
          throw new MeetingTranscriptionError("output");
        clear(run);
        options.onStatus({ phase: "done" });
      } catch (error) {
        if (run.controller.signal.aborted) throw new MeetingTranscriptionError("aborted");
        fail(run, error);
        throw failure(error);
      }
    },
    bufferedSamples() {
      return current
        ? current.queued.me + current.queued.others + (current.sdk?.bufferedSamples() ?? 0)
        : 0;
    },
    close() {
      closed = true;
      if (current) clear(current);
      for (const track of tracks) options.onDraft(null, track);
    },
  };
  return consumer;
}
