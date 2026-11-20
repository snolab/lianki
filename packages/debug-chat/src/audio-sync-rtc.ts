/**
 * WebRTC DataChannel ("audio-sync") peer manager and NTP-style clock sync.
 *
 * Pure and dependency-injected so it runs both in browsers (with native
 * RTCPeerConnection) and in Bun unit tests without browser globals.
 */

import type { AudioSyncPeer, AudioSyncSignalPayload } from "./wire";

/** DataChannel label used for clock sync and audio-sync control messages. */
export const AUDIO_SYNC_CHANNEL = "audio-sync";

export type AudioSyncDataChannelState = "connecting" | "open" | "closing" | "closed";

export type AudioSyncDataChannelLike = {
  readonly label: string;
  readonly readyState: AudioSyncDataChannelState;
  onopen: ((ev?: unknown) => void) | null;
  onclose: ((ev?: unknown) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  send(data: string): void;
  close(): void;
};

export type AudioSyncIceCandidateInit = {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
};

export type AudioSyncRtcConfiguration = {
  iceServers?: Array<{ urls: string | string[]; username?: string; credential?: string }>;
};

export type AudioSyncPeerConnectionLike = {
  readonly connectionState?: string;
  readonly iceConnectionState?: string;
  onicecandidate: ((ev: { candidate: AudioSyncIceCandidateInit | null }) => void) | null;
  ondatachannel: ((ev: { channel: AudioSyncDataChannelLike }) => void) | null;
  onconnectionstatechange?: ((ev?: unknown) => void) | null;
  createDataChannel(
    label: string,
    init?: { ordered?: boolean; maxRetransmits?: number },
  ): AudioSyncDataChannelLike;
  createOffer(): Promise<{ type?: string; sdp?: string }>;
  createAnswer(): Promise<{ type?: string; sdp?: string }>;
  setLocalDescription(desc: { type: "offer" | "answer"; sdp: string }): Promise<void>;
  setRemoteDescription(desc: { type: "offer" | "answer"; sdp: string }): Promise<void>;
  addIceCandidate(candidate: AudioSyncIceCandidateInit): Promise<void>;
  close(): void;
};

export type AudioSyncPeerState = "new" | "connecting" | "connected" | "disconnected" | "closed";

export type ClockSyncEstimate = {
  /** Estimated clock difference in ms: `peerClock - localClock`. */
  offsetMs: number;
  /** Mean round-trip time (ms) of the filtered minimum-RTT samples. */
  rttMs: number;
  /** RMS jitter (ms) of `offsetMs` across the filtered minimum-RTT samples. */
  jitterMs: number;
  /** Total valid NTP samples recorded so far. */
  sampleCount: number;
  /** Local timestamp (`now()`) of the most recent valid sample. */
  lastSyncAt: number;
};

export type AudioSyncClockFilterOptions = {
  /** Sliding window size of recent valid samples (default: 8). */
  windowSize?: number;
  /** Samples within `minRtt + minRttMarginMs` are kept (default: 4 ms). */
  minRttMarginMs?: number;
  /** Maximum number of lowest-RTT samples averaged per estimate (default: 3). */
  maxFilteredSamples?: number;
};

type ClockSample = {
  rttMs: number;
  offsetMs: number;
  at: number;
};

/**
 * Sliding-window minimum-RTT filter for NTP-style (`t1`, `t2`, `t3`, `t4`)
 * timestamps. Queuing spikes inflate RTT and bias one-way delay; keeping only
 * the lowest-RTT samples in the window keeps offset jitter under a few ms.
 */
export class AudioSyncClockFilter {
  private readonly windowSize: number;
  private readonly minRttMarginMs: number;
  private readonly maxFilteredSamples: number;
  private readonly window: ClockSample[] = [];
  private totalCount = 0;
  private current: ClockSyncEstimate | null = null;

  constructor(opts: AudioSyncClockFilterOptions = {}) {
    this.windowSize = Math.max(1, opts.windowSize ?? 8);
    this.minRttMarginMs = Math.max(0, opts.minRttMarginMs ?? 4);
    this.maxFilteredSamples = Math.max(1, opts.maxFilteredSamples ?? 3);
  }

  /**
   * Record one NTP ping-pong round (`t1`: local send, `t2`: peer recv,
   * `t3`: peer send, `t4`: local recv) and return the updated estimate, or
   * `null` if the sample is invalid.
   */
  addSample(t1: number, t2: number, t3: number, t4: number, at = t4): ClockSyncEstimate | null {
    if (
      !Number.isFinite(t1) ||
      !Number.isFinite(t2) ||
      !Number.isFinite(t3) ||
      !Number.isFinite(t4)
    ) {
      return null;
    }
    const rttMs = t4 - t1 - (t3 - t2);
    if (!Number.isFinite(rttMs) || rttMs < 0) return null;

    const offsetMs = (t2 - t1 + (t3 - t4)) / 2;
    if (!Number.isFinite(offsetMs)) return null;

    this.totalCount += 1;
    this.window.push({ rttMs, offsetMs, at });
    if (this.window.length > this.windowSize) {
      this.window.shift();
    }

    const sorted = [...this.window].sort((a, b) => a.rttMs - b.rttMs);
    const minRtt = sorted[0]!.rttMs;
    const chosen = sorted
      .filter((s) => s.rttMs <= minRtt + this.minRttMarginMs)
      .slice(0, this.maxFilteredSamples);

    const n = chosen.length;
    const meanOffset = chosen.reduce((sum, s) => sum + s.offsetMs, 0) / n;
    const meanRtt = chosen.reduce((sum, s) => sum + s.rttMs, 0) / n;
    const variance = chosen.reduce((sum, s) => sum + (s.offsetMs - meanOffset) ** 2, 0) / n;

    this.current = {
      offsetMs: meanOffset,
      rttMs: meanRtt,
      jitterMs: Math.sqrt(variance),
      sampleCount: this.totalCount,
      lastSyncAt: at,
    };
    return this.current;
  }

  get estimate(): ClockSyncEstimate | null {
    return this.current;
  }

  /** Convert a local timestamp to the remote peer's clock, or `null` if unsynced. */
  toPeerTime(localMs: number): number | null {
    return this.current ? localMs + this.current.offsetMs : null;
  }

  /** Convert a remote peer timestamp to the local clock, or `null` if unsynced. */
  toLocalTime(peerMs: number): number | null {
    return this.current ? peerMs - this.current.offsetMs : null;
  }

  reset(): void {
    this.window.length = 0;
    this.totalCount = 0;
    this.current = null;
  }
}

type NtpPingMessage = {
  type: "ntp-ping";
  id: number;
  t1: number;
};

type NtpPongMessage = {
  type: "ntp-pong";
  id: number;
  t1: number;
  t2: number;
  t3: number;
};

type AppEnvelope = {
  type: "audio-sync-app";
  payload: unknown;
};

function parseChannelMessage(raw: string): NtpPingMessage | NtpPongMessage | AppEnvelope | null {
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (!v || typeof v !== "object") return null;
    if (v.type === "ntp-ping" && typeof v.id === "number" && typeof v.t1 === "number") {
      return { type: "ntp-ping", id: v.id, t1: v.t1 };
    }
    if (
      v.type === "ntp-pong" &&
      typeof v.id === "number" &&
      typeof v.t1 === "number" &&
      typeof v.t2 === "number" &&
      typeof v.t3 === "number"
    ) {
      return { type: "ntp-pong", id: v.id, t1: v.t1, t2: v.t2, t3: v.t3 };
    }
    if (v.type === "audio-sync-app") {
      return { type: "audio-sync-app", payload: v.payload };
    }
    return null;
  } catch {
    return null;
  }
}

export type AudioSyncRtcDeps = {
  /** Factory creating an `RTCPeerConnection`-compatible object. */
  createPeerConnection?: (config?: AudioSyncRtcConfiguration) => AudioSyncPeerConnectionLike;
  /** Sends a WebRTC signal to a remote peer via the DebugHub socket. */
  sendSignal: (toPeerId: string, signal: AudioSyncSignalPayload) => void;
  /** High-resolution clock in ms (defaults to `performance.timeOrigin + performance.now()`). */
  now?: () => number;
  /** Timer hooks for deterministic unit testing. */
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (id: unknown) => void;
};

export type AudioSyncPeerOptions = AudioSyncClockFilterOptions & {
  /** Interval (ms) between periodic NTP pings while connected (default: 1000). */
  pingIntervalMs?: number;
  /** Optional ICE/RTC configuration passed to `createPeerConnection`. */
  rtcConfig?: AudioSyncRtcConfiguration;
  onSyncUpdate?: (estimate: ClockSyncEstimate) => void;
  onStateChange?: (state: AudioSyncPeerState) => void;
  onAppMessage?: (payload: unknown) => void;
};

function defaultNow(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return (performance.timeOrigin ?? 0) + performance.now();
  }
  return Date.now();
}

function defaultCreatePeerConnection(
  config?: AudioSyncRtcConfiguration,
): AudioSyncPeerConnectionLike {
  const Ctor = (
    globalThis as {
      RTCPeerConnection?: new (c?: AudioSyncRtcConfiguration) => AudioSyncPeerConnectionLike;
    }
  ).RTCPeerConnection;
  if (!Ctor) {
    throw new Error("RTCPeerConnection is not available in this environment");
  }
  return new Ctor(config);
}

/**
 * Manages a single WebRTC peer connection, its `"audio-sync"` DataChannel,
 * perfect-negotiation signaling, and continuous NTP ping-pong clock sync.
 */
export class AudioSyncPeerSession {
  readonly selfId: string;
  readonly remotePeerId: string;

  private readonly pc: AudioSyncPeerConnectionLike;
  private readonly sendSignal: (toPeerId: string, signal: AudioSyncSignalPayload) => void;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (id: unknown) => void;
  private readonly pingIntervalMs: number;
  private readonly polite: boolean;
  private readonly filter: AudioSyncClockFilter;
  private readonly pendingPings = new Map<number, number>();
  private readonly pendingCandidates: AudioSyncIceCandidateInit[] = [];

  private channel: AudioSyncDataChannelLike | null = null;
  private pingTimer: unknown = null;
  private nextPingId = 1;
  private makingOffer = false;
  private ignoreOffer = false;
  private remoteDescriptionSet = false;
  private currentState: AudioSyncPeerState = "new";

  private readonly onSyncUpdate?: (estimate: ClockSyncEstimate) => void;
  private readonly onStateChange?: (state: AudioSyncPeerState) => void;
  private readonly onAppMessage?: (payload: unknown) => void;

  constructor(
    selfId: string,
    remotePeerId: string,
    deps: AudioSyncRtcDeps,
    opts: AudioSyncPeerOptions = {},
  ) {
    this.selfId = selfId;
    this.remotePeerId = remotePeerId;
    this.polite = selfId < remotePeerId;
    this.sendSignal = deps.sendSignal;
    this.now = deps.now ?? defaultNow;
    this.setTimer = deps.setInterval ?? ((fn, ms) => globalThis.setInterval(fn, ms));
    this.clearTimer =
      deps.clearInterval ?? ((id) => globalThis.clearInterval(id as ReturnType<typeof setInterval>));
    this.pingIntervalMs = Math.max(50, opts.pingIntervalMs ?? 1000);
    this.filter = new AudioSyncClockFilter(opts);
    this.onSyncUpdate = opts.onSyncUpdate;
    this.onStateChange = opts.onStateChange;
    this.onAppMessage = opts.onAppMessage;

    const createPc = deps.createPeerConnection ?? defaultCreatePeerConnection;
    this.pc = createPc(opts.rtcConfig);
    this.bindPeerConnection();
  }

  get state(): AudioSyncPeerState {
    return this.currentState;
  }

  get sync(): ClockSyncEstimate | null {
    return this.filter.estimate;
  }

  toPeerTime(localMs: number): number | null {
    return this.filter.toPeerTime(localMs);
  }

  toLocalTime(peerMs: number): number | null {
    return this.filter.toLocalTime(peerMs);
  }

  /** Initiate the WebRTC connection by creating the `"audio-sync"` DataChannel and an SDP offer. */
  async connect(): Promise<void> {
    if (this.currentState === "closed") return;
    this.setState("connecting");
    if (!this.channel) {
      const ch = this.pc.createDataChannel(AUDIO_SYNC_CHANNEL, {
        ordered: false,
        maxRetransmits: 0,
      });
      this.attachChannel(ch);
    }
    this.makingOffer = true;
    try {
      const offer = await this.pc.createOffer();
      if (!offer.sdp) return;
      await this.pc.setLocalDescription({ type: "offer", sdp: offer.sdp });
      this.sendSignal(this.remotePeerId, { kind: "offer", sdp: offer.sdp });
    } finally {
      this.makingOffer = false;
    }
  }

  /** Handle an incoming WebRTC signal (`offer`, `answer`, or `candidate`) from `remotePeerId`. */
  async handleSignal(signal: AudioSyncSignalPayload): Promise<void> {
    if (this.currentState === "closed") return;

    if (signal.kind === "candidate") {
      const candidate: AudioSyncIceCandidateInit = {
        candidate: signal.candidate,
        ...(signal.sdpMid !== undefined ? { sdpMid: signal.sdpMid } : {}),
        ...(signal.sdpMLineIndex !== undefined ? { sdpMLineIndex: signal.sdpMLineIndex } : {}),
      };
      if (!this.remoteDescriptionSet) {
        this.pendingCandidates.push(candidate);
        return;
      }
      if (!this.ignoreOffer) {
        await this.pc.addIceCandidate(candidate);
      }
      return;
    }

    if (signal.kind === "offer") {
      const offerCollision = this.makingOffer || this.remoteDescriptionSet;
      this.ignoreOffer = !this.polite && offerCollision;
      if (this.ignoreOffer) return;

      this.setState("connecting");
      await this.pc.setRemoteDescription({ type: "offer", sdp: signal.sdp });
      this.remoteDescriptionSet = true;
      await this.flushPendingCandidates();

      const answer = await this.pc.createAnswer();
      if (!answer.sdp) return;
      await this.pc.setLocalDescription({ type: "answer", sdp: answer.sdp });
      this.sendSignal(this.remotePeerId, { kind: "answer", sdp: answer.sdp });
      return;
    }

    if (signal.kind === "answer") {
      await this.pc.setRemoteDescription({ type: "answer", sdp: signal.sdp });
      this.remoteDescriptionSet = true;
      await this.flushPendingCandidates();
    }
  }

  /** Send one NTP ping immediately if the DataChannel is open. */
  sendPing(): boolean {
    if (!this.channel || this.channel.readyState !== "open") return false;
    const id = this.nextPingId++;
    const t1 = this.now();
    this.pendingPings.set(id, t1);
    // Bound pending map in case pongs are dropped on unreliable DataChannel.
    if (this.pendingPings.size > 64) {
      const oldest = this.pendingPings.keys().next().value;
      if (oldest !== undefined) this.pendingPings.delete(oldest);
    }
    this.channel.send(JSON.stringify({ type: "ntp-ping", id, t1 } satisfies NtpPingMessage));
    return true;
  }

  /** Send an application payload over the `"audio-sync"` DataChannel. */
  sendAppMessage(payload: unknown): boolean {
    if (!this.channel || this.channel.readyState !== "open") return false;
    this.channel.send(JSON.stringify({ type: "audio-sync-app", payload } satisfies AppEnvelope));
    return true;
  }

  close(): void {
    if (this.currentState === "closed") return;
    this.stopPingLoop();
    this.pendingPings.clear();
    this.pendingCandidates.length = 0;
    try {
      this.channel?.close();
    } catch {
      // ignore close errors on already-closed channel
    }
    this.channel = null;
    try {
      this.pc.close();
    } catch {
      // ignore close errors
    }
    this.setState("closed");
  }

  private bindPeerConnection(): void {
    this.pc.onicecandidate = (ev) => {
      if (!ev.candidate || this.currentState === "closed") return;
      this.sendSignal(this.remotePeerId, {
        kind: "candidate",
        candidate: ev.candidate.candidate,
        ...(ev.candidate.sdpMid !== undefined ? { sdpMid: ev.candidate.sdpMid } : {}),
        ...(ev.candidate.sdpMLineIndex !== undefined
          ? { sdpMLineIndex: ev.candidate.sdpMLineIndex }
          : {}),
      });
    };

    this.pc.ondatachannel = (ev) => {
      if (this.currentState === "closed") return;
      if (ev.channel.label === AUDIO_SYNC_CHANNEL) {
        this.attachChannel(ev.channel);
      }
    };

    this.pc.onconnectionstatechange = () => {
      const s = this.pc.connectionState;
      if (s === "failed" || s === "disconnected") {
        this.stopPingLoop();
        if (this.currentState !== "closed") this.setState("disconnected");
      } else if (s === "closed") {
        this.close();
      }
    };
  }

  private attachChannel(ch: AudioSyncDataChannelLike): void {
    this.channel = ch;
    ch.onopen = () => {
      if (this.currentState === "closed") return;
      this.setState("connected");
      this.sendPing();
      this.startPingLoop();
    };
    ch.onclose = () => {
      this.stopPingLoop();
      if (this.currentState !== "closed") this.setState("disconnected");
    };
    ch.onerror = () => {
      this.stopPingLoop();
      if (this.currentState !== "closed") this.setState("disconnected");
    };
    ch.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      const msg = parseChannelMessage(ev.data);
      if (!msg) return;
      if (msg.type === "ntp-ping") {
        const t2 = this.now();
        const t3 = this.now();
        if (this.channel?.readyState === "open") {
          this.channel.send(
            JSON.stringify({
              type: "ntp-pong",
              id: msg.id,
              t1: msg.t1,
              t2,
              t3,
            } satisfies NtpPongMessage),
          );
        }
        return;
      }
      if (msg.type === "ntp-pong") {
        const t4 = this.now();
        const sentT1 = this.pendingPings.get(msg.id);
        if (sentT1 === undefined) return;
        this.pendingPings.delete(msg.id);
        const est = this.filter.addSample(sentT1, msg.t2, msg.t3, t4, t4);
        if (est) this.onSyncUpdate?.(est);
        return;
      }
      if (msg.type === "audio-sync-app") {
        this.onAppMessage?.(msg.payload);
      }
    };

    if (ch.readyState === "open") {
      this.setState("connected");
      this.sendPing();
      this.startPingLoop();
    }
  }

  private async flushPendingCandidates(): Promise<void> {
    while (this.pendingCandidates.length > 0) {
      const c = this.pendingCandidates.shift()!;
      await this.pc.addIceCandidate(c);
    }
  }

  private startPingLoop(): void {
    if (this.pingTimer !== null) return;
    this.pingTimer = this.setTimer(() => {
      this.sendPing();
    }, this.pingIntervalMs);
  }

  private stopPingLoop(): void {
    if (this.pingTimer === null) return;
    this.clearTimer(this.pingTimer);
    this.pingTimer = null;
  }

  private setState(next: AudioSyncPeerState): void {
    if (this.currentState === next) return;
    this.currentState = next;
    this.onStateChange?.(next);
  }
}

export type AudioSyncManagerOptions = Omit<
  AudioSyncPeerOptions,
  "onSyncUpdate" | "onStateChange" | "onAppMessage"
> & {
  onSyncUpdate?: (peerId: string, estimate: ClockSyncEstimate) => void;
  onStateChange?: (peerId: string, state: AudioSyncPeerState) => void;
  onAppMessage?: (peerId: string, payload: unknown) => void;
};

/**
 * Coordinates WebRTC `"audio-sync"` peer sessions across all same-account pages.
 * Uses a deterministic tie-breaker (`selfId < remoteId`) so only one side
 * initiates an offer when peer lists arrive simultaneously.
 */
export class AudioSyncRtcManager {
  readonly selfId: string;
  private readonly deps: AudioSyncRtcDeps;
  private readonly opts: AudioSyncManagerOptions;
  private readonly peers = new Map<string, AudioSyncPeerSession>();

  constructor(selfId: string, deps: AudioSyncRtcDeps, opts: AudioSyncManagerOptions = {}) {
    this.selfId = selfId;
    this.deps = deps;
    this.opts = opts;
  }

  /** Reconcile active sessions with the latest same-account peer list. */
  async syncPeers(list: readonly AudioSyncPeer[]): Promise<void> {
    const activeIds = new Set(list.map((p) => p.id).filter((id) => id && id !== this.selfId));

    for (const [id, session] of this.peers) {
      if (!activeIds.has(id)) {
        session.close();
        this.peers.delete(id);
      }
    }

    const connects: Promise<unknown>[] = [];
    for (const id of activeIds) {
      if (!this.peers.has(id) && this.selfId < id) {
        connects.push(this.connectTo(id));
      }
    }
    await Promise.all(connects);
  }

  /** Explicitly initiate or reuse a session with `peerId`. */
  async connectTo(peerId: string): Promise<AudioSyncPeerSession | null> {
    if (!peerId || peerId === this.selfId) return null;
    let session = this.peers.get(peerId);
    if (!session) {
      session = this.createSession(peerId);
      this.peers.set(peerId, session);
      await session.connect();
    }
    return session;
  }

  /** Route an incoming `audio-sync-signal` from `fromPeerId`. */
  async handleSignal(fromPeerId: string, signal: AudioSyncSignalPayload): Promise<void> {
    if (!fromPeerId || fromPeerId === this.selfId) return;
    let session = this.peers.get(fromPeerId);
    if (!session) {
      session = this.createSession(fromPeerId);
      this.peers.set(fromPeerId, session);
    }
    await session.handleSignal(signal);
  }

  getPeer(peerId: string): AudioSyncPeerSession | undefined {
    return this.peers.get(peerId);
  }

  getSync(peerId: string): ClockSyncEstimate | null {
    return this.peers.get(peerId)?.sync ?? null;
  }

  getAllSyncs(): Record<string, ClockSyncEstimate> {
    const out: Record<string, ClockSyncEstimate> = {};
    for (const [id, session] of this.peers) {
      if (session.sync) out[id] = session.sync;
    }
    return out;
  }

  close(): void {
    for (const session of this.peers.values()) {
      session.close();
    }
    this.peers.clear();
  }

  private createSession(peerId: string): AudioSyncPeerSession {
    return new AudioSyncPeerSession(this.selfId, peerId, this.deps, {
      ...this.opts,
      onSyncUpdate: (est) => this.opts.onSyncUpdate?.(peerId, est),
      onStateChange: (state) => this.opts.onStateChange?.(peerId, state),
      onAppMessage: (payload) => this.opts.onAppMessage?.(peerId, payload),
    });
  }
}
