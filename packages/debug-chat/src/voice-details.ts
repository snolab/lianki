import type { ChatMessage } from "./wire";

export type VoiceDetailKey =
  | "route"
  | "recognitionModel"
  | "fallback"
  | "repeat"
  | "speakerDecision"
  | "speakerScore"
  | "speakerModel"
  | "speakerReason"
  | "speakerSpeechS"
  | "speakerSnrDb"
  | "speakerVoice"
  | "recheckModel"
  | "polishedBy"
  | "polishedAt"
  | "polishCount";
export type VoiceDetailRow = { key: VoiceDetailKey; value: string | number | boolean };
type VoiceMetadata = Pick<
  ChatMessage,
  "from" | "source" | "stt" | "speaker" | "timing" | "recheck" | "edited"
>;

/** Only recorded metadata: no configured engine, visitor device, or expected playback voice. */
export function voiceDetailRows(message: Partial<VoiceMetadata>): VoiceDetailRow[] {
  const rows: VoiceDetailRow[] = [];
  const text = (key: VoiceDetailKey, value: unknown) => {
    if (typeof value === "string" && value.trim() && value.length <= 160) rows.push({ key, value });
  };
  const number = (key: VoiceDetailKey, value: unknown, min = -Infinity, max = Infinity) => {
    if (typeof value === "number" && Number.isFinite(value) && value >= min && value <= max)
      rows.push({ key, value });
  };
  if (message.stt?.route === "local" || message.stt?.route === "cloud") {
    rows.push({ key: "route", value: message.stt.route });
    text("recognitionModel", message.stt.engine);
    if (message.stt.route === "cloud" && message.stt.fallback === true)
      rows.push({ key: "fallback", value: true });
    if (message.stt.repeat === "trimmed") rows.push({ key: "repeat", value: "trimmed" });
  }
  const speaker = message.speaker;
  if (speaker && ["me", "other", "unknown"].includes(speaker.decision)) {
    rows.push({ key: "speakerDecision", value: speaker.decision });
    number("speakerScore", speaker.score, -1, 1);
    text("speakerModel", speaker.model);
    if (["short", "noise", "between", "no-print"].includes(speaker.reason ?? ""))
      text("speakerReason", speaker.reason);
    number("speakerSpeechS", speaker.speechS, 0);
    number("speakerSnrDb", speaker.snrDb);
    if (speaker.voice === "me" || /^s[1-9]\d{0,2}$/.test(speaker.voice ?? ""))
      text("speakerVoice", speaker.voice);
  }
  text("recheckModel", message.recheck?.engine);
  text("polishedBy", message.edited?.by);
  number("polishedAt", message.edited?.at, 0);
  const count = message.edited?.count;
  if (Number.isSafeInteger(count)) number("polishCount", count, 1);
  return rows;
}

/** A voice input may lack model metadata; absence never gets filled from current settings. */
export function hasVoiceDetails(message: Partial<VoiceMetadata>): boolean {
  return (
    (message.from === "owner" && message.source === "stt") ||
    !!message.stt ||
    !!message.speaker ||
    !!message.timing ||
    !!message.recheck
  );
}
