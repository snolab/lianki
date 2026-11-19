/** Application-owned dedicated Worker entry, bundled by meeting-voice-assets.ts. */
import {
  installVoiceprintWorker,
  type VoiceprintWorkerScope,
} from "../../vendor/otoji/packages/voiceprint-web/src/index";

if (typeof document !== "undefined" || typeof self === "undefined")
  throw new Error("Meeting voice requires a dedicated worker.");
installVoiceprintWorker(self as unknown as VoiceprintWorkerScope);
