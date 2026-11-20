import {
  createLiveTranscriber,
  transcribeMeeting,
} from "../../vendor/otoji/packages/meeting-transcript/src/index";
import type { MeetingTranscriptSdk } from "./contracts";

/** Concrete consumer of the pinned upstream package; no duplicated transcription algorithm. */
export const meetingTranscriptSdk = {
  createLiveTranscriber,
  transcribeMeeting,
} satisfies MeetingTranscriptSdk;
