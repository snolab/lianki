import { checkAbort, MeetingTranscriptionError } from "./contracts";
import type { AudioChunk } from "./controller";

export interface DecodedAudio {
  length: number;
  sampleRate: number;
  numberOfChannels: number;
  getChannelData(channel: number): Float32Array;
}

/** Decode an independent audio-only WebM/Opus piece; no nodes connect to an output. */
export function createMeetingChunkDecoder(options: {
  maxChunkBytes: number;
  maxChunkMs: number;
  maxDecodeDriftMs: number;
  decodeAudioData?: (bytes: ArrayBuffer) => Promise<DecodedAudio>;
}) {
  if (
    ![options.maxChunkBytes, options.maxChunkMs].every((n) => Number.isSafeInteger(n) && n > 0) ||
    !Number.isSafeInteger(options.maxDecodeDriftMs) ||
    options.maxDecodeDriftMs < 0
  )
    throw new MeetingTranscriptionError("config");
  return async (
    bytes: ArrayBuffer,
    chunk: AudioChunk,
    signal: AbortSignal,
  ): Promise<Float32Array> => {
    checkAbort(signal);
    if (
      !bytes.byteLength ||
      bytes.byteLength > options.maxChunkBytes ||
      !Number.isSafeInteger(chunk.durMs) ||
      chunk.durMs < 1 ||
      chunk.durMs > options.maxChunkMs
    )
      throw new MeetingTranscriptionError("audio");
    let audio: DecodedAudio;
    try {
      audio = await (options.decodeAudioData
        ? options.decodeAudioData(bytes)
        : new OfflineAudioContext(1, 1, 16_000).decodeAudioData(bytes));
    } catch {
      checkAbort(signal);
      throw new MeetingTranscriptionError("decode");
    }
    checkAbort(signal);
    // These are the protocol's mono/stereo audio layouts, not a playback context.
    if (
      !Number.isSafeInteger(audio.length) ||
      audio.length < 1 ||
      !Number.isFinite(audio.sampleRate) ||
      audio.sampleRate < 8_000 ||
      audio.sampleRate > 192_000 ||
      ![1, 2].includes(audio.numberOfChannels)
    )
      throw new MeetingTranscriptionError("audio");
    const durationMs = (audio.length / audio.sampleRate) * 1000;
    if (
      durationMs > options.maxChunkMs + options.maxDecodeDriftMs ||
      Math.abs(durationMs - chunk.durMs) > options.maxDecodeDriftMs
    )
      throw new MeetingTranscriptionError("timeline");
    const channels = Array.from({ length: audio.numberOfChannels }, (_, index) =>
      audio.getChannelData(index),
    );
    if (channels.some((channel) => channel.length !== audio.length))
      throw new MeetingTranscriptionError("audio");
    // Trim encoder padding; shorter decoded pieces leave an explicit timeline gap.
    const count = Math.min(
      chunk.durMs * 16,
      Math.round((audio.length * 16_000) / audio.sampleRate),
    );
    const result = new Float32Array(count),
      ratio = audio.sampleRate / 16_000;
    for (let i = 0; i < count; i++) {
      const from = i * ratio,
        to = Math.min(audio.length, (i + 1) * ratio);
      let sum = 0,
        weight = 0;
      for (let sample = Math.floor(from); sample < Math.ceil(to); sample++) {
        const overlap = Math.max(0, Math.min(to, sample + 1) - Math.max(from, sample));
        for (const channel of channels) {
          const value = channel[sample];
          if (!Number.isFinite(value)) throw new MeetingTranscriptionError("audio");
          sum += value * overlap;
          weight += overlap;
        }
      }
      result[i] = weight ? Math.max(-1, Math.min(1, sum / weight)) : 0;
    }
    checkAbort(signal);
    return result;
  };
}
