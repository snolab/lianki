// WebRTC card-sync client. Joins a room on the signaling server (s.lianki.com),
// negotiates a P2P RTCDataChannel with each peer via the relay, then exchanges
// arbitrary messages (the caller uses this to swap card decks and merge). The
// signaling server only carries the handshake; card data flows peer-to-peer.

const SIGNAL_ORIGIN = (import.meta.env.VITE_SIGNAL_ORIGIN as string) || "wss://s.lianki.com";

const ICE: RTCConfiguration = {
  iceServers: [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }],
};

type Handlers = {
  onOpen?: (peerId: string, send: (data: string) => void) => void;
  onMessage?: (peerId: string, data: string) => void;
  onPeers?: (count: number) => void;
};

export type SyncSession = { send: (data: string) => void; close: () => void };

/** Join `room` and wire up P2P data channels. Returns a broadcast/close handle. */
export function joinRoom(room: string, h: Handlers): SyncSession {
  const ws = new WebSocket(`${SIGNAL_ORIGIN}/signal?room=${encodeURIComponent(room)}`);
  const peers = new Map<string, { pc: RTCPeerConnection; dc?: RTCDataChannel }>();
  let selfId = "";

  const signal = (msg: Record<string, unknown>) =>
    ws.readyState === 1 && ws.send(JSON.stringify(msg));

  const wire = (peerId: string, dc: RTCDataChannel) => {
    const rec = peers.get(peerId);
    if (rec) rec.dc = dc;
    dc.onopen = () => h.onOpen?.(peerId, (data) => dc.readyState === "open" && dc.send(data));
    dc.onmessage = (e) => h.onMessage?.(peerId, String(e.data));
  };

  const makePeer = (peerId: string, initiator: boolean) => {
    const pc = new RTCPeerConnection(ICE);
    peers.set(peerId, { pc });
    pc.onicecandidate = (e) =>
      e.candidate && signal({ type: "ice", to: peerId, candidate: e.candidate });
    pc.ondatachannel = (e) => wire(peerId, e.channel);
    if (initiator) {
      const dc = pc.createDataChannel("lianki");
      wire(peerId, dc);
      pc.createOffer()
        .then((o) => pc.setLocalDescription(o))
        .then(() => signal({ type: "offer", to: peerId, sdp: pc.localDescription }));
    }
    return pc;
  };

  ws.onmessage = async (ev) => {
    const msg = JSON.parse(String(ev.data));
    switch (msg.type) {
      case "welcome":
        selfId = msg.peerId;
        for (const p of msg.peers as string[]) makePeer(p, true); // I initiate to existing peers
        h.onPeers?.(peers.size);
        break;
      case "peer-join":
        h.onPeers?.(peers.size + 1); // they will initiate to me
        break;
      case "offer": {
        const pc = makePeer(msg.from, false);
        await pc.setRemoteDescription(msg.sdp);
        const ans = await pc.createAnswer();
        await pc.setLocalDescription(ans);
        signal({ type: "answer", to: msg.from, sdp: pc.localDescription });
        break;
      }
      case "answer":
        await peers.get(msg.from)?.pc.setRemoteDescription(msg.sdp);
        break;
      case "ice":
        await peers
          .get(msg.from)
          ?.pc.addIceCandidate(msg.candidate)
          .catch(() => {});
        break;
      case "peer-leave":
        peers.get(msg.peerId)?.pc.close();
        peers.delete(msg.peerId);
        h.onPeers?.(peers.size);
        break;
    }
  };

  return {
    send: (data) => {
      for (const { dc } of peers.values()) if (dc?.readyState === "open") dc.send(data);
    },
    close: () => {
      for (const { pc } of peers.values()) pc.close();
      ws.close();
    },
  };
}

/** A stable, opaque room key for a shared secret (token / deck code). */
export async function roomKey(secret: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode("lianki-sync:" + secret),
  );
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}
