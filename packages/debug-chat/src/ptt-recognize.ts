import type { LocalFinal, LocalStt, LocalUtt } from "./local-stt";
import type { RecheckMark, SttTag, VoiceTiming } from "./wire";

type Decode = { text: string; model?: string; language?: string; ms?: number };
export type PttRecognition = {
  text: string;
  audioMs: number;
  stt?: SttTag;
  timing: VoiceTiming;
  recheck?: RecheckMark;
  speakerProof?: string[];
};

/** One press, with injected PCM/transport/clock. It owns no microphone or polling timer. */
export function createPttRecognition(d: {
  now: () => number;
  run: string;
  rate: number;
  startAt: number;
  maxCaptureMs: number;
  localSegmentMs: number;
  partialMinMs: number;
  partialEveryMs: number;
  requestTimeoutMs: number;
  timeout?: (ms: number) => AbortSignal;
  recheck?: { maxSec: number; timeoutMs: number };
  local?: LocalStt;
  cloud: (audio: Float32Array, signal: AbortSignal) => Promise<Decode>;
  onPartial?: (text: string) => void;
  onFailure?: (error: Error) => void;
}) {
  const ac = new AbortController();
  const chunks: { audio: Float32Array; at: number }[] = [];
  const finals: Promise<LocalFinal | undefined>[] = [];
  let current: LocalUtt | null = null;
  let currentAudio: Float32Array[] = [];
  let currentSamples = 0;
  let count = 0;
  let active = true;
  let finishing = false;
  let failure: Error | undefined;
  let previewBusy = false;
  let previewAt = 0;
  let previewAc: AbortController | undefined;
  let localFailed = false;
  let previewResult: { text: string; model?: string; samples: number } | undefined;
  const streamed: string[] = [];
  let segment = 0;
  let currentIndex = 0;
  const bounded = async <T>(
    run: (signal: AbortSignal) => Promise<T>,
    extra?: AbortSignal,
  ): Promise<T> => {
    const deadline = (d.timeout ?? AbortSignal.timeout)(d.requestTimeoutMs);
    const signal = AbortSignal.any([ac.signal, deadline, ...(extra ? [extra] : [])]);
    signal.throwIfAborted();
    let cancel!: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      cancel = () => reject(signal.reason);
      signal.addEventListener("abort", cancel, { once: true });
    });
    try {
      return await Promise.race([run(signal), cancelled]);
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  };
  const join = (parts: readonly Float32Array[]) => {
    const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const part of parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  };
  const whole = (end = Infinity) =>
    join(
      chunks.map(({ audio, at }) =>
        audio.subarray(
          0,
          Math.max(0, Math.min(audio.length, Math.floor(((end - at) * d.rate) / 1000))),
        ),
      ),
    );
  const show = (text: string) => {
    if (active && !finishing && !failure && text.trim()) d.onPartial?.(text);
  };
  const begin = () => {
    currentIndex = segment++;
    const index = currentIndex;
    try {
      current =
        d.local?.begin((text) => {
          streamed[index] = text;
          show(streamed.filter(Boolean).join(" "));
        }) ?? null;
    } catch {
      current = null;
    }
    if (d.local && !current) localFailed = true;
  };
  const endLocal = () => {
    if (current && currentSamples) {
      const utt = current;
      const audio = join(currentAudio);
      const index = currentIndex;
      try {
        finals.push(
          utt
            .end(audio)
            .then((out) => {
              streamed[index] = out.text;
              show(streamed.filter(Boolean).join(" "));
              return out;
            })
            .catch(() => undefined),
        );
      } catch {
        finals.push(Promise.resolve(undefined));
      }
    } else current?.cancel();
    current = null;
    currentAudio = [];
    currentSamples = 0;
  };
  begin();
  const abort = () => {
    active = false;
    ac.abort();
    current?.cancel();
    current = null;
    d.local?.close();
    chunks.length = 0;
  };
  return {
    abort,
    /** at is the first sample's capture time, not a guessed speech-onset time. */
    frame(audio: Float32Array, at: number) {
      if (!active || finishing || failure) return;
      const from = Math.max(0, Math.ceil(((d.startAt - at) * d.rate) / 1000));
      const kept = audio.slice(from);
      if (!kept.length) return;
      if (((count + kept.length) / d.rate) * 1000 > d.maxCaptureMs) {
        failure = new Error("ptt-too-long");
        current?.cancel();
        current = null;
        ac.abort();
        d.local?.close();
        d.onFailure?.(failure);
        return;
      }
      chunks.push({ audio: kept, at: at + (from * 1000) / d.rate });
      count += kept.length;
      let offset = 0;
      const cap = Math.max(1, Math.floor((d.localSegmentMs * d.rate) / 1000));
      while (current && offset < kept.length) {
        const piece = kept.subarray(
          offset,
          offset + Math.min(kept.length - offset, cap - currentSamples),
        );
        currentAudio.push(piece);
        currentSamples += piece.length;
        try {
          current.frame(piece);
        } catch {
          localFailed = true;
          current.cancel();
          current = null;
        }
        offset += piece.length;
        if (currentSamples >= cap) {
          endLocal();
          begin();
        }
      }
      const ms = (count * 1000) / d.rate;
      if (
        (!d.local || localFailed || !current || d.local.state() === "down") &&
        !previewBusy &&
        ms >= d.partialMinMs &&
        ms - previewAt >= d.partialEveryMs
      ) {
        previewAt = ms;
        previewBusy = true;
        previewAc = new AbortController();
        const captured = count;
        void bounded((signal) => d.cloud(whole(), signal), previewAc.signal)
          .then(
            (out) => {
              if (active && !finishing && !failure && out.text.trim()) {
                previewResult = { text: out.text.trim(), model: out.model, samples: captured };
                show(out.text);
              }
            },
            () => {},
          )
          .finally(() => {
            previewBusy = false;
          });
      }
    },
    async finish(endAt: number): Promise<PttRecognition> {
      if (!active || finishing) throw new Error("ptt-cancelled");
      finishing = true;
      previewAc?.abort();
      if (failure) {
        abort();
        throw failure;
      }
      const audio = whole(endAt);
      endLocal();
      const observed = await Promise.all(finals);
      if (!active) throw new Error("ptt-cancelled");
      // A failed segment cannot silently turn a partial local transcript into the whole line.
      if (observed.some((f) => f?.filtered)) {
        abort();
        throw new Error("ptt-filtered");
      }
      const complete =
        !localFailed && observed.length > 0 && observed.every((f) => f !== undefined);
      const localText = complete
        ? observed
            .map((f) => f!.text.trim())
            .filter(Boolean)
            .join(" ")
        : "";
      let high: Decode | undefined;
      let highRoute: "local" | "cloud" = "local";
      if (localText && d.local && d.recheck && endAt - d.startAt <= d.recheck.maxSec * 1000) {
        const now = d.now();
        try {
          const out = await d.local.request(
            {
              t: "recheck",
              auto: true,
              engine: "mlx-whisper",
              run: d.run,
              fromAgoMs: Math.max(0, Math.round(now - d.startAt)),
              toAgoMs: Math.max(0, Math.round(now - endAt)),
            },
            { timeoutMs: d.recheck.timeoutMs },
          );
          if (
            out.ok === true &&
            out.auto === true &&
            out.run === d.run &&
            typeof out.text === "string" &&
            out.text.trim() &&
            typeof out.engine === "string"
          )
            high = {
              text: out.text.trim(),
              model: out.engine,
              ...(typeof out.lang === "string" ? { language: out.lang } : {}),
            };
        } catch {
          /* The same exact browser clip remains available for cloud fallback. */
        }
      }
      if (!active) throw new Error("ptt-cancelled");
      if (!high && audio.length) {
        highRoute = "cloud";
        try {
          high = await bounded((signal) => d.cloud(audio, signal));
        } catch (error) {
          if (!active || !localText) {
            abort();
            throw error;
          }
        }
      }
      if (!active) throw new Error("ptt-cancelled");
      const text = localText || high?.text.trim() || "";
      const models = [...new Set(observed.map((f) => f?.model))];
      const model = localText ? (models.length === 1 ? models[0] : undefined) : high?.model;
      const stt: SttTag = {
        route: localText ? "local" : highRoute,
        ...(model ? { engine: model } : {}),
        ...(!localText && d.local ? { fallback: true } : {}),
      };
      const proofs = localText ? observed.flatMap((f) => (f?.proof ? [f.proof] : [])) : [];
      const now = d.now();
      const result: PttRecognition = {
        text,
        audioMs: Math.round((audio.length * 1000) / d.rate),
        stt,
        timing: {
          t_speechStart: d.startAt,
          t_speechEnd: endAt,
          t_sttDone: now,
          audioMs: Math.round((audio.length * 1000) / d.rate),
        },
        ...((localText || previewResult) && high?.text.trim() && high.model
          ? {
              recheck: {
                at: now,
                engine: high.model,
                heard: localText || previewResult!.text,
                text: high.text.trim(),
                ...(!localText && previewResult ? { heardPartial: true as const } : {}),
                ...(high.language ? { lang: high.language } : {}),
              },
            }
          : {}),
        ...(proofs.length ? { speakerProof: proofs } : {}),
      };
      active = false;
      d.local?.close();
      chunks.length = 0;
      return result;
    },
  };
}
