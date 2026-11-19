/**
 * Multi-device millisecond-level audio sync hub (M2):
 * wires `AudioSyncRtcManager` (WebRTC DataChannel + NTP clock offset),
 * `createAudioSyncPlay` (Web Audio `AudioBufferSourceNode.start(when)`), and
 * `estimateAcousticDelta` (mic-captured dual-speaker latency detector) into
 * one cohesive controller exposed on `globalThis.__lkAudioSync`.
 */
import {
  type AcousticDeltaResult,
  type AudioBufferLike as AcousticBufferLike,
  createOffsetFilterState,
  estimateAcousticDelta,
  smoothOffsetUpdate,
} from "./audio-sync-acoustic";
import {
  createAudioSyncPlay,
  readAudioSyncOffsetMs,
  type SyncPlayInput,
  type SyncPlayMessage,
  writeAudioSyncOffsetMs,
} from "./audio-sync-play";
import {
  AudioSyncRtcManager,
  type AudioSyncRtcDeps,
  type ClockSyncEstimate,
} from "./audio-sync-rtc";
import type { AudioBufferLike, CtxLike, DecodeClipInput, DecodedClip } from "./voice-out";
import type { CloudOut, PlayEvents, Playback } from "./voice";
import type { AudioSyncPeersEvent, AudioSyncSignalEvent, AudioSyncSignalPayload } from "./wire";

export const AUDIO_SYNC_GLOBAL_KEY = "__lkAudioSync";
export const AUDIO_SYNC_FLAG = "voice.audio-sync";
export const AUDIO_SYNC_LOCAL_KEY = "lk:audio-sync";

export type AudioSyncHubStats = {
  enabled: boolean;
  selfId: string | null;
  peerCount: number;
  syncs: Record<string, ClockSyncEstimate>;
  deviceOffsetMs: number;
  leadInMs: number;
  lastAcoustic: AcousticDeltaResult | null;
};

export type AudioSyncHub = {
  readonly enabled: boolean;
  hasPeers(): boolean;
  requestPeers(): void;
  handleHubEvent(ev: AudioSyncPeersEvent | AudioSyncSignalEvent | { type?: unknown }): boolean;
  playSynced(s: SyncPlayInput, ev: PlayEvents): Playback;
  feedMicPcm(samples: Float32Array, sampleRate: number): AcousticDeltaResult | null;
  setDeviceOffsetMs(offsetMs: number): void;
  stats(): AudioSyncHubStats;
  close(): void;
};

export type AudioSyncHubDeps = {
  cloud: () =>
    | (CloudOut & {
        decodeClip(s: DecodeClipInput): Promise<DecodedClip>;
        playScheduled(
          opts: {
            buffer: AudioBufferLike;
            when?: number;
            offset: number;
            volume: number;
            rate: number;
          },
          ev: PlayEvents,
        ): Playback;
      })
    | null;
  ctx: () => CtxLike | null;
  sendHub: (msg: { type: "audio-sync-peers" } | { type: "audio-sync-signal"; to: string; signal: AudioSyncSignalPayload }) => void;
  createPeerConnection?: AudioSyncRtcDeps["createPeerConnection"];
  iceServers?: RTCIceServer[];
  now?: () => number;
};

export function createAudioSyncHub(deps: AudioSyncHubDeps): AudioSyncHub {
  const nowMs = deps.now ?? (() => Date.now());
  let selfId: string | null = null;
  let rtc: AudioSyncRtcManager | null = null;
  let lastRefBuffer: AcousticBufferLike | null = null;
  let lastAcoustic: AcousticDeltaResult | null = null;
  let filterState = createOffsetFilterState();
  let closed = false;

  const primaryPeerOffsetMs = (): number => {
    if (!rtc) return 0;
    const all = Object.values(rtc.getAllSyncs());
    if (all.length === 0) return 0;
    // Pick the peer with the lowest RTT for tightest clock lock.
    let best = all[0]!;
    for (const s of all) {
      if (s.rttMs < best.rttMs) best = s;
    }
    return best.offsetMs;
  };

  const syncPlay = createAudioSyncPlay({
    cloud: {
      decodeClip: async (s) => {
        const c = deps.cloud();
        if (!c) throw new Error("no cloud output");
        const decoded = await c.decodeClip(s);
        const buf = decoded.buffer as { getChannelData?: unknown; sampleRate?: unknown };
        if (typeof buf.getChannelData === "function" && typeof buf.sampleRate === "number") {
          lastRefBuffer = decoded.buffer as unknown as AcousticBufferLike;
        }
        return decoded;
      },
      playScheduled: (opts, ev) => {
        const c = deps.cloud();
        if (!c) throw new Error("no cloud output");
        return c.playScheduled({ ...opts, offset: opts.offset ?? 0, rate: opts.rate ?? 1 }, ev);
      },
      play: (s, ev) => {
        const c = deps.cloud();
        if (!c) throw new Error("no cloud output");
        return c.play(s, ev);
      },
    },
    ctx: deps.ctx,
    broadcast: (msg: SyncPlayMessage) => {
      if (!rtc) return;
      for (const peerId of Object.keys(rtc.getAllSyncs())) {
        rtc.getPeer(peerId)?.sendAppMessage(msg);
      }
    },
    peerOffsetMs: primaryPeerOffsetMs,
    deviceOffsetMs: () => readAudioSyncOffsetMs(),
    now: nowMs,
  });

  const ensureRtc = (id: string): AudioSyncRtcManager => {
    if (rtc && selfId === id) return rtc;
    rtc?.close();
    selfId = id;
    rtc = new AudioSyncRtcManager(
      id,
      {
        createPeerConnection: deps.createPeerConnection,
        sendSignal: (to, signal) => deps.sendHub({ type: "audio-sync-signal", to, signal }),
        now: nowMs,
      },
      {
        rtcConfig: deps.iceServers ? { iceServers: deps.iceServers } : undefined,
        onAppMessage: (_fromPeerId, payload) => {
          if (payload && typeof payload === "object" && (payload as { t?: unknown }).t === "sync-play") {
            void syncPlay.handleMessage(payload as SyncPlayMessage);
          }
        },
      },
    );
    return rtc;
  };

  const hub: AudioSyncHub = {
    get enabled() {
      return !closed;
    },
    hasPeers() {
      return !closed && !!rtc && Object.keys(rtc.getAllSyncs()).length > 0;
    },
    requestPeers() {
      if (closed) return;
      deps.sendHub({ type: "audio-sync-peers" });
    },
    handleHubEvent(ev) {
      if (closed || !ev || typeof ev !== "object") return false;
      if (ev.type === "audio-sync-peers") {
        const e = ev as AudioSyncPeersEvent;
        const mgr = ensureRtc(e.selfId);
        void mgr.syncPeers(e.peers);
        return true;
      }
      if (ev.type === "audio-sync-signal") {
        const e = ev as AudioSyncSignalEvent;
        if (rtc) void rtc.handleSignal(e.from, e.signal);
        return true;
      }
      return false;
    },
    playSynced(s, ev) {
      return syncPlay.playSynced(s, ev);
    },
    feedMicPcm(samples, sampleRate) {
      if (closed || !lastRefBuffer) return null;
      const res = estimateAcousticDelta(lastRefBuffer, samples, { micSampleRate: sampleRate });
      lastAcoustic = res;
      if (res.detected) {
        const current = readAudioSyncOffsetMs();
        const upd = smoothOffsetUpdate(filterState, {
          detected: res.detected,
          deltaMs: current + res.deltaMs,
          correlation: res.correlation,
        });
        filterState = upd.state;
        if (upd.updated && upd.offsetMs !== null) writeAudioSyncOffsetMs(upd.offsetMs);
      }
      return res;
    },
    setDeviceOffsetMs(offsetMs) {
      writeAudioSyncOffsetMs(offsetMs);
    },
    stats() {
      const s = syncPlay.stats();
      const syncs = rtc ? rtc.getAllSyncs() : {};
      return {
        enabled: !closed,
        selfId,
        peerCount: Object.keys(syncs).length,
        syncs,
        deviceOffsetMs: readAudioSyncOffsetMs(),
        leadInMs: s.leadInMs,
        lastAcoustic,
      };
    },
    close() {
      if (closed) return;
      closed = true;
      syncPlay.stop();
      rtc?.close();
      rtc = null;
      const g = globalThis as Record<string, unknown>;
      if (g[AUDIO_SYNC_GLOBAL_KEY] === hub) delete g[AUDIO_SYNC_GLOBAL_KEY];
    },
  };

  (globalThis as Record<string, unknown>)[AUDIO_SYNC_GLOBAL_KEY] = hub;
  return hub;
}
