/** Synthetic fixture for the real explicit routing panel. No audio device access. */
import { createRoot } from "react-dom/client";
import LiveAudioPanel from "../../app/(app)/dev/live-audio/LiveAudioPanel";
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
