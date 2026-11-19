import { z } from "zod";

/** Defaults only: the host reads the live value through publicCfg. */
export const MEETING_TRANSCRIPTION_DEFAULTS = {
  connectionReuseMs: 30000,
  limits: {
    maxFrameSamples: 16000,
    maxQueuedSamplesPerTrack: 320000,
    maxPendingLines: 200,
    maxRowsPerWrite: 200,
    maxLineChars: 2000,
    maxChunkBytes: 8 * 1024 * 1024,
    maxChunkMs: 120000,
    maxMetadataBytes: 2 * 1024 * 1024,
    maxChunksPerTrack: 3601,
    maxDecodeDriftMs: 250,
  },
  live: { windowMs: 12000, stepMs: 2000, overlapMs: 2000, silenceRms: 0.003 },
  final: {
    windowMs: 12000,
    overlapMs: 1000,
    silenceRms: 0.003,
    diarization: {
      windowMs: 2000,
      hopMs: 1000,
      similarityThreshold: 0.82,
      ambiguityMargin: 0.08,
      maxClusters: 16,
      silenceRms: 0.01,
    },
  },
};
const whole = (min: number, max: number) => z.number().int().min(min).max(max);
export const meetingTranscriptionSchema = z
  .object({
    connectionReuseMs: whole(1000, 30000),
    limits: z
      .object({
        maxFrameSamples: whole(1, 192000),
        maxQueuedSamplesPerTrack: whole(16000, 1920000),
        maxPendingLines: whole(1, 2000),
        maxRowsPerWrite: whole(1, 200),
        maxLineChars: whole(1, 2000),
        maxChunkBytes: whole(1024, 32 * 1024 * 1024),
        maxChunkMs: whole(1000, 120000),
        maxMetadataBytes: whole(1024, 8 * 1024 * 1024),
        maxChunksPerTrack: whole(1, 3601),
        maxDecodeDriftMs: whole(0, 2000),
      })
      .strict(),
    live: z
      .object({
        windowMs: whole(1000, 12000),
        stepMs: whole(100, 12000),
        overlapMs: whole(0, 11999),
        silenceRms: z.number().min(0).max(1),
      })
      .strict(),
    final: z
      .object({
        windowMs: whole(1500, 12000),
        overlapMs: whole(0, 5999),
        silenceRms: z.number().min(0).max(1),
        diarization: z
          .object({
            windowMs: whole(1500, 2500),
            hopMs: whole(250, 2500),
            similarityThreshold: z.number().gt(0).max(1),
            ambiguityMargin: z.number().min(0).lt(1),
            maxClusters: whole(1, 64),
            silenceRms: z.number().min(0).max(1),
          })
          .strict(),
      })
      .strict(),
  })
  .strict()
  .refine(
    (v) =>
      v.limits.maxFrameSamples <= v.limits.maxQueuedSamplesPerTrack &&
      v.live.stepMs <= v.live.windowMs &&
      v.live.overlapMs < v.live.windowMs &&
      v.final.overlapMs < v.final.windowMs / 2 &&
      v.final.diarization.hopMs <= v.final.diarization.windowMs &&
      v.final.diarization.ambiguityMargin < v.final.diarization.similarityThreshold,
    "incompatible meeting transcription bounds",
  );
