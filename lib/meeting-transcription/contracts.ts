/** Structural boundary for vendor/otoji/packages/meeting-transcript. No capture or providers. */
export type MeetingTrack = "me" | "others";
export interface PcmFrame {
  track: MeetingTrack;
  startSample: number;
  samples: Float32Array;
}
export interface MeetingLine {
  id: string;
  track: MeetingTrack;
  startMs: number;
  endMs: number;
  speaker: string;
  text: string;
  lang?: string;
}
export interface AsrSpan {
  startMs: number;
  endMs: number;
  text: string;
  lang?: string;
}
export type Transcribe = (window: PcmFrame, signal: AbortSignal) => Promise<readonly AsrSpan[]>;
export type Embed = (window: PcmFrame, signal: AbortSignal) => Promise<Float32Array | null>;
export interface TranscriptGap {
  track: MeetingTrack;
  startSample: number;
  endSample: number;
}
export interface LiveTranscriber {
  push(frame: PcmFrame): Promise<void>;
  flush(track?: MeetingTrack): Promise<void>;
  close(): void;
  bufferedSamples(): number;
}
export interface MeetingLiveSettings {
  windowMs?: number;
  stepMs?: number;
  overlapMs?: number;
  silenceRms?: number;
}
export interface MeetingOfflineSettings {
  windowMs?: number;
  overlapMs?: number;
  silenceRms?: number;
  diarization?: {
    windowMs?: number;
    hopMs?: number;
    similarityThreshold?: number;
    ambiguityMargin?: number;
    maxClusters?: number;
    silenceRms?: number;
  };
}
export interface MeetingTranscriptSdk {
  createLiveTranscriber(
    options: MeetingLiveSettings & {
      transcribe: Transcribe;
      onDraft(line: MeetingLine | null, track: MeetingTrack): void;
      onStable(lines: MeetingLine[]): void;
      onGap?: (gap: TranscriptGap) => void;
      onStatus?: (status: {
        kind: "draft-regressed";
        track: MeetingTrack;
        startMs: number;
        endMs: number;
      }) => void;
    },
  ): LiveTranscriber;
  transcribeMeeting(
    frames: AsyncIterable<PcmFrame>,
    options: MeetingOfflineSettings & {
      transcribe: Transcribe;
      embed?: Embed;
      onGap?: (gap: TranscriptGap) => void;
      onWindow?: (window: {
        track: MeetingTrack;
        startMs: number;
        endMs: number;
        lines: MeetingLine[];
      }) => void | Promise<void>;
    },
    signal?: AbortSignal,
  ): AsyncIterable<MeetingLine>;
}
export type TranscriptFailureCode =
  | "choice"
  | "config"
  | "audio"
  | "timeline"
  | "busy"
  | "aborted"
  | "provider"
  | "output"
  | "server"
  | "decode";
/** Never forward provider/fetch exceptions: those may contain text or credentials. */
export class MeetingTranscriptionError extends Error {
  constructor(
    public readonly code: TranscriptFailureCode,
    public readonly status?: number,
  ) {
    super(`Meeting transcription ${code}.`);
  }
}
export function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw new MeetingTranscriptionError("aborted");
}
export function validateFrame(frame: PcmFrame, maxSamples: number): void {
  validateCaptureFrame(frame, maxSamples);
  if (frame.samples.some((n) => Math.abs(n) > 1)) throw new MeetingTranscriptionError("audio");
}
/** Host capture can overshoot full scale; validate without allocating before admission. */
export function validateCaptureFrame(frame: PcmFrame, maxSamples: number): void {
  if (
    !frame ||
    !["me", "others"].includes(frame.track) ||
    !Number.isSafeInteger(frame.startSample) ||
    frame.startSample < 0 ||
    !(frame.samples instanceof Float32Array) ||
    !frame.samples.length ||
    frame.samples.length > maxSamples ||
    !Number.isSafeInteger(frame.startSample + frame.samples.length) ||
    frame.samples.some((n) => !Number.isFinite(n))
  )
    throw new MeetingTranscriptionError("audio");
}
