"use client";

import { publicCfg } from "../config-client";
import {
  createBrowserMeetingTranscription,
  type BrowserMeetingTranscriptionOptions,
} from "./browser";
import { createMeetingLocalStt } from "./local-stt";
import {
  createMeetingEmbedding,
  validateMeetingEmbeddingManifest,
  type MeetingEmbeddingManifest,
  type MeetingEmbeddingStatus,
} from "./embedding";
import { MeetingTranscriptionError } from "./contracts";

export type ConfiguredMeetingOptions = Pick<
  BrowserMeetingTranscriptionOptions,
  "meetingId" | "onDraft" | "onStatus"
> & {
  /** Explicit consent to device-only speaker vectors for this meeting. */
  speakerConsent: boolean;
  origin: string;
  onEmbeddingStatus?: (status: MeetingEmbeddingStatus) => void;
};

/** Called by the meeting's explicit transcription action. Construction still
 * makes no network/model request and never starts an audio capture. */
export async function createConfiguredMeetingTranscription(
  options: ConfiguredMeetingOptions,
  deps: {
    browser?: typeof createBrowserMeetingTranscription;
    stt?: typeof createMeetingLocalStt;
    embedding?: typeof createMeetingEmbedding;
  } = {},
) {
  const settings = publicCfg("meetings.transcription");
  const route = publicCfg("meetings.transcriptionRoute");
  if (route !== "rtc:lianki") throw new MeetingTranscriptionError("config");
  let manifest: MeetingEmbeddingManifest | null = null;
  try {
    const raw = publicCfg("meetings.voiceprintAssets");
    manifest = raw ? validateMeetingEmbeddingManifest(JSON.parse(raw), options.origin) : null;
  } catch {
    /* Unconfigured speaker vectors remain unknown. */
  }
  const embedding = (deps.embedding ?? createMeetingEmbedding)({
    consent: options.speakerConsent,
    manifest,
    origin: options.origin,
    onStatus: options.onEmbeddingStatus,
  });
  const transcribe = (deps.stt ?? createMeetingLocalStt)({
    route,
    maxSamples: Math.max(settings.live.windowMs, settings.final.windowMs) * 16,
    connectionReuseMs: settings.connectionReuseMs,
  });
  try {
    const consumer = await (deps.browser ?? createBrowserMeetingTranscription)({
      meetingId: options.meetingId,
      onDraft: options.onDraft,
      onStatus: options.onStatus,
      limits: settings.limits,
      live: settings.live,
      final: settings.final,
      transcribe,
      embed: Object.assign(embedding.embed, { close: () => embedding.close() }),
    });
    return { consumer, voiceprintConfigured: Boolean(manifest) };
  } catch (error) {
    transcribe.close();
    embedding.close();
    throw error instanceof MeetingTranscriptionError
      ? error
      : new MeetingTranscriptionError("provider");
  }
}
