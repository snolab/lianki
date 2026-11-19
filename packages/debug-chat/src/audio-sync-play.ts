/**
 * Multi-device millisecond-level audio sync coordinator.
 *
 * When a clip is ready to play on the initiating peer, it broadcasts
 * `{ t: "sync-play", clipKey, targetPeerMs }` with a lead-in buffer
 * (default 350ms, optionally adaptive to measured fetch+decode latency) and
 * schedules `AudioBufferSourceNode.start(when, offset)` on every peer:
 *
 *   peerTimeMs  = localTimeMs + peerOffsetMs
 *   targetLocal = targetPeerMs - peerOffsetMs
 *   delayMs     = (targetLocal - nowMs()) - deviceOffsetMs
 *
 * where `deviceOffsetMs` (`lk:audio-sync-offset-ms`) compensates for per-device
 * output hardware latency (e.g. Bluetooth speakers: +80ms starts 80ms earlier).
 *
 * If `targetLocal` already passed by less than `LATE_TOLERANCE_MS` (200ms),
 * playback starts immediately at `seekSec = baseAt + (lateMs / 1000) * rate`
 * so peers align mid-utterance.
 */
import type { LinePick, PlayEvents, Playback } from "./voice";
import type {
  AudioBufferLike,
  CtxLike,
  DecodeClipInput,
  DecodedClip,
  ScheduledPlayOpts,
} from "./voice-out";
import type { VoiceId } from "./voices";

export const AUDIO_SYNC_OFFSET_KEY = "lk:audio-sync-offset-ms";
export const DEFAULT_LEAD_IN_MS = 350;
export const MAX_LEAD_IN_MS = 2_000;
export const LATE_TOLERANCE_MS = 200;

export type SyncPlayMessage = {
  t: "sync-play";
  clipKey: string;
  targetPeerMs: number;
  text?: string;
  written?: string;
  lang?: string;
  voice?: VoiceId;
  pick?: LinePick;
  volume?: number;
  rate?: number;
  at?: number;
};

export type SyncScheduleResult =
  | { status: "scheduled"; delayMs: number; seekSec: number; when: number }
  | { status: "caught-up"; lateMs: number; seekSec: number; when: number }
  | { status: "ended"; lateMs: number; seekSec: number }
  | { status: "dropped"; lateMs: number }
  | { status: "ignored"; reason: string }
  | { status: "fallback" };

type StoreLike = {
  getItem(k: string): string | null;
  setItem?(k: string, v: string): void;
  removeItem?(k: string): void;
};

const defaultStore = (): StoreLike | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};

/** Read per-device hardware audio latency offset in ms (0 if unset or invalid). */
export function readAudioSyncOffsetMs(store: StoreLike | null = defaultStore()): number {
  if (!store) return 0;
  try {
    const raw = store.getItem(AUDIO_SYNC_OFFSET_KEY);
    if (raw === null || raw.trim() === "") return 0;
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

/** Persist per-device hardware audio latency offset in ms. */
export function writeAudioSyncOffsetMs(
  offsetMs: number,
  store: StoreLike | null = defaultStore(),
): void {
  if (!store) return;
  try {
    if (!Number.isFinite(offsetMs) || offsetMs === 0) {
      store.removeItem?.(AUDIO_SYNC_OFFSET_KEY);
    } else {
      store.setItem?.(AUDIO_SYNC_OFFSET_KEY, String(Math.round(offsetMs)));
    }
  } catch {}
}

export type SyncCloudLike = {
  decodeClip(s: DecodeClipInput): Promise<DecodedClip>;
  playScheduled(opts: ScheduledPlayOpts, ev: PlayEvents): Playback;
  play(
    s: {
      text: string;
      written?: string;
      lang: string;
      at: number;
      volume: number;
      rate?: number;
      voice?: VoiceId;
      pick?: LinePick;
    },
    ev: PlayEvents,
  ): Playback;
};

export type AudioSyncPlayDeps = {
  cloud: SyncCloudLike;
  ctx: () => CtxLike | null;
  broadcast: (msg: SyncPlayMessage) => void;
  /** Offset from local clock to peer reference clock: peerMs = localMs + peerOffsetMs. */
  peerOffsetMs?: () => number;
  /** Per-device hardware output latency in ms (positive = device is slower, start earlier). */
  deviceOffsetMs?: () => number;
  /** Base lead-in buffer in ms before scheduled start (default 350ms). */
  leadInMs?: number;
  /** Adapt lead-in upward when fetch+decode latency is high (default true). */
  adaptiveLeadIn?: boolean;
  /** Upper bound for adaptive lead-in buffer in ms (default 2000ms). */
  maxLeadInMs?: number;
  /** Maximum lateness in ms for mid-utterance seek catch-up (default 200ms). */
  lateToleranceMs?: number;
  /** Optional resolver when a peer receives a clipKey without inline text/lang. */
  resolveClip?: (clipKey: string) => DecodeClipInput | Promise<AudioBufferLike | null> | null;
  now?: () => number;
};

export type SyncPlayInput = DecodeClipInput & {
  at: number;
  volume: number;
  rate?: number;
  leadInMs?: number;
};

export function createAudioSyncPlay(d: AudioSyncPlayDeps) {
  const getPeerOffsetMs = d.peerOffsetMs ?? (() => 0);
  const getDeviceOffsetMs = d.deviceOffsetMs ?? (() => readAudioSyncOffsetMs());
  const baseLeadInMs = Math.max(0, d.leadInMs ?? DEFAULT_LEAD_IN_MS);
  const adaptiveLeadIn = d.adaptiveLeadIn ?? true;
  const maxLeadInMs = Math.max(baseLeadInMs, d.maxLeadInMs ?? MAX_LEAD_IN_MS);
  const lateToleranceMs = Math.max(0, d.lateToleranceMs ?? LATE_TOLERANCE_MS);
  const nowMs = d.now ?? (() => Date.now());

  let ewmaDecodeMs = 0;
  let activePb: Playback | null = null;
  let lastSeen: { clipKey: string; targetPeerMs: number } | null = null;
  let seq = 0;

  const updateEwma = (sampleMs: number) => {
    if (!Number.isFinite(sampleMs) || sampleMs < 0) return;
    ewmaDecodeMs = ewmaDecodeMs === 0 ? sampleMs : ewmaDecodeMs * 0.7 + sampleMs * 0.3;
  };

  const leadInFor = (overrideMs?: number): number => {
    if (overrideMs !== undefined) return Math.max(0, overrideMs);
    if (!adaptiveLeadIn || ewmaDecodeMs <= 0) return baseLeadInMs;
    const adapted = Math.round(ewmaDecodeMs * 1.2 + 100);
    return Math.max(baseLeadInMs, Math.min(maxLeadInMs, adapted));
  };

  const scheduleDecoded = (
    buffer: AudioBufferLike,
    targetPeerMs: number,
    opts: { baseAt: number; volume: number; rate: number },
    ev: PlayEvents,
    mySeq: number,
  ): SyncScheduleResult => {
    if (mySeq !== seq) return { status: "ignored", reason: "superseded" };
    const ctx = d.ctx();
    if (!ctx?.createBufferSource) {
      ev.onfail?.("no AudioBufferSourceNode");
      return { status: "ignored", reason: "no AudioBufferSourceNode" };
    }
    const targetLocalMs = targetPeerMs - getPeerOffsetMs();
    const effectiveDelayMs = targetLocalMs - nowMs() - getDeviceOffsetMs();

    if (effectiveDelayMs >= 0) {
      const when = ctx.currentTime + effectiveDelayMs / 1000;
      const seekSec = Math.max(0, opts.baseAt);
      activePb = d.cloud.playScheduled(
        { buffer, when, offset: seekSec, volume: opts.volume, rate: opts.rate },
        ev,
      );
      return { status: "scheduled", delayMs: effectiveDelayMs, seekSec, when };
    }

    const lateMs = -effectiveDelayMs;
    if (lateMs < lateToleranceMs) {
      const seekSec = Math.max(0, opts.baseAt) + (lateMs / 1000) * opts.rate;
      if (Number.isFinite(buffer.duration) && buffer.duration > 0 && seekSec >= buffer.duration) {
        ev.onend();
        return { status: "ended", lateMs, seekSec };
      }
      const when = ctx.currentTime;
      activePb = d.cloud.playScheduled(
        { buffer, when, offset: seekSec, volume: opts.volume, rate: opts.rate },
        ev,
      );
      return { status: "caught-up", lateMs, seekSec, when };
    }

    ev.onfail?.("sync-late");
    return { status: "dropped", lateMs };
  };

  const stop = () => {
    seq++;
    const pb = activePb;
    activePb = null;
    return pb ? pb.stop() : {};
  };

  const playSynced = (s: SyncPlayInput, ev: PlayEvents): Playback => {
    const mySeq = ++seq;
    activePb?.stop();
    activePb = null;
    let fallbackPb: Playback | null = null;
    const pb: Playback = {
      route: "audio",
      stop() {
        if (fallbackPb) {
          const r = fallbackPb.stop();
          fallbackPb = null;
          return r;
        }
        if (mySeq !== seq) return {};
        return stop();
      },
      volume(level, ms) {
        if (fallbackPb) fallbackPb.volume(level, ms);
        else if (mySeq === seq) activePb?.volume(level, ms);
      },
    };

    const runFallback = () => {
      if (mySeq !== seq) return;
      fallbackPb = d.cloud.play(
        {
          text: s.text,
          written: s.written,
          lang: s.lang,
          at: s.at,
          volume: s.volume,
          rate: s.rate,
          voice: s.voice,
          pick: s.pick,
        },
        ev,
      );
    };

    const ctx = d.ctx();
    if (!ctx?.decodeAudioData || !ctx?.createBufferSource) {
      runFallback();
      return pb;
    }

    d.cloud.decodeClip(s).then(
      (decoded) => {
        if (mySeq !== seq) return;
        updateEwma(decoded.decodeMs);
        const leadIn = leadInFor(s.leadInMs);
        const targetPeerMs = nowMs() + getPeerOffsetMs() + leadIn;
        const rate = (s.rate ?? 1) * decoded.shift;
        lastSeen = { clipKey: decoded.clipKey, targetPeerMs };
        d.broadcast({
          t: "sync-play",
          clipKey: decoded.clipKey,
          targetPeerMs,
          text: s.text,
          written: s.written,
          lang: s.lang,
          voice: s.voice,
          pick: s.pick,
          volume: s.volume,
          rate,
          at: s.at,
        });
        scheduleDecoded(
          decoded.buffer,
          targetPeerMs,
          { baseAt: s.at, volume: s.volume, rate },
          ev,
          mySeq,
        );
      },
      () => {
        runFallback();
      },
    );

    return pb;
  };

  const handleMessage = async (
    msg: SyncPlayMessage,
    ev: PlayEvents = { onend() {}, onerror() {} },
  ): Promise<SyncScheduleResult> => {
    if (msg.t !== "sync-play") return { status: "ignored", reason: "wrong-type" };
    if (
      lastSeen &&
      lastSeen.clipKey === msg.clipKey &&
      lastSeen.targetPeerMs === msg.targetPeerMs
    ) {
      return { status: "ignored", reason: "duplicate" };
    }
    lastSeen = { clipKey: msg.clipKey, targetPeerMs: msg.targetPeerMs };
    const mySeq = ++seq;
    activePb?.stop();
    activePb = null;

    const baseAt = msg.at ?? 0;
    const volume = msg.volume ?? 1;
    let rate = msg.rate ?? 1;
    let buffer: AudioBufferLike | null = null;

    try {
      if (msg.text && msg.lang) {
        const decoded = await d.cloud.decodeClip({
          text: msg.text,
          written: msg.written,
          lang: msg.lang,
          voice: msg.voice,
          pick: msg.pick,
        });
        updateEwma(decoded.decodeMs);
        buffer = decoded.buffer;
        if (msg.rate === undefined) rate = decoded.shift;
      } else if (d.resolveClip) {
        const resolved = await d.resolveClip(msg.clipKey);
        if (resolved && "duration" in resolved) {
          buffer = resolved;
        } else if (resolved && "text" in resolved) {
          const decoded = await d.cloud.decodeClip(resolved);
          updateEwma(decoded.decodeMs);
          buffer = decoded.buffer;
          if (msg.rate === undefined) rate = decoded.shift;
        }
      }
    } catch {
      if (msg.text && msg.lang) {
        if (mySeq === seq) {
          activePb = d.cloud.play(
            {
              text: msg.text,
              written: msg.written,
              lang: msg.lang,
              at: baseAt,
              volume,
              rate,
              voice: msg.voice,
              pick: msg.pick,
            },
            ev,
          );
          return { status: "fallback" };
        }
      }
      ev.onfail?.("decode failed");
      return { status: "ignored", reason: "decode-failed" };
    }

    if (!buffer) {
      ev.onfail?.("unknown clipKey");
      return { status: "ignored", reason: "unknown-clip" };
    }

    return scheduleDecoded(buffer, msg.targetPeerMs, { baseAt, volume, rate }, ev, mySeq);
  };

  return {
    playSynced,
    handleMessage,
    stop,
    leadInFor,
    stats: () => ({
      ewmaDecodeMs,
      leadInMs: leadInFor(),
      lastSeen,
    }),
  };
}
