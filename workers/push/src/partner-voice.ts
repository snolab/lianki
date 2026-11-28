import type { ChatMessage, SpeakerTag } from "../../../packages/debug-chat/src/wire";
import { routeLine } from "../../../packages/debug-chat/src/lane-route";
import { namesLi } from "./owner-ai";

/** A microphone left running is not an invitation to answer the room. */
export function standardVoiceSkip(
  line: Pick<ChatMessage, "source" | "text"> & { speaker?: Pick<SpeakerTag, "decision"> },
  conf: {
    needsName: boolean;
    liNames: readonly string[];
    continuation: boolean;
    unverifiedProof?: boolean;
  },
): "unconfirmed-voice" | "spoken-unnamed" | null {
  if (line.source !== "stt") return null;
  // Only the hub's verified speaker tag is used. A name never overrides an
  // explicit unknown/other result, even inside an already-open speech turn.
  if (conf.unverifiedProof || line.speaker?.decision !== "me") return "unconfirmed-voice";
  if (conf.continuation) return null;
  if (namesLi(line.text, conf.liNames) || routeLine(line.text).addressed) return null;
  if (!conf.needsName) return null;
  return "spoken-unnamed";
}
