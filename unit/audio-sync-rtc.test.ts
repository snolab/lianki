import { describe, expect, it } from "bun:test";
import { DebugHub, type Socket, type Storage } from "@/workers/push/src/debug";
import type { Identity } from "@/lib/dev-eval";
import {
  AUDIO_SYNC_CHANNEL,
  AudioSyncClockFilter,
  type AudioSyncDataChannelLike,
  type AudioSyncIceCandidateInit,
  type AudioSyncPeerConnectionLike,
  AudioSyncPeerSession,
  AudioSyncRtcManager,
} from "@/packages/debug-chat/src/audio-sync-rtc";
import { type AudioSyncSignalPayload, cleanAudioSyncSignal } from "@/packages/debug-chat/src/wire";

class FakeSocket implements Socket {
  sent: Record<string, unknown>[] = [];
  readyState = 1;
  closed?: number;
  private att: unknown = null;
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code?: number) {
    this.readyState = 3;
    this.closed = code;
  }
  serializeAttachment(v: unknown) {
    this.att = structuredClone(v);
  }
  deserializeAttachment() {
    return this.att;
  }
  last(type: string) {
    return this.sent.filter((m) => m.type === type).at(-1);
  }
}

function fakeStorage(): Storage & { puts: number } {
  const store = new Map<string, unknown>();
  const storage: Storage & { puts: number } = {
    puts: 0,
    getAlarm: async () => null,
    setAlarm: async () => {},
    get: async <T>(k: string) => structuredClone(store.get(k)) as T | undefined,
    put: async (k, v) => {
      storage.puts += 1;
      store.set(k, structuredClone(v));
    },
    delete: async (k) => store.delete(k),
    list: async <T>({
      prefix,
      reverse,
      limit,
    }: {
      prefix: string;
      reverse?: boolean;
      limit?: number;
    }) => {
      let keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
      if (reverse) keys.reverse();
      if (limit !== undefined) keys = keys.slice(0, limit);
      return new Map(keys.map((k) => [k, structuredClone(store.get(k)) as T]));
    },
  };
  return storage;
}

function createHub() {
  const sockets: FakeSocket[] = [];
  const storage = fakeStorage();
  let t = 1_000_000;
  const hub = new DebugHub(
    {
      acceptWebSocket: (ws) => sockets.push(ws as FakeSocket),
      getWebSockets: () => sockets,
      storage,
    },
    undefined,
    () => t,
  );
  const connectPage = async (tab: string, label: string, who?: Identity, extraQuery = "") => {
    const ws = new FakeSocket();
    sockets.push(ws);
    await hub.connectPage(
      ws,
      new URL(
        `https://lianki.com/api/version/debug?tab=${encodeURIComponent(tab)}&label=${encodeURIComponent(label)}${extraQuery}`,
      ),
      who,
    );
    return ws;
  };
  return { hub, storage, connectPage, advance: (ms: number) => (t += ms) };
}

class FakeDataChannel implements AudioSyncDataChannelLike {
  readonly label: string;
  readonly init?: { ordered?: boolean; maxRetransmits?: number };
  readyState: "connecting" | "open" | "closing" | "closed" = "connecting";
  onopen: ((ev?: unknown) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  peer?: FakeDataChannel;
  onSend?: (data: string, deliver: () => void) => void;

  constructor(label: string, init?: { ordered?: boolean; maxRetransmits?: number }) {
    this.label = label;
    this.init = init;
  }

  open() {
    if (this.readyState === "open") return;
    this.readyState = "open";
    this.onopen?.();
  }

  send(data: string) {
    if (this.readyState !== "open") throw new Error("DataChannel not open");
    const deliver = () => {
      if (this.peer && this.peer.readyState === "open") {
        this.peer.onmessage?.({ data });
      }
    };
    if (this.onSend) {
      this.onSend(data, deliver);
    } else {
      deliver();
    }
  }

  close() {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    this.onclose?.();
  }
}

class FakePeerConnection implements AudioSyncPeerConnectionLike {
  connectionState = "new";
  iceConnectionState = "new";
  onicecandidate: ((ev: { candidate: AudioSyncIceCandidateInit | null }) => void) | null = null;
  ondatachannel: ((ev: { channel: AudioSyncDataChannelLike }) => void) | null = null;
  onconnectionstatechange: ((ev?: unknown) => void) | null = null;
  remoteDescSet = false;
  addedCandidates: AudioSyncIceCandidateInit[] = [];
  createdChannels: FakeDataChannel[] = [];
  remote?: FakePeerConnection;
  private onChannelCreated?: (ch: FakeDataChannel) => void;

  constructor(onChannelCreated?: (ch: FakeDataChannel) => void) {
    this.onChannelCreated = onChannelCreated;
  }

  createDataChannel(label: string, init?: { ordered?: boolean; maxRetransmits?: number }) {
    const ch = new FakeDataChannel(label, init);
    this.createdChannels.push(ch);
    this.onChannelCreated?.(ch);
    return ch;
  }

  async createOffer() {
    return { type: "offer", sdp: "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n" };
  }

  async createAnswer() {
    return { type: "answer", sdp: "v=0\r\no=- 2 1 IN IP4 127.0.0.1\r\n" };
  }

  async setLocalDescription(_desc: { type: "offer" | "answer"; sdp: string }) {
    // Emit a synthetic ICE candidate after local description is set
    this.onicecandidate?.({
      candidate: {
        candidate: "candidate:1 1 UDP 2122252543 192.168.1.2 5000 typ host",
        sdpMid: "0",
        sdpMLineIndex: 0,
      },
    });
  }

  async setRemoteDescription(desc: { type: "offer" | "answer"; sdp: string }) {
    this.remoteDescSet = true;
    if (desc.type === "answer" && this.remote) {
      this.connectChannels(this, this.remote);
    }
  }

  async addIceCandidate(candidate: AudioSyncIceCandidateInit) {
    if (!this.remoteDescSet) {
      throw new Error("addIceCandidate called before setRemoteDescription");
    }
    this.addedCandidates.push(candidate);
  }

  private connectChannels(a: FakePeerConnection, b: FakePeerConnection) {
    const localCh = a.createdChannels[0] ?? b.createdChannels[0];
    if (!localCh) return;
    const owner = a.createdChannels[0] ? a : b;
    const other = owner === a ? b : a;
    const remoteCh = new FakeDataChannel(localCh.label, localCh.init);
    this.onChannelCreated?.(remoteCh);
    other.onChannelCreated?.(remoteCh);
    localCh.peer = remoteCh;
    remoteCh.peer = localCh;
    owner.connectionState = "connected";
    other.connectionState = "connected";
    other.ondatachannel?.({ channel: remoteCh });
    localCh.open();
    remoteCh.open();
  }

  close() {
    this.connectionState = "closed";
  }
}

describe("DebugHub audio-sync signaling relay", () => {
  it("lists same-account peers and excludes cross-account and embedded pages", async () => {
    const { hub, storage, connectPage } = createHub();
    const ownerA = await connectPage("aaaaaaaa", "Mac");
    const ownerB = await connectPage("bbbbbbbb", "iPhone");
    const ownerEmbed = await connectPage("eeeeeeee", "Embed", undefined, "&frame=foreign");
    const friend1: Identity = { userId: "user_1", email: "f1@example.com", owner: false };
    const friend2: Identity = { userId: "user_2", email: "f2@example.com", owner: false };
    const friend1a = await connectPage("f1aaaaaa", "Friend1 A", friend1);
    const friend1b = await connectPage("f1bbbbbb", "Friend1 B", friend1);
    const friend2a = await connectPage("f2aaaaaa", "Friend2 A", friend2);

    const putsBefore = storage.puts;
    await hub.webSocketMessage(ownerA, JSON.stringify({ type: "audio-sync-peers" }));
    await hub.webSocketMessage(friend1a, JSON.stringify({ type: "audio-sync-peers" }));
    await hub.webSocketMessage(ownerEmbed, JSON.stringify({ type: "audio-sync-peers" }));

    expect(storage.puts).toBe(putsBefore);
    expect(ownerA.last("audio-sync-peers")).toEqual({
      type: "audio-sync-peers",
      selfId: "aaaaaaaa",
      peers: [{ id: "bbbbbbbb", label: "iPhone" }],
    });
    expect(friend1a.last("audio-sync-peers")).toEqual({
      type: "audio-sync-peers",
      selfId: "f1aaaaaa",
      peers: [{ id: "f1bbbbbb", label: "Friend1 B" }],
    });
    expect(ownerEmbed.last("audio-sync-peers")).toBeUndefined();
    expect(ownerB.last("audio-sync-peers")).toBeUndefined();
    expect(friend1b.last("audio-sync-peers")).toBeUndefined();
    expect(friend2a.last("audio-sync-peers")).toBeUndefined();
  });

  it("relays audio-sync-signal only within the same authenticated account and never touches storage", async () => {
    const { hub, storage, connectPage } = createHub();
    const ownerA = await connectPage("aaaaaaaa", "Mac");
    const ownerB = await connectPage("bbbbbbbb", "iPhone");
    const friend1: Identity = { userId: "user_1", email: "f1@example.com", owner: false };
    const friend1a = await connectPage("f1aaaaaa", "Friend1 A", friend1);

    const putsBefore = storage.puts;
    const offer: AudioSyncSignalPayload = { kind: "offer", sdp: "v=0\r\n" };
    const candidate: AudioSyncSignalPayload = {
      kind: "candidate",
      candidate: "candidate:1 1 UDP 123 127.0.0.1 9000 typ host",
      sdpMid: "0",
      sdpMLineIndex: 0,
    };

    // Same-account relay succeeds
    await hub.webSocketMessage(
      ownerA,
      JSON.stringify({ type: "audio-sync-signal", to: "bbbbbbbb", signal: offer }),
    );
    await hub.webSocketMessage(
      ownerA,
      JSON.stringify({ type: "audio-sync-signal", to: "bbbbbbbb", signal: candidate }),
    );
    expect(ownerB.sent.filter((m) => m.type === "audio-sync-signal")).toEqual([
      { type: "audio-sync-signal", from: "aaaaaaaa", signal: offer },
      { type: "audio-sync-signal", from: "aaaaaaaa", signal: candidate },
    ]);

    // Cross-account relay is dropped
    await hub.webSocketMessage(
      ownerA,
      JSON.stringify({ type: "audio-sync-signal", to: "f1aaaaaa", signal: offer }),
    );
    await hub.webSocketMessage(
      friend1a,
      JSON.stringify({ type: "audio-sync-signal", to: "bbbbbbbb", signal: offer }),
    );
    expect(friend1a.last("audio-sync-signal")).toBeUndefined();
    expect(ownerB.sent.filter((m) => m.type === "audio-sync-signal").length).toBe(2);

    // Self-signaling is dropped
    await hub.webSocketMessage(
      ownerA,
      JSON.stringify({ type: "audio-sync-signal", to: "aaaaaaaa", signal: offer }),
    );
    expect(ownerA.last("audio-sync-signal")).toBeUndefined();

    // Never writes to storage
    expect(storage.puts).toBe(putsBefore);
  });

  it("validates and bounds signaling payloads via cleanAudioSyncSignal", () => {
    expect(cleanAudioSyncSignal({ kind: "offer", sdp: "v=0" })).toEqual({
      kind: "offer",
      sdp: "v=0",
    });
    expect(cleanAudioSyncSignal({ kind: "offer", sdp: "" })).toBeUndefined();
    expect(cleanAudioSyncSignal({ kind: "offer", sdp: "x".repeat(13 * 1024) })).toBeUndefined();
    expect(cleanAudioSyncSignal({ kind: "unknown", sdp: "v=0" })).toBeUndefined();
    expect(
      cleanAudioSyncSignal({ kind: "candidate", candidate: "c", sdpMid: null, sdpMLineIndex: 1 }),
    ).toEqual({ kind: "candidate", candidate: "c", sdpMid: null, sdpMLineIndex: 1 });
  });
});

describe("AudioSyncClockFilter", () => {
  it("computes exact offsetMs (peerClock - localClock) and rttMs", () => {
    const filter = new AudioSyncClockFilter();
    // Peer clock is +250ms ahead of local clock; 10ms one-way delay; 2ms peer processing
    const t1 = 1000;
    const t2 = 1000 + 10 + 250; // 1260
    const t3 = 1262;
    const t4 = 1000 + 10 + 2 + 10; // 1022
    const est = filter.addSample(t1, t2, t3, t4);

    expect(est).not.toBeNull();
    expect(est!.rttMs).toBe(20);
    expect(est!.offsetMs).toBe(250);
    expect(est!.jitterMs).toBe(0);
    expect(filter.toPeerTime(2000)).toBe(2250);
    expect(filter.toLocalTime(2250)).toBe(2000);
  });

  it("rejects invalid or negative-RTT samples", () => {
    const filter = new AudioSyncClockFilter();
    expect(filter.addSample(100, 100, 100, 90)).toBeNull();
    expect(filter.addSample(Number.NaN, 100, 100, 110)).toBeNull();
    expect(filter.estimate).toBeNull();
  });

  it("filters out asymmetric queuing spikes by minimum RTT to keep jitter < 5ms", () => {
    const filter = new AudioSyncClockFilter({
      windowSize: 8,
      minRttMarginMs: 4,
      maxFilteredSamples: 3,
    });
    const trueOffset = 420.5;
    // Simulate 16 rounds: 10ms baseline RTT with +-1ms symmetric noise, plus occasional 40-80ms uplink spikes
    const rounds = [
      { up: 5.2, down: 4.8 },
      { up: 45.0, down: 5.0 }, // asymmetric spike (+20ms bias if unfiltered!)
      { up: 4.9, down: 5.1 },
      { up: 5.1, down: 4.9 },
      { up: 75.0, down: 5.2 }, // huge asymmetric spike (+35ms bias if unfiltered!)
      { up: 5.0, down: 5.0 },
      { up: 4.8, down: 5.2 },
      { up: 60.0, down: 5.0 }, // huge asymmetric spike
    ];

    let est = null;
    for (let i = 0; i < rounds.length; i++) {
      const { up, down } = rounds[i]!;
      const t1 = 10_000 + i * 1000;
      const t2 = t1 + up + trueOffset;
      const t3 = t2 + 0.5;
      const t4 = t1 + up + 0.5 + down;
      est = filter.addSample(t1, t2, t3, t4);
    }

    expect(est).not.toBeNull();
    expect(Math.abs(est!.offsetMs - trueOffset)).toBeLessThan(1);
    expect(est!.rttMs).toBeCloseTo(10, 1);
    expect(est!.jitterMs).toBeLessThan(5);
    expect(est!.sampleCount).toBe(8);
  });

  it("adapts when baseline RTT shifts permanently after windowSize samples", () => {
    const filter = new AudioSyncClockFilter({ windowSize: 4, minRttMarginMs: 3 });
    for (let i = 0; i < 4; i++) {
      filter.addSample(1000, 1105, 1105, 1010); // rtt 10, offset +100
    }
    expect(filter.estimate!.rttMs).toBe(10);

    for (let i = 0; i < 4; i++) {
      filter.addSample(2000, 2120, 2120, 2040); // rtt 40, offset +100
    }
    expect(filter.estimate!.rttMs).toBe(40);
    expect(filter.estimate!.offsetMs).toBe(100);
    filter.reset();
    expect(filter.estimate).toBeNull();
  });
});

describe("AudioSyncPeerSession & AudioSyncRtcManager", () => {
  it("establishes DataChannel('audio-sync') via signaling and syncs clocks with <5ms jitter", async () => {
    let localClockA = 50_000;
    const trueOffsetBMinusA = 1250.5; // B's clock is 1250.5ms ahead of A's clock

    const pcA = new FakePeerConnection((ch) => {
      // Simulate 4ms uplink, 4ms downlink (8ms RTT) on DataChannel messages from A -> B
      ch.onSend = (data, deliver) => {
        localClockA += 4;
        deliver();
      };
    });
    const pcB = new FakePeerConnection((ch) => {
      ch.onSend = (data, deliver) => {
        localClockA += 4;
        deliver();
      };
    });
    pcA.remote = pcB;
    pcB.remote = pcA;

    const intervals = new Map<number, () => void>();
    let nextTimerId = 1;

    let mgrA!: AudioSyncRtcManager;
    let mgrB!: AudioSyncRtcManager;

    mgrA = new AudioSyncRtcManager(
      "peer-a",
      {
        createPeerConnection: () => pcA,
        sendSignal: (to, signal) => {
          expect(to).toBe("peer-b");
          void mgrB.handleSignal("peer-a", signal);
        },
        now: () => localClockA,
        setInterval: (fn) => {
          const id = nextTimerId++;
          intervals.set(id, fn);
          return id;
        },
        clearInterval: (id) => {
          intervals.delete(id as number);
        },
      },
      { pingIntervalMs: 500 },
    );

    mgrB = new AudioSyncRtcManager(
      "peer-b",
      {
        createPeerConnection: () => pcB,
        sendSignal: (to, signal) => {
          expect(to).toBe("peer-a");
          void mgrA.handleSignal("peer-b", signal);
        },
        now: () => localClockA + trueOffsetBMinusA,
        setInterval: (fn) => {
          const id = nextTimerId++;
          intervals.set(id, fn);
          return id;
        },
        clearInterval: (id) => {
          intervals.delete(id as number);
        },
      },
      { pingIntervalMs: 500 },
    );

    // peer-a < peer-b, so peer-a initiates when syncing peers
    await mgrA.syncPeers([{ id: "peer-b", label: "iPhone" }]);
    await mgrB.syncPeers([{ id: "peer-a", label: "Mac" }]);

    expect(pcA.createdChannels[0]?.label).toBe(AUDIO_SYNC_CHANNEL);
    expect(pcA.createdChannels[0]?.init).toEqual({ ordered: false, maxRetransmits: 0 });
    expect(mgrA.getPeer("peer-b")?.state).toBe("connected");
    expect(mgrB.getPeer("peer-a")?.state).toBe("connected");

    // Trigger several ping-pong rounds
    for (let i = 0; i < 6; i++) {
      for (const fn of intervals.values()) fn();
    }

    const syncA = mgrA.getSync("peer-b");
    const syncB = mgrB.getSync("peer-a");
    expect(syncA).not.toBeNull();
    expect(syncB).not.toBeNull();

    // A sees B - A = +1250.5ms
    expect(Math.abs(syncA!.offsetMs - trueOffsetBMinusA)).toBeLessThan(1);
    expect(syncA!.rttMs).toBeCloseTo(8, 1);
    expect(syncA!.jitterMs).toBeLessThan(5);

    // B sees A - B = -1250.5ms
    expect(Math.abs(syncB!.offsetMs + trueOffsetBMinusA)).toBeLessThan(1);
    expect(syncB!.rttMs).toBeCloseTo(8, 1);
    expect(syncB!.jitterMs).toBeLessThan(5);

    // ICE candidates were delivered and applied after remote description
    expect(pcA.addedCandidates.length).toBe(1);
    expect(pcB.addedCandidates.length).toBe(1);

    // App messages travel over the same DataChannel
    const receivedOnB: unknown[] = [];
    const sessionB = mgrB.getPeer("peer-a");
    expect(sessionB).toBeDefined();
    mgrA.close();
    mgrB.close();
    expect(intervals.size).toBe(0);
    expect(receivedOnB.length).toBe(0);
  });

  it("buffers ICE candidates arriving before remoteDescription and resolves glare politely", async () => {
    const signalsA: AudioSyncSignalPayload[] = [];
    const pc = new FakePeerConnection();

    const session = new AudioSyncPeerSession(
      "aaa",
      "bbb", // "aaa" < "bbb" => polite = true
      {
        createPeerConnection: () => pc,
        sendSignal: (_to, sig) => signalsA.push(sig),
        now: () => 1000,
      },
    );

    // Candidate arrives before offer
    await session.handleSignal({
      kind: "candidate",
      candidate: "candidate:early 1 UDP 1 127.0.0.1 1234 typ host",
      sdpMid: "0",
      sdpMLineIndex: 0,
    });
    expect(pc.addedCandidates.length).toBe(0);

    // Now offer arrives (even if we were also connecting -> polite accepts it)
    await session.handleSignal({ kind: "offer", sdp: "v=0\r\n" });
    expect(pc.addedCandidates.length).toBe(1);
    expect(signalsA.some((s) => s.kind === "answer")).toBe(true);
    session.close();
  });

  it("removes closed peers when syncPeers receives an updated peer list", async () => {
    const pc = new FakePeerConnection();
    const mgr = new AudioSyncRtcManager("aaa", {
      createPeerConnection: () => pc,
      sendSignal: () => {},
      now: () => 1000,
    });

    await mgr.syncPeers([{ id: "bbb", label: "iPhone" }]);
    expect(mgr.getPeer("bbb")).toBeDefined();

    await mgr.syncPeers([]);
    expect(mgr.getPeer("bbb")).toBeUndefined();
    expect(pc.connectionState).toBe("closed");
  });

  it("delivers app messages, tracks getSync/getAllSyncs, and handles disconnect/closed states", async () => {
    const tick = () => new Promise((r) => setTimeout(r, 0));
    let clock = 2_000;
    const pcA = new FakePeerConnection();
    const pcB = new FakePeerConnection();
    pcA.remote = pcB;
    pcB.remote = pcA;

    const appPayloads: { from: string; payload: unknown }[] = [];
    const states: string[] = [];
    let mgrA!: AudioSyncRtcManager;
    let mgrB!: AudioSyncRtcManager;

    mgrA = new AudioSyncRtcManager(
      "peer-1",
      {
        createPeerConnection: () => pcA,
        sendSignal: (_to, sig) => void mgrB.handleSignal("peer-1", sig),
        now: () => clock,
      },
      { onStateChange: (_id, s) => states.push(s) },
    );
    mgrB = new AudioSyncRtcManager(
      "peer-2",
      {
        createPeerConnection: () => pcB,
        sendSignal: (_to, sig) => void mgrA.handleSignal("peer-2", sig),
        now: () => clock + 50,
      },
      {
        onAppMessage: (from, payload) => appPayloads.push({ from, payload }),
      },
    );

    await mgrA.connectTo("peer-2");
    await tick();
    await tick();
    await tick();
    const sA = mgrA.getPeer("peer-2")!;
    sA.sendPing();
    sA.sendPing();
    sA.sendPing();
    expect(mgrA.getSync("peer-2")).not.toBeNull();
    expect(Object.keys(mgrA.getAllSyncs())).toEqual(["peer-2"]);

    expect(sA.sendAppMessage({ t: "sync-play", clipKey: "k1" })).toBe(true);
    expect(appPayloads).toEqual([{ from: "peer-1", payload: { t: "sync-play", clipKey: "k1" } }]);

    // Test toPeerTime / toLocalTime
    const peerT = sA.toPeerTime(1000);
    if (peerT === null) throw new Error("expected peerT");
    expect(sA.toLocalTime(peerT)).toBeCloseTo(1000, 1);

    // Simulate PC disconnected -> closed
    pcA.connectionState = "disconnected";
    pcA.onconnectionstatechange?.();
    expect(states).toContain("disconnected");
    pcA.connectionState = "closed";
    pcA.onconnectionstatechange?.();
    expect(states).toContain("closed");
    expect(sA.sendAppMessage({ x: 1 })).toBe(false);

    mgrB.close();

    // Test defaultNow / missing RTCPeerConnection guard
    expect(() => new AudioSyncPeerSession("x", "y", { sendSignal: () => {} })).toThrow(
      "RTCPeerConnection is not available",
    );
  });
});
