import { describe, expect, it } from "bun:test";
import { AUDIO_SYNC_GLOBAL_KEY, createAudioSyncHub } from "@lianki/debug-chat/audio-sync-hub";
import type {
  AudioSyncDataChannelLike,
  AudioSyncDataChannelState,
  AudioSyncIceCandidateInit,
  AudioSyncPeerConnectionLike,
} from "@lianki/debug-chat/audio-sync-rtc";

class FakeChannel implements AudioSyncDataChannelLike {
  label = "audio-sync";
  readyState: AudioSyncDataChannelState = "open";
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  peer?: FakeChannel;
  send(data: string) {
    this.peer?.onmessage?.({ data });
  }
  close() {
    this.readyState = "closed";
  }
}

class FakePeerConnection implements AudioSyncPeerConnectionLike {
  localDescription: { type: string; sdp: string } | null = null;
  remoteDescription: { type: string; sdp: string } | null = null;
  signalingState = "stable";
  connectionState = "connected";
  onicecandidate: ((ev: { candidate: AudioSyncIceCandidateInit | null }) => void) | null = null;
  ondatachannel: ((ev: { channel: AudioSyncDataChannelLike }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  remote?: FakePeerConnection;
  private ch?: FakeChannel;
  createDataChannel(label: string) {
    const c = new FakeChannel();
    c.label = label;
    this.ch = c;
    return c;
  }
  async createOffer() {
    return { type: "offer", sdp: "v=0\r\n" };
  }
  async createAnswer() {
    return { type: "answer", sdp: "v=0\r\n" };
  }
  async setLocalDescription(d: { type: string; sdp: string }) {
    this.localDescription = d;
  }
  async setRemoteDescription(d: { type: string; sdp: string }) {
    this.remoteDescription = d;
    if (d.type === "offer" && this.remote?.ch && !this.ch) {
      const r = new FakeChannel();
      r.peer = this.remote.ch;
      this.remote.ch.peer = r;
      this.ch = r;
      this.ondatachannel?.({ channel: r });
      queueMicrotask(() => {
        r.onopen?.();
        this.remote?.ch?.onopen?.();
      });
    }
  }
  async addIceCandidate() {}
  close() {
    this.connectionState = "closed";
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("createAudioSyncHub", () => {
  it("registers on globalThis, handles peer discovery & WebRTC signaling, and cleans up on close", async () => {
    const sent: unknown[] = [];
    const pc = new FakePeerConnection();

    const hub = createAudioSyncHub({
      cloud: () => null,
      ctx: () => null,
      sendHub: (m) => sent.push(m),
      createPeerConnection: () => pc,
      now: () => 1_000,
    });

    expect((globalThis as Record<string, unknown>)[AUDIO_SYNC_GLOBAL_KEY]).toBe(hub);
    expect(hub.enabled).toBe(true);
    expect(hub.hasPeers()).toBe(false);

    hub.requestPeers();
    expect(sent).toEqual([{ type: "audio-sync-peers" }]);

    expect(hub.handleHubEvent({ type: "unknown" })).toBe(false);
    expect(
      hub.handleHubEvent({
        type: "audio-sync-peers",
        selfId: "p-a",
        peers: [{ id: "p-b", label: "Windows" }],
      }),
    ).toBe(true);
    await tick();

    expect(
      hub.handleHubEvent({
        type: "audio-sync-signal",
        from: "p-b",
        signal: { kind: "answer", sdp: "v=0\r\n" },
      }),
    ).toBe(true);

    const prevLs = (globalThis as { localStorage?: unknown }).localStorage;
    const mem = new Map<string, string>();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => {
        mem.set(k, v);
      },
      removeItem: (k: string) => {
        mem.delete(k);
      },
    };
    try {
      hub.setDeviceOffsetMs(45);
      const st = hub.stats();
      expect(st.enabled).toBe(true);
      expect(st.selfId).toBe("p-a");
      expect(st.deviceOffsetMs).toBe(45);

      hub.setDeviceOffsetMs(0);
    } finally {
      if (prevLs === undefined) delete (globalThis as { localStorage?: unknown }).localStorage;
      else (globalThis as { localStorage?: unknown }).localStorage = prevLs;
    }
    expect(hub.feedMicPcm(new Float32Array(100), 16_000)).toBeNull();
    hub.close();
    hub.close();
    expect(hub.enabled).toBe(false);
    expect((globalThis as Record<string, unknown>)[AUDIO_SYNC_GLOBAL_KEY]).toBeUndefined();
  });

  it("connects two hubs over FakePeerConnection, plays synced, and calibrates offset via feedMicPcm", async () => {
    let clock = 5_000;
    const sr = 16_000;
    const refPcm = new Float32Array(Math.round(2.5 * sr));
    const bursts = [
      [200, 340, 0.7],
      [460, 560, 0.45],
      [680, 900, 0.85],
      [1020, 1180, 0.6],
      [1300, 1520, 0.9],
      [1650, 1800, 0.5],
      [1920, 2180, 0.8],
    ] as const;
    for (const [sMs, eMs, amp] of bursts) {
      const s = Math.round((sMs * sr) / 1000);
      const e = Math.round((eMs * sr) / 1000);
      for (let i = s; i < e; i++) {
        refPcm[i] = amp * Math.sin((2 * Math.PI * 330 * i) / sr);
      }
    }

    const scheduled: { when?: number; offset?: number }[] = [];
    const makeFakeCloud = () => ({
      decodeClip: async () => ({
        buffer: {
          duration: 1,
          sampleRate: sr,
          numberOfChannels: 1,
          getChannelData: () => refPcm,
        },
        shift: 1,
        decodeMs: 5,
        clipKey: "k1",
        fellBack: false,
      }),
      playScheduled: (opts: { when?: number; offset: number }) => {
        scheduled.push({ when: opts.when, offset: opts.offset });
        return { route: "audio" as const, stop: () => ({}), volume: () => false };
      },
      play: () => ({ route: "audio" as const, stop: () => ({}), volume: () => false }),
    });

    const pcA = new FakePeerConnection();
    const pcB = new FakePeerConnection();
    pcA.remote = pcB;
    pcB.remote = pcA;

    let hubA!: ReturnType<typeof createAudioSyncHub>;
    let hubB!: ReturnType<typeof createAudioSyncHub>;

    const makeCtx = (ct: number) => ({
      currentTime: ct,
      state: "running",
      decodeAudioData: async () => ({
        duration: 1,
        sampleRate: sr,
        numberOfChannels: 1,
        getChannelData: () => refPcm,
      }),
      createGain: () => ({
        gain: {
          value: 1,
          setValueAtTime() {},
          linearRampToValueAtTime() {},
          cancelScheduledValues() {},
        },
        connect() {},
      }),
      destination: {},
      createMediaElementSource: () => ({ connect() {} }),
      createBufferSource: () => ({
        buffer: null,
        playbackRate: { value: 1 },
        connect() {},
        start() {},
        stop() {},
        onended: null,
      }),
    });

    hubA = createAudioSyncHub({
      cloud: makeFakeCloud,
      ctx: () => makeCtx(10),
      sendHub: (m) => {
        if (m.type === "audio-sync-signal") {
          hubB.handleHubEvent({ type: "audio-sync-signal", from: "a", signal: m.signal });
        }
      },
      createPeerConnection: () => pcA,
      now: () => clock,
    });
    hubB = createAudioSyncHub({
      cloud: makeFakeCloud,
      ctx: () => makeCtx(20),
      sendHub: (m) => {
        if (m.type === "audio-sync-signal") {
          hubA.handleHubEvent({ type: "audio-sync-signal", from: "b", signal: m.signal });
        }
      },
      createPeerConnection: () => pcB,
      now: () => clock + 100,
    });

    hubA.handleHubEvent({
      type: "audio-sync-peers",
      selfId: "a",
      peers: [{ id: "b", label: "B" }],
    });
    hubB.handleHubEvent({
      type: "audio-sync-peers",
      selfId: "b",
      peers: [{ id: "a", label: "A" }],
    });
    await tick();
    await tick();
    await tick();
    expect(hubA.hasPeers()).toBe(true);

    hubA.playSynced({ text: "Hello.", lang: "en", at: 0, volume: 1 }, { onend() {}, onerror() {} });
    await tick();
    await tick();
    expect(scheduled.length).toBeGreaterThanOrEqual(2);

    // Feed delayed mic capture (+150ms) and verify acoustic delta detection
    const delaySamples = Math.round(0.15 * sr);
    const micPcm = new Float32Array(refPcm.length + delaySamples);
    micPcm.set(refPcm, delaySamples);
    const res = hubA.feedMicPcm(micPcm, sr);
    expect(res).not.toBeNull();
    expect(res!.reason).toBeNull();
    expect(res!.detected).toBe(true);
    expect(Math.abs(res!.deltaMs - 150)).toBeLessThan(15);

    hubA.close();
    hubB.close();
  });
});
