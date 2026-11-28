import type { ChatMessage, SpeakerTag } from "../../../packages/debug-chat/src/wire";
import { routeLine } from "../../../packages/debug-chat/src/lane-route";
import { namesLi } from "./owner-ai";

/** A microphone left running is not an invitation to answer the room. */
export function standardVoiceSkip(
  line: Pick<ChatMessage, "source" | "text"> & { speaker?: Pick<SpeakerTag, "decision"> },
  conf: { needsName: boolean; liNames: readonly string[]; continuation: boolean },
): "unconfirmed-voice" | "spoken-unnamed" | null {
  if (line.source !== "stt") return null;
  // Only the hub's verified speaker tag is used. A name never overrides an
  // explicit unknown/other result, even inside an already-open speech turn.
  if (line.speaker && line.speaker.decision !== "me") return "unconfirmed-voice";
  if (conf.continuation) return null;
  if (namesLi(line.text, conf.liNames) || routeLine(line.text).addressed) return null;
  // Devices without voiceprint support can still address an assistant, but
  // turning off the name requirement must not enable unverified room audio.
  if (!conf.needsName && line.speaker?.decision === "me") return null;
  return line.speaker?.decision === "me" ? "spoken-unnamed" : "unconfirmed-voice";
}
