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
/** Resuming a dropped signal socket (stt-registry.ts STT_RESUME_SUBPROTOCOL). */
export const RESUME_SUBPROTOCOL = "lianki-stt2-resume";
/** The registry keeps a dropped session this long (stt-registry.ts RESUME_GRACE_MS). */
export const RESUME_GRACE_MS = 20_000;
/** ICE `disconnected` this long (it often comes back by itself) → an ICE restart. */
export const DISCONNECTED_GRACE_MS = 1_000;
/** An ICE restart not connected within this → the route is lost (the mic replays elsewhere). */
export const RESTART_TIMEOUT_MS = 5_000;
/** Dispatched on window when the lobby hears a worker is free: the mic races again (local-stt.ts). */
export const STT_AVAILABLE_EVENT = "lk-stt-available";

export type PublicSession = {
  ticket: string;
  signal: string;
  iceServers: RTCIceServer[];
  wss?: string;
  /** The ticket's expiry (seconds), when the answer gives it. */
  exp?: number;
};
/** A spare session is used only with at least this much of its ticket left (it lives 60 s). */
export const SPARE_MIN_LEFT_MS = 15_000;

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
  return {
    ticket: b.ticket,
    signal: b.signal,
    iceServers: b.iceServers ?? [],
    wss: b.wss,
    ...(typeof b.exp === "number" ? { exp: b.exp } : {}),
  };
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
  createOffer(o?: { iceRestart?: boolean }): Promise<{ sdp?: string; type: string }>;
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
  /** The page coming online or back to the foreground; returns an unsubscribe. */
  events?: (f: (why: "online" | "visible") => void) => () => void;
  setTimer?: (f: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  now?: () => number;
  /** A worker is free again (the lobby heard it): default, STT_AVAILABLE_EVENT on window. */
  available?: () => void;
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
  const now = d.now ?? (() => Date.now());
  const r = {
    f,
    session: spareSessions(f, now),
    peer,
    socket,
    origin,
    log: d.log,
    events: d.events ?? pageEvents,
    setTimer: d.setTimer ?? ((g: () => void, ms: number) => setTimeout(g, ms)),
    clearTimer: d.clearTimer ?? ((t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>)),
    now,
    available:
      d.available ??
      (() => {
        if (typeof window !== "undefined") window.dispatchEvent(new Event(STT_AVAILABLE_EVENT));
      }),
  };
  return (url) => {
    const shim = new Shim();
    if (url === PUBLIC_RTC_URL) void rtc(shim, r);
    else if (url === PUBLIC_WSS_URL) void wss(shim, { f, socket, log: d.log });
    else queueMicrotask(() => shim.fail(4000, "not a public route"));
    return shim;
  };
}

/**
 * The WebRTC route's sessions, one kept spare: lianki.com's session answer takes a
 * second or more, and a failover race (a dropped route, a worker back) should not wait
 * for it. The spare is fetched only after a session is taken (never on a timer, so an
 * idle page mints no tickets) and used only with SPARE_MIN_LEFT_MS of its ticket left.
 */
function spareSessions(f: FetchLike, now: () => number): () => Promise<PublicSession> {
  let spare: PublicSession | null = null;
  let filling: Promise<void> | null = null;
  const refill = () => {
    if (filling || spare) return;
    filling = fetchSession(f)
      .then((x) => void (spare = x))
      .catch(() => {})
      .finally(() => (filling = null));
  };
  return async () => {
    if (!spare && filling) await filling;
    const x = spare;
    spare = null;
    const s = x && x.exp !== undefined && x.exp * 1000 - now() >= SPARE_MIN_LEFT_MS ? x : await fetchSession(f);
    refill();
    return s;
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

/**
 * The WebRTC route (docs/local-stt.md, "Routes that come and go"). The shim is
 * open from the DataChannel's open until the route is truly gone; in between it
 * rides out what a phone on the move does:
 *
 * - the network changes (online, back in the foreground, ICE `disconnected` for
 *   DISCONNECTED_GRACE_MS, or `failed`): an ICE restart on the same peer
 *   connection, so the channel and the speech server's socket go on; not
 *   connected again within RESTART_TIMEOUT_MS, the shim fails and the mic
 *   replays the utterance in flight on its next route;
 * - the signal socket drops: it resumes the same session (`resume` token,
 *   within RESUME_GRACE_MS), then restarts ICE, since the network changed;
 * - the worker's own registry socket blips (`worker-away` / `worker-back`): the
 *   peer connection carries on; a restart if it is not connected on its return;
 * - no worker free (`wait`): the route fails at once (the cloud meanwhile) and
 *   the signal socket stays as the lobby, which hears `available` when a worker
 *   comes up and tells the page (STT_AVAILABLE_EVENT), so the mic races again.
 */
async function rtc(
  shim: Shim,
  d: {
    f: FetchLike;
    session: () => Promise<PublicSession>;
    peer: NonNullable<PublicDeps["peer"]>;
    socket: NonNullable<PublicDeps["socket"]>;
    origin: () => string;
    log?: PublicDeps["log"];
    events: NonNullable<PublicDeps["events"]>;
    setTimer: NonNullable<PublicDeps["setTimer"]>;
    clearTimer: NonNullable<PublicDeps["clearTimer"]>;
    now: NonNullable<PublicDeps["now"]>;
    available: NonNullable<PublicDeps["available"]>;
  },
) {
  let s: PublicSession;
  try {
    s = await d.session();
  } catch (e) {
    return shim.fail(4001, String((e as Error).message).slice(0, 60));
  }
  if (shim.readyState >= 2) return;
  let pc: PeerLike | null = null;
  let dc: ChannelLike | null = null;
  let sid = "";
  let resume = "";
  /** The signal socket that speaks for this session now (a resume replaces it). */
  let sig: SockLike;
  /** The session is waiting in the lobby: its socket is not ours to close. */
  let lobby = false;
  let restarting = false;
  let resuming = false;
  let droppedAt = 0;
  const timers = new Set<unknown>();
  const later = (f: () => void, ms: number) => {
    const t = d.setTimer(() => {
      timers.delete(t);
      f();
    }, ms);
    timers.add(t);
    return t;
  };
  const cancel = (t: unknown) => {
    if (t === undefined) return;
    timers.delete(t);
    d.clearTimer(t);
  };
  let discTimer: unknown;
  let restartTimer: unknown;
  const unwatch = d.events((why) => {
    if (!pc || shim.readyState !== 1) return;
    // A new network: the old ICE path may look connected for a while yet, so restart now.
    if (why === "online") restart("online");
    else if (pc.connectionState !== "connected") restart("visible");
  });
  shim.cleanup = () => {
    unwatch();
    for (const t of timers) d.clearTimer(t);
    timers.clear();
    try {
      dc?.close();
    } catch {}
    try {
      pc?.close();
    } catch {}
    if (lobby) return;
    try {
      sig.close(1000, "done");
    } catch {}
  };
  const say = (m: unknown) => {
    try {
      sig.send(JSON.stringify(m));
    } catch {}
  };
  const log = (state: string, extra: Record<string, unknown> = {}) =>
    d.log?.({ ev: "stt-rtc", state, ...extra });

  /** An ICE restart: a new offer on the same peer connection, answered by the same worker. */
  const restart = async (why: string) => {
    if (!pc || restarting || shim.readyState !== 1) return;
    if (sig.readyState !== 1) {
      // The signal socket is gone too: resume it first; the restart follows its ready.
      return void resumeSignal();
    }
    restarting = true;
    log("restart", { why });
    cancel(restartTimer);
    restartTimer = later(() => {
      if (pc?.connectionState !== "connected") shim.fail(4012, "restart failed");
    }, RESTART_TIMEOUT_MS);
    try {
      const offer = await pc.createOffer({ iceRestart: true });
      await pc.setLocalDescription(offer);
      say({ t: "offer", sdp: offer.sdp });
    } catch {
      shim.fail(4005, "restart offer");
    }
  };

  /** The same session on a new signal socket (the page's network changed under it). */
  const resumeSignal = () => {
    if (resuming || shim.readyState !== 1) return;
    if (!resume || d.now() - droppedAt > RESUME_GRACE_MS)
      return shim.fail(4011, "signal lost");
    resuming = true;
    log("resume");
    const next = d.socket(`${d.origin()}${s.signal}`, [RESUME_SUBPROTOCOL, `${sid}.${resume}`]);
    wire(next);
    sig = next;
  };

  const wire = (sock: SockLike) => {
    // One message at a time, in order: the worker's ICE right behind its answer
    // must wait for setRemoteDescription, or the browser refuses it.
    let chain: Promise<void> = Promise.resolve();
    sock.onmessage = (e) => {
      chain = chain.then(() => handle(sock, e)).catch(() => {});
    };
    sock.onerror = () => {};
    sock.onclose = (e) => {
      if (sock !== sig) return; // replaced by a resume
      if (lobby) return;
      // Before the channel opened, or with nothing to resume: the route is lost.
      if (shim.readyState !== 1 || !resume) return shim.fail(e.code ?? 4002, e.reason || "signal closed");
      if (resuming) {
        // That resume failed: once more on the next online / visible, or give up in time.
        resuming = false;
        later(() => {
          if (sig === sock && shim.readyState === 1) shim.fail(4011, "signal lost");
        }, Math.max(0, RESUME_GRACE_MS - (d.now() - droppedAt)));
        return;
      }
      droppedAt = d.now();
      log("signal-dropped", { code: e.code });
      resumeSignal();
    };
  };

  const handle = async (sock: SockLike, e: { data: unknown }) => {
    let m: {
      t?: string;
      sdp?: string;
      candidate?: unknown;
      reason?: string;
      sid?: string;
      resume?: string;
      resumed?: boolean;
    };
    try {
      m = JSON.parse(String(e.data));
    } catch {
      return;
    }
    if (m.t === "wait") {
      // No worker free: the cloud now; this socket waits in the lobby for one.
      lobby = true;
      keepLobby(sock, d.available);
      log("lobby");
      return shim.fail(4010, "no worker");
    }
    if (m.t === "ready" && m.resumed && sock === sig) {
      resuming = false;
      if (typeof m.resume === "string") resume = m.resume;
      log("resumed");
      // The network changed under it: restart ICE on the new path.
      return void restart("resumed");
    }
    if (m.t === "ready" && !pc) {
      sid = typeof m.sid === "string" ? m.sid : "";
      resume = typeof m.resume === "string" ? m.resume : "";
      pc = d.peer({ iceServers: s.iceServers });
      dc = pc.createDataChannel("stt", { ordered: true });
      dc.binaryType = "arraybuffer";
      const ch = dc;
      ch.onopen = () =>
        shim.open((x) => (typeof x === "string" ? ch.send(x) : ch.send(x as Uint8Array)));
      ch.onmessage = (ev) => shim.message(ev.data);
      ch.onclose = () => shim.fail(4003, "channel closed");
      pc.onicecandidate = (ev) =>
        say({ t: "ice", candidate: ev.candidate ? ev.candidate.toJSON() : null });
      const p = pc;
      pc.onconnectionstatechange = () => {
        const st = p.connectionState;
        if (st === "connected") {
          if (restarting) log("restarted");
          restarting = false;
          cancel(discTimer);
          cancel(restartTimer);
          discTimer = restartTimer = undefined;
        } else if (st === "disconnected") {
          // Often back by itself within a second; else a restart.
          cancel(discTimer);
          discTimer = later(() => {
            if (p.connectionState === "disconnected") void restart("disconnected");
          }, DISCONNECTED_GRACE_MS);
        } else if (st === "failed") {
          if (restarting || shim.readyState !== 1) shim.fail(4004, "ice failed");
          else void restart("failed");
        }
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
    } else if (m.t === "worker-away") {
      log("worker-away");
    } else if (m.t === "worker-back") {
      log("worker-back");
      if (pc && pc.connectionState !== "connected") void restart("worker-back");
    } else if (m.t === "end") {
      shim.fail(4007, m.reason || "end");
    }
  };

  sig = d.socket(`${d.origin()}${s.signal}?lobby=1`, [V2_SUBPROTOCOL, s.ticket]);
  wire(sig);
}

/** The one lobby socket of this page: a newer one replaces it. */
let lobbySock: SockLike | null = null;
function keepLobby(sock: SockLike, available: () => void) {
  if (lobbySock && lobbySock !== sock)
    try {
      lobbySock.close(1000, "replaced");
    } catch {}
  lobbySock = sock;
  sock.onmessage = (e) => {
    let m: { t?: string } = {};
    try {
      m = JSON.parse(String(e.data));
    } catch {}
    if (m.t !== "available") return;
    if (lobbySock === sock) lobbySock = null;
    try {
      sock.close(1000, "available");
    } catch {}
    available();
  };
  sock.onclose = () => {
    if (lobbySock === sock) lobbySock = null;
  };
}

/** The page's "online" and "visible again" (none outside a browser). */
function pageEvents(f: (why: "online" | "visible") => void): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") return () => {};
  const vis = () => {
    if (document.visibilityState === "visible") f("visible");
  };
  const onl = () => f("online");
  document.addEventListener("visibilitychange", vis);
  window.addEventListener("online", onl);
  return () => {
    document.removeEventListener("visibilitychange", vis);
    window.removeEventListener("online", onl);
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
