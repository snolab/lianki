/** Synthetic fixture for the real explicit routing panel. No audio device access. */
import { createRoot } from "react-dom/client";
import LiveAudioPanel from "../../app/(app)/dev/live-audio/LiveAudioPanel";
import { liveMic } from "../../packages/debug-chat/src/live-mic";
import { pageAudio } from "../../packages/debug-chat/src/page-audio";
let micTimer: ReturnType<typeof setInterval> | undefined;
(globalThis as any).__liveFixtureMic = (on: boolean) => {
  clearInterval(micTimer);
  pageAudio().setMic(on);
  liveMic().publish(null);
  let offset = 0;
  if (on)
    micTimer = setInterval(() => {
      const frame = Float32Array.from(
        { length: 512 },
        (_, i) => Math.sin((2 * Math.PI * 660 * (offset + i)) / 16000) * 0.1,
      );
      offset += 512;
      liveMic().publish(frame);
    }, 32);
};
window.addEventListener("pagehide", () => clearInterval(micTimer));
const root = document.createElement("div");
root.id = "live-audio-fixture";
Object.assign(root.style, {
  position: "fixed",
  inset: "0",
  zIndex: "2147483647",
  background: "white",
  color: "black",
  overflow: "auto",
  padding: "24px",
});
document.body.append(root);
const labels = {
  micSource: "Already-on Li microphone",
  micOff: "Enable Li mic first",
  monitor: "Monitor return (respects mute)",
  unavailableTitle: "Voice calling is not ready yet",
  unavailableBody: "No file upload or configuration is needed now",
  advanced: "Advanced connection diagnostics",
  intro: "Synthetic PCM only; no microphone or speaker",
  ticket: "Local ticket",
  source: "Source",
  target: "Target",
  start: "Start",
  stop: "Stop",
  endInput: "End input",
  gain: "Gain",
  sourceA: "Source A",
  sourceB: "Source B",
  error: "Connection failed",
  state: "State",
  connecting: "connecting",
  ready: "ready",
  inputEnded: "input-ended",
  draining: "draining",
  closed: "closed",
  inputFrames: "Input frames",
  outputFrames: "Output frames",
  clipped: "Clipped samples",
};
createRoot(root).render(
  <LiveAudioPanel
    labels={labels}
    settings={{ toneHz: 440, peak: 0.1, gain: 1, maxGain: 2, uiRefreshMs: 100 }}
  />,
);
