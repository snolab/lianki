"use client";

import { createMeetingTranscription, type MeetingTranscriptionOptions } from "./controller";
import { createMeetingChunkDecoder } from "./decode";
import {
  MeetingTranscriptionError,
  type MeetingTrack,
  type MeetingTranscriptSdk,
} from "./contracts";

export interface MeetingPcmRecorder {
  readonly state: { meetingId: string | null };
  onPcm(
    listener: (frame: { track: MeetingTrack; offset: number; samples: Float32Array }) => void,
  ): () => void;
}
export type BrowserMeetingTranscriptionOptions = Omit<
  MeetingTranscriptionOptions,
  "sdk" | "subscribePcm" | "decodeChunk"
> & {
  decodeChunk?: MeetingTranscriptionOptions["decodeChunk"];
};

/** Loads browser integration on demand; creates no recorder/provider until explicit startLive. */
export async function createBrowserMeetingTranscription(
  options: BrowserMeetingTranscriptionOptions,
  deps: {
    sdk?: MeetingTranscriptSdk;
    getRecorder?: () => MeetingPcmRecorder;
  } = {},
) {
  const sdk = deps.sdk ?? (await import("./sdk")).meetingTranscriptSdk;
  let getRecorder = deps.getRecorder;
  const consumer = createMeetingTranscription({
    ...options,
    sdk,
    decodeChunk: options.decodeChunk ?? createMeetingChunkDecoder(options.limits),
    subscribePcm(listener) {
      if (!getRecorder) throw new MeetingTranscriptionError("config");
      const recorder = getRecorder();
      if (recorder.state.meetingId !== options.meetingId)
        throw new MeetingTranscriptionError("config");
      return recorder.onPcm((frame) => {
        // A reused page singleton must never feed another meeting into this one's transcript.
        if (recorder.state.meetingId !== options.meetingId) {
          consumer.stop();
          return;
        }
        listener(frame);
      });
    },
  });
  return {
    ...consumer,
    async startLive(choice: { userInitiated: true }) {
      if (choice?.userInitiated !== true) throw new MeetingTranscriptionError("choice");
      // Final transcription never needs the capture module or its browser I/O.
      getRecorder ??= (await import("../meetings/capture")).meetingRecorder;
      return consumer.startLive(choice);
    },
  };
}
