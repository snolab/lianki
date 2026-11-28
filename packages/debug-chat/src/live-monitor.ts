/** Explicit return-PCM monitor. No context/device is created until the user enables it. */
import { AUDIO_PRIO, audioOwner, audioOwnerId, type AudioOwner } from "./audio-claim";
import { audioCtx } from "./voice-out";
import { pageAudio } from "./page-audio";
import { getKey } from "./storage-keys";
import { decodeLivePcm, type LivePcmFormat } from "./live-audio-core";

type Playback = { done: Promise<void>; stop(): void };
export type MonitorDeps = {
  allowed(): boolean;
  owner(onYield: () => void): AudioOwner;
  play(samples: Float32Array, format: LivePcmFormat): Playback;
};
export function createLiveMonitor(d: MonitorDeps) {
  let enabled = false;
  const playing = new Set<Playback>();
  const stopped = new WeakSet<Playback>();
  const stopPlayback = (p: Playback) => {
    if (stopped.has(p)) return;
    stopped.add(p);
    p.stop();
  };
  const silence = () => {
    for (const p of playing) stopPlayback(p);
    playing.clear();
  };
  const owner = d.owner(silence);
  const sync = () => {
    if (!enabled || !d.allowed()) {
      silence();
      owner.release();
      return false;
    }
    return true;
  };
  return {
    enable(on: boolean) {
      enabled = on;
      sync();
    },
    sync,
    async consume(pcm: ArrayBuffer, format: LivePcmFormat, signal: AbortSignal) {
      if (signal.aborted || !sync()) return;
      const samples = decodeLivePcm(pcm);
      // Silent frames must neither hold the mic nor interrupt another audio owner.
      if (samples.every((sample) => sample === 0)) return;
      if (!owner.claim()) return;
      let playback: Playback | undefined;
      const stop = () => {
        if (playback) stopPlayback(playback);
      };
      try {
        playback = d.play(samples, format);
        playing.add(playback);
        signal.addEventListener("abort", stop, { once: true });
        if (signal.aborted) stop();
        await playback.done;
      } finally {
        signal.removeEventListener("abort", stop);
        if (playback) {
          stopPlayback(playback);
          playing.delete(playback);
        }
        if (!playing.size) owner.release();
      }
    },
    dispose() {
      enabled = false;
      silence();
      owner.dispose();
    },
  };
}
/** Called only by an explicit Monitor gesture; no speechSynthesis capture or voice takeover. */
export function browserLiveMonitor(
  d: {
    context?: () => AudioContext | null;
    readAloud?: () => boolean;
    window?: EventTarget;
    document?: EventTarget & { visibilityState: string };
  } = {},
) {
  const context = (d.context ?? audioCtx)();
  const target = d.window ?? window;
  const page = d.document ?? document;
  if (!context) throw Error("audio-unavailable");
  const resumed = context.resume();
  void resumed.catch(() => {}); // The consumer reports refusal; no unhandled promise before PCM arrives.
  const monitor = createLiveMonitor({
    // Same read-aloud preference as voice.ts, without instantiating a voice session.
    allowed: () =>
      (d.readAloud?.() ?? getKey("lk:debug-chat-speak") !== "0") &&
      page.visibilityState === "visible",
    // Match the playback window: another context must not own this monitor.
    owner: (onYield) =>
      audioOwner({ target, id: audioOwnerId("live-monitor"), prio: AUDIO_PRIO.play, onYield }),
    play(samples, format) {
      const buffer = context.createBuffer(
        format.channels,
        samples.length / format.channels,
        format.sampleRate,
      );
      for (let ch = 0; ch < format.channels; ch++) {
        const channel = buffer.getChannelData(ch);
        for (let i = 0; i < channel.length; i++) channel[i] = samples[i * format.channels + ch];
      }
      const node = context.createBufferSource();
      node.buffer = buffer;
      let end = () => {};

      // Graph setup is inside cleanup too: a failed connect/start cannot retain ownership.
      let finish!: () => void,
        ended = false;
      const done = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const complete = () => {
        if (ended) return;
        ended = true;
        try {
          node.disconnect();
        } catch {}
        try {
          end();
        } finally {
          finish();
        }
      };
      node.onended = complete;
      try {
        if (context.state !== "running") throw Error("audio-not-running");
        node.connect(context.destination);
        end = pageAudio().start();
        node.start();
      } catch (error) {
        complete();
        throw error;
      }
      return {
        done,
        stop() {
          try {
            node.stop();
          } catch {}
          complete();
        },
      };
    },
  });
  monitor.enable(true);
  // Storage events cover other tabs; sync also catches same-tab preference writes.
  const check = () => {
    monitor.sync();
  };
  const timer = setInterval(check, 20);
  target.addEventListener("storage", check);
  page.addEventListener("visibilitychange", check);
  return {
    async consume(pcm: ArrayBuffer, format: LivePcmFormat, signal: AbortSignal) {
      await resumed;
      if (context.state !== "running") throw Error("audio-not-running");
      return monitor.consume(pcm, format, signal);
    },
    dispose() {
      clearInterval(timer);
      target.removeEventListener("storage", check);
      page.removeEventListener("visibilitychange", check);
      monitor.dispose();
    },
  };
}
