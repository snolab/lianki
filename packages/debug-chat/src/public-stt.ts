/**
 * Lianki's speech servers for accounts other than the owner (docs/local-stt.md,
 * "Lianki's speech servers for everyone"; flag stt.worker): the routes the
 * mic's race (createLocalStt) opens for them, each looking like a WebSocket
 * (WsLike) so the race, the protocol and the fallback stay exactly the owner's.
 *
 *   rtc:lianki   POST /api/stt/session (a v2 ticket, the ICE servers) → the
 *                SttRegistry's signal socket (lianki-push) → an RTCPeerConnection
 *                to a speech server's stt-peer, DataChannel "stt" = the socket.
 *   wss:session  the same session's WSS fallback (a tunnel to a speech server),
 *                when /api/stt/session names one; else it fails at once.
 *
 * Any failure (no session: flag off, not allowed, a quota; no worker; ICE)
 * closes the shim before `ready`, so that route loses the race; all of them
 * losing is the cloud (/api/debug/stt), as for every route. A new ticket per
 * route per race: each is spent once by the registry and once by the speech
 * server. The order is pluggable: PUBLIC_ROUTES, and later a user's own Mac.
 *
 * Owner pages never use this (localSttRoute decides first). Nothing polls.
 */
import type { WsLike } from "./local-stt";

/** The slice of fetch used (a fake in the tests). */
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const PUBLIC_RTC_URL = "rtc:lianki";
export const PUBLIC_WSS_URL = "wss:session";
/** The race's order for other accounts: WebRTC first, then the WSS tunnel (the cloud comes after both). */
export const PUBLIC_ROUTES = [PUBLIC_RTC_URL, PUBLIC_WSS_URL] as const;
export const SESSION_PATH = "/api/stt/session";
/** The one page origin these routes run on (the registry checks it too). */
export const STT_PAGE_ORIGIN = "https://lianki.com";
export const V2_SUBPROTOCOL = "lianki-stt2";
/** WebRTC needs a round trip more than a socket: the race waits this long for these routes. */
export const PUBLIC_CONNECT_TIMEOUT_MS = 6_000;

export type PublicSession = {
  ticket: string;
  signal: string;
  iceServers: RTCIceServer[];
  wss?: string;
};

export const isPublicRoute = (u: string) => (PUBLIC_ROUTES as readonly string[]).includes(u);
/** A mic route list (space separated) that is Lianki's speech servers' public one. */
export const isPublicRoutes = (urls: string) => urls.split(/[\s,]+/).some(isPublicRoute);
/**
 * A route list that mixes them with the owner's own sockets (the tailnet, the tunnel):
 * his phone reaching his own Mac over WebRTC beside the tailnet (docs/local-stt.md,
 * "His own Mac over WebRTC"). His device, thread and filter go along on every route.
 */
export const isMixedRoutes = (urls: string) => {
  const list = urls.split(/[\s,]+/).filter(Boolean);
  return list.some(isPublicRoute) && list.some((u) => !isPublicRoute(u));
};
/** The route list the mic gets once the account may use them and agreed (DebugChat). */
export const PUBLIC_ROUTE_LIST = PUBLIC_ROUTES.join(" ");

/**
 * The account's answer to the consent card on this device: "on" (agreed) or
 * "off" (declined); unset = ask. localStorage, so it is asked once per device.
 */
export const CONSENT_KEY = "lk:stt-servers";
export function readConsent(s: Pick<Storage, "getItem"> | undefined = globalThis.localStorage): "on" | "off" | null {
  try {
    const v = s?.getItem(CONSENT_KEY);
    return v === "on" || v === "off" ? v : null;
  } catch {
    return null;
  }
}
export function writeConsent(v: "on" | "off", s: Pick<Storage, "setItem"> | undefined = globalThis.localStorage) {
  try {
    s?.setItem(CONSENT_KEY, v);
  } catch {}
}

/** A session from lianki.com, or why not (an HTTP status or a reason code). */
export async function fetchSession(f: FetchLike = fetch): Promise<PublicSession> {
  const r = await f(SESSION_PATH, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  if (!r.ok) throw new Error(`stt session: HTTP ${r.status}`);
  const b = (await r.json()) as Partial<PublicSession>;
  if (typeof b.ticket !== "string" || typeof b.signal !== "string" || !b.signal.startsWith("/"))
    throw new Error("stt session: bad answer");
  return { ticket: b.ticket, signal: b.signal, iceServers: b.iceServers ?? [], wss: b.wss };
}

type SockLike = {
  readyState: number;
  binaryType?: string;
  send(d: string | ArrayBufferLike | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  onopen: ((e: unknown) => void) | null;
  onclose: ((e: { code?: number; reason?: string }) => void) | null;
  onerror: ((e: unknown) => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
};
type ChannelLike = {
  readyState: string;
  binaryType: string;
  send(d: string | ArrayBufferLike | ArrayBufferView): void;
  close(): void;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
};
type PeerLike = {
  createDataChannel(label: string, o?: { ordered?: boolean }): ChannelLike;
  createOffer(): Promise<{ sdp?: string; type: string }>;
  setLocalDescription(d: { sdp?: string; type: string }): Promise<void>;
  setRemoteDescription(d: { sdp: string; type: "answer" }): Promise<void>;
  addIceCandidate(c: unknown): Promise<void>;
  close(): void;
  onicecandidate: ((e: { candidate: { toJSON(): unknown } | null }) => void) | null;
  onconnectionstatechange: (() => void) | null;
  connectionState: string;
};

export type PublicDeps = {
  fetch?: FetchLike;
  /** new RTCPeerConnection (a fake in the tests). */
  peer?: (o: { iceServers: RTCIceServer[] }) => PeerLike;
  /** new WebSocket. */
  socket?: (url: string, protocols: string[]) => SockLike;
  /** The page's origin as wss:// (the signal socket goes to lianki.com itself). */
  origin?: () => string;
  log?: (ev: Record<string, unknown>) => void;
};

/**
 * The `open` for createLocalStt on another account's page: a WsLike for each
 * public route, connecting in the background.
 */
export function publicOpen(d: PublicDeps = {}): (url: string) => WsLike {
  const f = d.fetch ?? ((...a: Parameters<FetchLike>) => fetch(...a));
  const peer = d.peer ?? ((o) => new RTCPeerConnection(o) as unknown as PeerLike);
  const socket = d.socket ?? ((u, p) => new WebSocket(u, p) as unknown as SockLike);
  const origin = d.origin ?? (() => location.origin.replace(/^http/, "ws"));
  return (url) => {
    const shim = new Shim();
    if (url === PUBLIC_RTC_URL) void rtc(shim, { f, peer, socket, origin, log: d.log });
    else if (url === PUBLIC_WSS_URL) void wss(shim, { f, socket, log: d.log });
    else queueMicrotask(() => shim.fail(4000, "not a public route"));
    return shim;
  };
}

/** The `open` for a mixed list: a public route through publicOpen, any other a plain WebSocket. */
export function mixedOpen(
  d: PublicDeps = {},
  ws: (url: string, protocols?: string[]) => WsLike = (u, p) =>
    new WebSocket(u, p) as unknown as WsLike,
): (url: string, protocols?: string[]) => WsLike {
  const pub = publicOpen(d);
  return (url, protocols) => (isPublicRoute(url) ? pub(url) : ws(url, protocols));
}

/** A WebSocket's face on whatever carries the protocol. */
class Shim implements WsLike {
  readyState = 0;
  binaryType = "arraybuffer";
  onopen: ((e: unknown) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  /** What the shim sends through, once it is open. */
  out: ((d: string | Uint8Array) => void) | null = null;
  /** What closes the carriers (set by the route). */
  cleanup: () => void = () => {};

  send(d: string | Uint8Array) {
    if (this.readyState !== 1 || !this.out) throw new Error("not open");
    this.out(d);
  }
  open(out: (d: string | Uint8Array) => void) {
    if (this.readyState !== 0) return;
    this.out = out;
    this.readyState = 1;
    this.onopen?.({});
  }
  message(data: unknown) {
    if (this.readyState === 1) this.onmessage?.({ data });
  }
  fail(code: number, reason: string) {
    if (this.readyState >= 2) return;
    this.readyState = 3;
    try {
      this.cleanup();
    } catch {}
    this.onclose?.({ code, reason, wasClean: false });
  }
  close() {
    this.fail(1000, "closed");
  }
}

async function rtc(
  shim: Shim,
  d: {
    f: FetchLike;
    peer: NonNullable<PublicDeps["peer"]>;
    socket: NonNullable<PublicDeps["socket"]>;
    origin: () => string;
    log?: PublicDeps["log"];
  },
) {
  let s: PublicSession;
  try {
    s = await fetchSession(d.f);
  } catch (e) {
    return shim.fail(4001, String((e as Error).message).slice(0, 60));
  }
  if (shim.readyState >= 2) return;
  let pc: PeerLike | null = null;
  let dc: ChannelLike | null = null;
  const sig = d.socket(`${d.origin()}${s.signal}`, [V2_SUBPROTOCOL, s.ticket]);
  shim.cleanup = () => {
    try {
      dc?.close();
    } catch {}
    try {
      pc?.close();
    } catch {}
    try {
      sig.close(1000, "done");
    } catch {}
  };
  const say = (m: unknown) => {
    try {
      sig.send(JSON.stringify(m));
    } catch {}
  };
  // The signal socket lives as long as the session: the registry counts sessions by it.
  sig.onclose = (e) => shim.fail(e.code ?? 4002, e.reason || "signal closed");
  sig.onerror = () => {};
  // One message at a time, in order: the worker's ICE right behind its answer
  // must wait for setRemoteDescription, or the browser refuses it.
  let chain: Promise<void> = Promise.resolve();
  sig.onmessage = (e) => {
    chain = chain.then(() => handle(e)).catch(() => {});
  };
  const handle = async (e: { data: unknown }) => {
    let m: { t?: string; sdp?: string; candidate?: unknown; reason?: string };
    try {
      m = JSON.parse(String(e.data));
    } catch {
      return;
    }
    if (m.t === "ready" && !pc) {
      pc = d.peer({ iceServers: s.iceServers });
      dc = pc.createDataChannel("stt", { ordered: true });
      dc.binaryType = "arraybuffer";
      const ch = dc;
      ch.onopen = () =>
        shim.open((x) => (typeof x === "string" ? ch.send(x) : ch.send(x as Uint8Array)));
      ch.onmessage = (ev) => shim.message(ev.data);
      ch.onclose = () => shim.fail(4003, "channel closed");
      pc.onicecandidate = (ev) => say({ t: "ice", candidate: ev.candidate ? ev.candidate.toJSON() : null });
      const p = pc;
      pc.onconnectionstatechange = () => {
        if (p.connectionState === "failed") shim.fail(4004, "ice failed");
      };
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        say({ t: "offer", sdp: offer.sdp });
      } catch {
        shim.fail(4005, "offer");
      }
    } else if (m.t === "answer" && pc && typeof m.sdp === "string") {
      try {
        await pc.setRemoteDescription({ type: "answer", sdp: m.sdp });
      } catch {
        shim.fail(4006, "answer");
      }
    } else if (m.t === "ice" && pc && m.candidate) {
      try {
        await pc.addIceCandidate(m.candidate);
      } catch {}
    } else if (m.t === "end") {
      shim.fail(4007, m.reason || "end");
    }
  };
}

async function wss(
  shim: Shim,
  d: { f: FetchLike; socket: NonNullable<PublicDeps["socket"]>; log?: PublicDeps["log"] },
) {
  let s: PublicSession;
  try {
    s = await fetchSession(d.f);
  } catch (e) {
    return shim.fail(4001, String((e as Error).message).slice(0, 60));
  }
  if (shim.readyState >= 2) return;
  if (!s.wss) return shim.fail(4008, "no wss route");
  const ws = d.socket(s.wss, [V2_SUBPROTOCOL, s.ticket]);
  ws.binaryType = "arraybuffer";
  shim.cleanup = () => {
    try {
      ws.close();
    } catch {}
  };
  ws.onopen = () => shim.open((x) => ws.send(x));
  ws.onmessage = (e) => shim.message(e.data);
  ws.onerror = () => {};
  ws.onclose = (e) => shim.fail(e.code ?? 4002, e.reason || "closed");
}

/**
 * Has this account a session on Lianki's speech servers at all? Asked once per
 * page when the mic turns on (never in an utterance's path): a GET answers 404
 * while the flag is off or for an account not on the list, 204 otherwise.
 */
export async function publicSttAvailable(
  f: FetchLike = fetch,
  origin: string | undefined = globalThis.location?.origin,
): Promise<boolean> {
  // Only on lianki.com itself: the widget on another site (the userscript) must
  // never send this to that site, and the registry takes lianki.com pages only.
  if (origin !== STT_PAGE_ORIGIN) return false;
  try {
    const r = await f(SESSION_PATH, { method: "GET", credentials: "same-origin" });
    return r.status === 204;
  } catch {
    return false;
  }
}
