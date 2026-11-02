/**
 * Who sees the /words voice mode switch (docs/voice-mode.md): everyone once
 * the `words.voice-mode` flag is on; with it off, only the owner, as a
 * preview. Decided on the server and handed to the page as a prop.
 */
import { type FlagValues, flagIn } from "@/lib/flags";

/** "on": the flag is on. "preview": off, but this is the owner. "off": no switch. */
export type VoiceAccess = "on" | "preview" | "off";

export function voiceAccess(flags: FlagValues | null | undefined, owner: boolean): VoiceAccess {
  if (flagIn(flags, "words.voice-mode")) return "on";
  return owner ? "preview" : "off";
}
