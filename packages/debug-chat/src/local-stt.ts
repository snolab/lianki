/**
 * Streaming speech-to-text on the owner's own Mac (docs/local-stt.md): while
 * he speaks, the mic's frames go over one WebSocket to scripts/local-stt
 * (SenseVoice), which answers partials as he talks and the final text the
 * moment the VAD ends the utterance. Owner pages only, behind
 * localStorage[LOCAL_STT_KEY]: one wss:// URL, or several separated by spaces
 * or commas (the tailnet first, then wss://stt.lianki.com, the tunnel). Any
 * failure — not reachable, a dropped socket, an error, no final in time — is
 * a reject, and the mic falls back to /api/debug/stt for that utterance, as
 * before.
 *
 * An utterance that starts while the socket is down is held, not lost: its
 * frames are buffered while the socket opens (bounded by CONNECT_TIMEOUT_MS,
 * the race's deadline) and streamed the moment it is ready; only if opening
 * fails does it go to the cloud. With the socket up, begin() streams at once,
 * exactly as before.
 *
 * Nothing here polls. While the mic is on (`keep(true)`) the socket is
 * reopened at once when it closes, when the page becomes visible again and
 * when the browser comes back online — events only, with a backoff after
 * failures (one deferred attempt per event, never a retry loop). Every close
 * that was not ours is logged with the browser's own code and reason
 * (`local-stt-close`): iOS sends no close frame, so the server sees nothing.
 *
 * With several URLs, opening is a race (happy eyeballs): the first URL at
 * once, each next one RACE_STAGGER_MS later (or at once when the one before
 * it has already failed); the first to say `ready` is kept and the others are
 * closed. A tunnel URL (TICKET_HOSTS: wss://stt.lianki.com) needs a ticket
 * from /api/dev/stt-ticket, offered as a subprotocol beside "lianki-stt"
 * (lib/stt-ticket.ts); it is fetched when the race starts, fresh each time.
 */

import type { SttSignals } from "./stt-guard";
import { reportPageError } from "./page-errors";
import { type SpeakerTag, cleanSpeaker } from "./wire";
import { isDesktop, sttMayReopen } from "./voice-bg";
import { isPublicRoute } from "./public-stt";

/** localStorage: the local STT server's WebSocket URL(s) (owner pages only). */
export const LOCAL_STT_KEY = "lk:debug-local-stt";
/** No final within this long after the end: fall back. */
export const FINAL_TIMEOUT_MS = 4_000;
/** Connecting takes longer than this: this utterance goes the old way. */
export const CONNECT_TIMEOUT_MS = 2_500;
/** The next URL in the race starts this long after the one before it. */
export const RACE_STAGGER_MS = 150;
/** After a failed open (or a socket that dropped within STABLE_MS), the next event-driven attempt waits this, doubling… */
export const BACKOFF_BASE_MS = 1_000;
/** …up to this. */
export const BACKOFF_MAX_MS = 30_000;
/**
 * An utterance whose route dropped after its end() waits this long for the next route
 * to replay it on; then the cloud takes it (docs/local-stt.md, "Routes that come and go").
 */
export const REPLAY_WAIT_MS = 1_500;
/** A socket that lived this long before closing was good: the backoff starts over. */
export const STABLE_MS = 10_000;
/** The subprotocol the tunnel listener selects (scripts/local-stt/ticket.py). */
export const STT_SUBPROTOCOL = "lianki-stt";
/** Where an owner page gets a ticket for the tunnel (app/api/dev/stt-ticket). */
export const STT_TICKET_PATH = "/api/dev/stt-ticket";

const TAG_FRAME = 1;
const TAG_PRE = 2;

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

function oneUrl(raw: string, named = false): string | undefined {
  // Lianki's speech servers by name (rtc:lianki, wss:session): the chat mic's list may mix
  // them with his sockets (docs/local-stt.md, "His own Mac over WebRTC"); they are not URLs.
  if (named && isPublicRoute(raw)) return raw;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return undefined;
  }
  const local = LOCAL_HOSTS.includes(u.hostname);
  if (u.protocol !== "wss:" && !(u.protocol === "ws:" && local)) return undefined;
  return u.href;
}

/**
 * The URL(s) from localStorage the owner's page may use (wss, or ws on
 * localhost), in order, joined by one space; undefined when none is.
 */
export function localSttFrom(raw: string | null | undefined, named = false): string | undefined {
  const urls = (raw ?? "")
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((u) => oneUrl(u, named))
    .filter((u): u is string => !!u);
  const uniq = [...new Set(urls)];
  return uniq.length ? uniq.join(" ") : undefined;
}

/**
 * The owner's routes when his page has stored none (docs/local-stt.md, "On by
 * default for the owner"): his Mac on the tailnet first, then the tunnel.
 * Either failing is the usual race; both failing is the cloud, per utterance.
 */
export const OWNER_DEFAULT_LOCAL_STT = "wss://taku.onca-tint.ts.net/lianki-stt wss://stt.lianki.com";

/** A stored value that turns the local route off on this origin (the default included). */
export const LOCAL_STT_OFF = "off";

/** Where the page's local STT route came from: a stored value, the owner default, an explicit off, or nothing. */
export type LocalSttSource = "stored" | "owner-default" | "off" | "none";

/**
 * The route(s) a page uses. A stored value always wins — `off` (or one with
 * no usable URL) is off, even for the owner. With nothing stored, only the
 * owner's page (`owner`: the hub's verified owner session, never a friend or
 * another user) gets OWNER_DEFAULT_LOCAL_STT.
 */
export function localSttRoute(
  stored: string | null | undefined,
  owner: boolean,
  named = false,
): { urls?: string; source: LocalSttSource } {
  if (stored != null) {
    const urls = stored.trim().toLowerCase() === LOCAL_STT_OFF ? undefined : localSttFrom(stored, named);
    return urls ? { urls, source: "stored" } : { source: "off" };
  }
  if (owner) return { urls: localSttFrom(OWNER_DEFAULT_LOCAL_STT), source: "owner-default" };
  return { source: "none" };
}

/**
 * The tunnel's hosts. Only these are sent a ticket: a ticket is good for the
 * tunnel, so it must never go to any other host a localStorage value names.
 */
export const TICKET_HOSTS = ["stt.lianki.com"];

/** A tunnel URL (wss on TICKET_HOSTS) needs a ticket; the tailnet and localhost do not. */
export function needsTicket(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "wss:" && TICKET_HOSTS.includes(u.hostname);
  } catch {
    return false;
  }
}

/** A ticket from lianki.com for the tunnel (owner session; 404 for anyone else). */
export async function fetchSttTicket(f: typeof fetch = fetch): Promise<string> {
  const res = await f(STT_TICKET_PATH, { method: "POST", credentials: "same-origin" });
  if (!res.ok) throw new Error(`stt ticket: HTTP ${res.status}`);
  const { ticket } = (await res.json()) as { ticket?: unknown };
  if (typeof ticket !== "string" || !ticket) throw new Error("stt ticket: none");
  return ticket;
}

/** 16-bit little-endian PCM behind a one-byte tag. */
export function packPcm(tag: number, samples: Float32Array): Uint8Array {
  const out = new Uint8Array(1 + samples.length * 2);
  out[0] = tag;
  const v = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(1 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return out;
}

/**
 * The Mac's signals, only numbers and the decoder's kind passed on. A server
 * older than this sends none: it only ever ran SenseVoice by default, ctc.
 */
export function localSignals(raw: unknown): SttSignals {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const logprob = num(r.logprob);
  return {
    decoder: r.decoder === "whisper" ? "whisper" : "ctc",
    ...(logprob !== undefined ? { logprob } : {}),
  };
}

/** The final's `filtered`, as far as it can be trusted to be one. */
const filterOf = (x: unknown): FilterVerdict | undefined => {
  const f = x as { reason?: unknown; score?: unknown } | null | undefined;
  if (!f || typeof f.reason !== "string") return undefined;
  return { reason: f.reason, ...(typeof f.score === "number" ? { score: f.score } : {}) };
};

export type LocalFinal = {
  text: string;
  model: string;
  lang?: string;
  /** Decode time on the Mac. */
  ms: number;
  /** End of speech (the `end` sent) → final here, round trip included. */
  endToFinalMs: number;
  /** Utterance start → first partial shown, if any. */
  firstPartialMs?: number;
  /** The Mac's speaker check against the owner's voiceprint (docs/local-stt.md, "Voiceprint"). */
  speaker?: SpeakerTag;
  /**
   * The Mac's signature over that tag and this final's text (lib/speaker-proof.ts):
   * the page passes it on with the line, and only the hub's check makes a tag count.
   */
  proof?: string;
  /** On an enrolment sentence: whether it was kept, and why not. */
  enrol?: EnrolSentence;
  /** The decoder and its confidence, for the silence guard (stt-guard.ts). */
  signals?: SttSignals;
  /**
   * The voiceprint filter stopped it on the Mac: the text is empty, nothing was
   * decoded, and it must not go to the cloud or the clip sink either.
   */
  filtered?: FilterVerdict;
  /** The filter is not on; this is what it would have stopped (a count, the line still lands). */
  wouldFilter?: string;
};

/** Why the Mac's voiceprint filter stopped a final (scripts/local-stt/voiceprint.py filter_reason). */
export type FilterVerdict = { reason: string; score?: number };

/** The server's verdict on one enrolment sentence (scripts/local-stt/voiceprint.py Enrolment.add). */
export type EnrolSentence = {
  ok: boolean;
  /** Sentences kept so far. */
  n: number;
  /** "short" | "noise" | "mismatch" | "full" | "no-enrolment". */
  reason?: string;
};

/** One utterance being streamed. */
export type LocalUtt = {
  frame(f: Float32Array): void;
  /**
   * The whole utterance as the VAD cut it (its head, before the first frame,
   * is sent as pre-pad). `textFrom`: decode the text from this sample on (the
   * words after "Linky"), while the speaker check hears all of it.
   */
  end(audio: Float32Array, opts?: { textFrom?: number }): Promise<LocalFinal>;
  cancel(): void;
};

/** `enrol`: an enrolment sentence of that open enrolment (its final carries `enrol`, never `speaker`). */
export type BeginOpts = { enrol?: string };

/** 16 random bytes, base64url: an utterance's id for its speaker proof. */
export function utteranceId(): string {
  let s = "";
  for (const b of crypto.getRandomValues(new Uint8Array(16))) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** How long a voiceprint request (status, enrol, delete) may take, connecting included. */
export const REQUEST_TIMEOUT_MS = 6_000;

/** The socket, for the mic's indicator: connecting, connected (ready), or not reachable. */
export type LocalState = "idle" | "connecting" | "ready" | "down";

export type LocalStt = {
  /**
   * Start an utterance. With the socket up it streams at once; with it down
   * it is held (frames buffered) while the socket opens, then streamed, and
   * its end() rejects if opening fails. Null only with no URL at all.
   */
  begin(onPartial: (text: string) => void, opts?: BeginOpts): LocalUtt | null;
  /**
   * A voiceprint request ({t:"enrol"|"voiceprint", op, …}): opens the socket
   * if needed, and resolves with the server's answer to it (matched by a
   * request id). Rejects when the Mac cannot be reached in time.
   */
  request(
    msg: Record<string, unknown>,
    /** A longer wait for a big answer (the kept recordings): default REQUEST_TIMEOUT_MS. */
    o?: { timeoutMs?: number },
  ): Promise<Record<string, unknown>>;
  /** The server's speaker-check models from its `ready` (undefined: no check there, or not connected). */
  speaker(): string[] | undefined;
  /** Open the socket now (on mic on), so the first utterance can stream. */
  warm(): void;
  /**
   * While the mic is on (true): open now, and reopen on close, on the page
   * becoming visible and on coming online, with backoff. False stops that.
   */
  keep(on: boolean): void;
  close(): void;
  connected(): boolean;
  state(): LocalState;
  /** Called on every state change; returns an unsubscribe. */
  subscribe(f: (s: LocalState) => void): () => void;
};

/** The slice of WebSocket used (a fake in the tests). */
export type WsLike = {
  readyState: number;
  binaryType: string;
  send(d: string | Uint8Array): void;
  close(): void;
  onopen: ((e: unknown) => void) | null;
  onclose: ((e: unknown) => void) | null;
  onerror: ((e: unknown) => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
};

type Pending = {
  /** The utterance this socket id carries (replayed on the next socket when this one drops). */
  rec?: Rec;
  onPartial: (t: string) => void;
  resolve?: (f: LocalFinal) => void;
  reject?: (e: Error) => void;
  endAt?: number;
  began: number;
  firstPartialMs?: number;
  timer?: unknown;
};
/**
 * One utterance, whatever socket carries it: its frames (packed, as sent), and its end
 * once given. A socket that drops while the mic is on does not lose it: it is replayed,
 * begin to end, on the next route that says ready (docs/local-stt.md, "Routes that come
 * and go"); only when no route comes back does its end() reject, and the cloud takes it.
 */
type Rec = {
  onPartial: (t: string) => void;
  began: number;
  opts?: BeginOpts;
  /** Every frame so far, packed (TAG_FRAME): sent live, and again on a replay. */
  frames: Uint8Array[];
  streamed: number;
  ending: {
    audio: Float32Array;
    eo?: { textFrom?: number };
    ok: (f: LocalFinal) => void;
    ko: (e: Error) => void;
  } | null;
  /** Its id on the socket in use; null while it waits for one. */
  id: number | null;
  /** Settled, cancelled or failed: nothing more is sent or awaited. */
  over: boolean;
  lostWhy: string;
  /** Waiting for a socket: its place in `waiting`. */
  waiter: { go(): void; fail(why: string): void } | null;
  /** Was it on a socket before (a replay), or held from its begin. */
  attached: boolean;
  firstPartialMs?: number;
  replayTimer?: unknown;
};


export function createLocalStt(
  url: string | string[],
  d: {
    open?: (url: string, protocols?: string[]) => WsLike;
    /** A fresh ticket for a tunnel URL (default: POST /api/dev/stt-ticket). */
    ticket?: () => Promise<string>;
    now?: () => number;
    setTimer?: (f: () => void, ms: number) => unknown;
    clearTimer?: (t: unknown) => void;
    log?: (ev: Record<string, unknown>) => void;
    /** Subscribe to the page's "visible again" and "online" events; returns an unsubscribe. */
    watch?: (f: (why: "visible" | "online") => void) => () => void;
    /** Whether the page is visible (a hidden page waits for visibilitychange). */
    visible?: () => boolean;
    /** This device's slug ("iphone"), sent as {t:"hello"} so finals are scored against its print. */
    device?: string;
    /**
     * The hub thread this page's lines go to ("owner"), sent in the hello: the
     * Mac signs it, with a fresh id per utterance, into each speaker proof.
     */
    thread?: string;
    /**
     * The voiceprint filter on this socket (docs/local-stt.md, "Only my voice"):
     * asked when it opens and at each utterance, and told to the Mac when it
     * changes. Not given, or failing: no filter, exactly as without one.
     */
    filter?: () => boolean | Promise<boolean>;
    /**
     * How long the race may take (default CONNECT_TIMEOUT_MS). Lianki's speech
     * servers for other accounts (public-stt.ts) give WebRTC longer: a session,
     * signalling and ICE come before `ready`.
     */
    connectTimeoutMs?: number;
  } = {},
): LocalStt {
  const urls = (Array.isArray(url) ? url : url.split(/[\s,]+/)).filter(Boolean);
  const open =
    d.open ?? ((u, protocols) => new WebSocket(u, protocols) as unknown as WsLike);
  const getTicket = d.ticket ?? (() => fetchSttTicket());
  const now = d.now ?? (() => performance.now());
  const setTimer = d.setTimer ?? ((f, ms) => setTimeout(f, ms));
  const clearTimer = d.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  const watch = d.watch ?? watchPage;
  const visible =
    d.visible ??
    (() =>
      typeof document === "undefined" ||
      // A computer reopens in a background tab too: the mic listens on there (voice-bg.ts).
      sttMayReopen({ visible: document.visibilityState !== "hidden", desktop: isDesktop() }));
  /** The socket in use: the race's winner. */
  let ws: WsLike | null = null;
  let ready = false;
  let nextId = 1;
  /** Opening, while no URL has said ready yet. */
  type Race = {
    socks: Map<WsLike, string>;
    started: number;
    failed: number;
    timers: unknown[];
    over: boolean;
  };
  let race: Race | null = null;
  const utts = new Map<number, Pending>();
  /** Utterances begun while the socket was down: streamed on ready, failed if opening fails. */
  type Waiter = { go(): void; fail(why: string): void };
  const waiting = new Set<Waiter>();
  /** Reopening while the mic is on (keep): the events, the backoff, its one deferred attempt. */
  let kept = false;
  let unwatch: (() => void) | null = null;
  let fails = 0;
  let lastFail = 0;
  let wonAt = 0;
  let retry: unknown = null;
  /** Voiceprint requests waiting for their answer, by rid. */
  const reqs = new Map<string, { resolve: (m: Record<string, unknown>) => void; reject: (e: Error) => void; timer: unknown }>();
  let nextRid = 1;
  let speakerModels: string[] | undefined;
  let st: LocalState = "idle";
  const subs = new Set<(s: LocalState) => void>();
  const setSt = (s: LocalState) => {
    if (s === st) return;
    st = s;
    for (const f of subs) f(s);
  };

  const failAll = (why: string, replay = false) => {
    // Those already waiting fail; those detached below wait for the next route.
    const held = [...waiting];
    waiting.clear();
    for (const [id, p] of utts) {
      clearTimer(p.timer);
      utts.delete(id);
      // The route dropped while the mic is on: replayed on the next one, not lost.
      if (replay && kept && p.rec && !p.rec.over) detach(p.rec);
      else p.reject?.(new Error(why));
    }
    for (const w of held) w.fail(why);
    // A request sent on this socket has no answer coming.
    for (const [rid, r] of reqs) {
      clearTimer(r.timer);
      r.reject(new Error(why));
      reqs.delete(rid);
    }
  };
  const hostOf = (u: string) => {
    try {
      // A route with no host (public-stt.ts: rtc:lianki) is named as it is.
      return new URL(u).host || u;
    } catch {
      return "?";
    }
  };
  type Msg = {
    t?: string;
    id?: number;
    rid?: unknown;
    text?: string;
    model?: string;
    lang?: string;
    ms?: number;
    error?: string;
    speaker?: unknown;
    speakerProof?: unknown;
    filtered?: unknown;
    wouldFilter?: unknown;
    on?: unknown;
    enrol?: unknown;
    signals?: unknown;
  };
  const enrolOf = (raw: unknown): EnrolSentence | undefined => {
    if (!raw || typeof raw !== "object") return undefined;
    const r = raw as Record<string, unknown>;
    return {
      ok: r.ok === true,
      n: typeof r.n === "number" && Number.isFinite(r.n) ? r.n : 0,
      ...(typeof r.reason === "string" ? { reason: r.reason.slice(0, 40) } : {}),
    };
  };
  const parse = (e: { data: unknown }): Msg | undefined => {
    if (typeof e.data !== "string") return undefined;
    try {
      return JSON.parse(e.data) as Msg;
    } catch {
      return undefined;
    }
  };
  /** The winner's messages: partials, finals and errors of the utterances. */
  const onMsg = (m: Msg) => {
    if ((m.t === "enrol" || m.t === "voiceprint") && typeof m.rid === "string") {
      const r = reqs.get(m.rid);
      if (!r) return;
      reqs.delete(m.rid);
      clearTimer(r.timer);
      return r.resolve(m as Record<string, unknown>);
    }
    if (m.t === "filter") return void d.log?.({ ev: "voice-filter", on: m.on });
    const p = m.id === undefined ? undefined : utts.get(m.id);
    if (!p) return;
    if (m.t === "partial" && typeof m.text === "string" && !p.resolve) {
      p.firstPartialMs ??= Math.round(now() - p.began);
      if (p.rec) p.rec.firstPartialMs ??= p.firstPartialMs;
      p.onPartial(m.text);
    } else if (m.t === "partial" && typeof m.text === "string") {
      // Already ended: only the final counts now.
    } else if (m.t === "final" && p.resolve) {
      clearTimer(p.timer);
      utts.delete(m.id as number);
      const speaker = cleanSpeaker(m.speaker);
      const enrol = enrolOf(m.enrol);
      const filtered = filterOf(m.filtered);
      p.resolve({
        text: m.text ?? "",
        model: `local:${m.model ?? "?"}`,
        lang: m.lang,
        ms: m.ms ?? 0,
        endToFinalMs: Math.round(now() - (p.endAt ?? now())),
        firstPartialMs: p.firstPartialMs,
        ...(speaker ? { speaker } : {}),
        ...(speaker && typeof m.speakerProof === "string" && m.speakerProof.length <= 6000
          ? { proof: m.speakerProof }
          : {}),
        ...(enrol ? { enrol } : {}),
        signals: localSignals(m.signals),
        ...(filtered ? { filtered } : {}),
        ...(typeof m.wouldFilter === "string" ? { wouldFilter: m.wouldFilter } : {}),
      });
    } else if (m.t === "error") {
      clearTimer(p.timer);
      utts.delete(m.id as number);
      p.reject?.(new Error(m.error ?? "local stt error"));
    }
  };
  /** Not closed by us: the agent hears it (page-errors.ts; owner pages only). */
  const lost = (
    what: "closed" | "unreachable",
    code: unknown,
    where: string,
    reason?: string,
  ) => {
    d.log?.({ ev: "local-stt", state: what, url: where });
    const why = typeof code === "number" ? ` (${code}${reason ? ` ${reason}` : ""})` : "";
    reportPageError({ kind: "socket", message: `local STT socket ${what}${why}` });
    ready = false;
    speakerModels = undefined;
    setSt("down");
    failAll(what === "closed" ? "local stt closed" : "local stt unreachable", what === "closed");
  };
  /** A failed open, or a socket that dropped soon after ready: the next attempt backs off. */
  const failed = () => {
    fails++;
    lastFail = now();
  };
  /** Reopen while the mic is on: at once, or once the backoff since the last failure is over. */
  const reconnect = (why: string) => {
    if (!kept || live() || race || !visible()) return;
    const wait = fails
      ? Math.min(BACKOFF_BASE_MS * 2 ** (fails - 1), BACKOFF_MAX_MS) - (now() - lastFail)
      : 0;
    if (wait > 0) {
      // One deferred attempt for this event; a failure schedules nothing more.
      if (retry === null)
        retry = setTimer(() => {
          retry = null;
          reconnect(why);
        }, wait);
      return;
    }
    d.log?.({ ev: "local-stt", state: "reconnect", why, fails });
    connect();
  };
  /** The browser's own close event (iOS sends no close frame, so only the page knows). */
  const closeInfo = (e: unknown) => {
    const c = (e ?? {}) as { code?: unknown; reason?: unknown; wasClean?: unknown };
    return {
      code: typeof c.code === "number" ? c.code : undefined,
      reason: typeof c.reason === "string" ? c.reason.slice(0, 100) : "",
      wasClean: typeof c.wasClean === "boolean" ? c.wasClean : undefined,
    };
  };
  const endRace = (r: Race) => {
    r.over = true;
    for (const t of r.timers) clearTimer(t);
    const socks = [...r.socks.keys()];
    r.socks.clear(); // their onclose is no longer ours to handle
    if (race === r) race = null;
    return socks;
  };
  const win = (r: Race, s: WsLike, u: string, model?: string, spk?: unknown) => {
    for (const o of endRace(r)) if (o !== s) o.close();
    ws = s;
    ready = true;
    wonAt = now();
    const ms = (spk as { models?: unknown } | undefined)?.models;
    speakerModels = Array.isArray(ms) ? ms.filter((x): x is string => typeof x === "string") : undefined;
    // Which device this is, so its finals are scored against its own voiceprint.
    if (d.device)
      try {
        s.send(
          JSON.stringify({ t: "hello", device: d.device, ...(d.thread ? { thread: d.thread } : {}) }),
        );
      } catch {}
    filterSent = false; // a new socket starts with the filter off
    syncFilter();
    setSt("ready");
    d.log?.({ ev: "local-stt", state: "ready", model, via: hostOf(u) });
    const go = [...waiting];
    waiting.clear();
    for (const w of go) w.go();
  };
  const connect = () => {
    if (ws && ws.readyState > 1) {
      // Closing or closed, its onclose not here yet (a page back from suspend): open anew.
      d.log?.({ ev: "local-stt", state: "stale", readyState: ws.readyState });
      ws = null;
      ready = false;
    }
    if (ws || race || !urls.length) return;
    if (retry !== null) {
      clearTimer(retry);
      retry = null;
    }
    const r: Race = { socks: new Map(), started: 0, failed: 0, timers: [], over: false };
    race = r;
    setSt("connecting");
    // One ticket per race, asked for at once, so it is there by the time its URL starts.
    let tk: Promise<string> | undefined;
    if (urls.some(needsTicket)) {
      tk = getTicket();
      tk.catch(() => {}); // each tunnel URL handles its own failure
    }
    const fail = (u: string, why: string) => {
      if (r.over) return;
      r.failed++;
      d.log?.({ ev: "local-stt", state: "lost-race", via: hostOf(u), why });
      if (r.failed >= urls.length) {
        endRace(r);
        failed();
        lost("unreachable", undefined, urls.join(" "));
      } else start(); // happy eyeballs: a failure starts the next one now
    };
    const launch = (u: string, protocols?: string[]) => {
      if (r.over) return;
      let s: WsLike;
      try {
        s = open(u, protocols);
      } catch (e) {
        d.log?.({ ev: "local-stt", state: "error", error: String(e).slice(0, 100) });
        return fail(u, "open");
      }
      r.socks.set(s, u);
      s.binaryType = "arraybuffer";
      s.onopen = () => {};
      s.onerror = () => {};
      s.onmessage = (e) => {
        const m = parse(e);
        if (!m) return;
        if (ws === s) return onMsg(m);
        if (m.t === "ready" && r.socks.has(s) && !r.over)
          win(r, s, u, m.model, (m as { speaker?: unknown }).speaker);
      };
      s.onclose = (e) => {
        if (ws === s) {
          const c = closeInfo(e);
          const livedMs = Math.round(now() - wonAt);
          d.log?.({ ev: "local-stt-close", ...c, via: hostOf(u), livedMs });
          ws = null;
          if (livedMs < STABLE_MS) failed();
          else fails = 0;
          lost(ready ? "closed" : "unreachable", c.code, u, c.reason);
          reconnect("close");
          return;
        }
        if (r.socks.has(s)) {
          d.log?.({ ev: "local-stt-close", ...closeInfo(e), via: hostOf(u), phase: "race" });
          r.socks.delete(s);
          fail(u, "closed");
        }
      };
    };
    const start = () => {
      if (r.over || r.started >= urls.length) return;
      const u = urls[r.started++];
      if (r.started < urls.length) r.timers.push(setTimer(start, RACE_STAGGER_MS));
      if (!needsTicket(u)) return launch(u);
      if (!tk) return fail(u, "ticket");
      tk.then(
        (t) => launch(u, [STT_SUBPROTOCOL, t]),
        () => fail(u, "ticket"),
      );
    };
    r.timers.push(
      setTimer(() => {
        if (r.over) return;
        for (const o of endRace(r)) o.close();
        failed();
        lost("unreachable", undefined, urls.join(" "));
      }, d.connectTimeoutMs ?? CONNECT_TIMEOUT_MS),
    );
    start();
  };
  const live = () => !!ws && ready && ws.readyState === 1;
  const send = (x: string | Uint8Array) => {
    try {
      ws?.send(x);
      return true;
    } catch {
      return false;
    }
  };

  const keep = (on: boolean) => {
    kept = on;
    if (on) {
      unwatch ??= watch((why) => reconnect(why));
      connect();
      return;
    }
    unwatch?.();
    unwatch = null;
    if (retry !== null) clearTimer(retry);
    retry = null;
  };
  /** What the Mac was last told about the filter on this socket. */
  let filterSent = false;
  /** Ask whether the filter should be on, and tell the Mac when that changed; off on any failure. */
  const syncFilter = () => {
    if (!d.filter) return;
    void Promise.resolve()
      .then(d.filter)
      .catch(() => false)
      .then((on) => {
        if (on === filterSent || !live()) return;
        filterSent = on;
        send(JSON.stringify({ t: "filter", on }));
      });
  };
  /**
   * Put an utterance on the socket in use: begin, every frame so far, and its end if
   * it was given (a held utterance, or a replay after a route dropped).
   */
  const attach = (rec: Rec) => {
    const id = nextId++;
    const p: Pending = {
      rec,
      onPartial: rec.onPartial,
      began: rec.began,
      firstPartialMs: rec.firstPartialMs,
    };
    utts.set(id, p);
    rec.id = id;
    syncFilter();
    const enrol = rec.opts?.enrol;
    // A fresh id per utterance when the page says who it is: signed into its speaker proof.
    const uid = d.device ? utteranceId() : undefined;
    send(JSON.stringify({ t: "begin", id, ...(enrol ? { enrol } : {}), ...(uid ? { uid } : {}) }));
    for (const f of rec.frames) send(f);
    if (rec.ending) sendEnd(rec, id, p);
  };
  /** The end on the socket: the pre-pad, `end`, and the final's timeout. */
  const sendEnd = (rec: Rec, id: number, p: Pending) => {
    const e = rec.ending!;
    p.resolve = (f) => {
      rec.over = true;
      e.ok(f);
    };
    p.reject = (err) => {
      rec.over = true;
      e.ko(err);
    };
    // The VAD's pre-pad: the head of its audio that came before the first frame.
    const head = e.audio.length - rec.streamed;
    if (head > 0) send(packPcm(TAG_PRE, e.audio.subarray(0, head)));
    p.endAt = now();
    const tf = e.eo?.textFrom;
    send(
      JSON.stringify(
        tf !== undefined && Number.isInteger(tf) && tf > 0
          ? { t: "end", id, textFrom: tf }
          : { t: "end", id },
      ),
    );
    p.timer = setTimer(() => {
      if (!utts.has(id)) return;
      utts.delete(id);
      p.reject?.(new Error("local stt timed out"));
    }, FINAL_TIMEOUT_MS);
  };
  /** The utterance waits for a socket: streamed (replayed) on ready, failed if none comes. */
  const detach = (rec: Rec) => {
    const replay = rec.attached;
    rec.id = null;
    const w: Waiter = {
      go() {
        if (rec.over || rec.waiter !== w) return;
        rec.waiter = null;
        clearTimer(rec.replayTimer);
        d.log?.({
          ev: "local-stt",
          state: replay ? "replayed" : "held-streamed",
          heldMs: Math.round(now() - rec.began),
          frames: rec.frames.length,
          ended: !!rec.ending,
        });
        rec.attached = true;
        attach(rec);
      },
      fail(why) {
        if (rec.waiter !== w) return;
        rec.waiter = null;
        clearTimer(rec.replayTimer);
        rec.lostWhy = why;
        if (!rec.ending) return; // its end() rejects at once now
        rec.over = true;
        rec.ending.ko(new Error(why));
      },
    };
    rec.waiter = w;
    waiting.add(w);
    if (!replay) return;
    if (rec.ending) waitReplay(rec);
    // Speech in flight: the next route now, past any backoff (a new utterance does the same).
    queueMicrotask(connect);
  };
  /** An ended utterance waits REPLAY_WAIT_MS for the next route, then goes to the cloud. */
  const waitReplay = (rec: Rec) => {
    clearTimer(rec.replayTimer);
    rec.replayTimer = setTimer(() => {
      const w = rec.waiter;
      if (!w) return;
      waiting.delete(w);
      d.log?.({ ev: "local-stt", state: "replay-timeout", heldMs: Math.round(now() - rec.began) });
      w.fail("local stt closed");
    }, REPLAY_WAIT_MS);
  };
  /** An utterance: on the socket now if it is up, else held while it opens. */
  const utterance = (
    onPartial: (t: string) => void,
    began: number,
    opts?: BeginOpts,
  ): LocalUtt => {
    const rec: Rec = {
      onPartial,
      began,
      opts,
      frames: [],
      streamed: 0,
      ending: null,
      id: null,
      over: false,
      lostWhy: "local stt closed",
      waiter: null,
      attached: false,
    };
    if (live()) {
      rec.attached = true;
      attach(rec);
    } else {
      detach(rec);
      connect();
    }
    return {
      frame(f) {
        if (rec.over || rec.ending) return;
        if (!rec.waiter && rec.id === null) return; // failed while held: the cloud has it
        // Kept packed: sent live, and again on a replay.
        const x = packPcm(TAG_FRAME, f);
        rec.frames.push(x);
        rec.streamed += f.length;
        if (rec.id !== null && live()) send(x);
      },
      end(audio, eo) {
        if (rec.over || rec.ending) return Promise.reject(new Error(rec.lostWhy));
        if (rec.id === null && !rec.waiter) {
          rec.over = true;
          return Promise.reject(new Error(rec.lostWhy));
        }
        return new Promise<LocalFinal>((ok, ko) => {
          rec.ending = { audio, eo, ok, ko };
          if (rec.waiter) {
            // Waiting for a socket: a replay waits a little for the next route; a held
            // one, for its race (whose deadline bounds it).
            if (rec.attached) {
              if (!race && !live()) return rec.waiter.fail("local stt closed");
              waitReplay(rec);
            }
            return;
          }
          const id = rec.id!;
          const p = utts.get(id);
          if (!live() || !p) {
            utts.delete(id);
            rec.over = true;
            return ko(new Error("local stt not connected"));
          }
          sendEnd(rec, id, p);
        });
      },
      cancel() {
        if (rec.over) return;
        if (rec.ending && rec.id !== null) return; // ended: its final is on the way
        rec.over = true;
        clearTimer(rec.replayTimer);
        if (rec.waiter) {
          waiting.delete(rec.waiter);
          rec.waiter = null;
          return;
        }
        if (rec.id !== null) {
          utts.delete(rec.id);
          if (live()) send(JSON.stringify({ t: "cancel", id: rec.id }));
        }
      },
    };
  };
  /** Resolves once the socket is ready (opening it), rejects at the deadline or when every route failed. */
  const whenReady = (deadline: number) =>
    new Promise<void>((resolve, reject) => {
      if (live()) return resolve();
      let off = () => {};
      const t = setTimer(() => {
        off();
        reject(new Error("local stt not connected"));
      }, Math.max(0, deadline - now()));
      off = (() => {
        const f = (s: LocalState) => {
          if (s === "ready" && live()) {
            subs.delete(f);
            clearTimer(t);
            resolve();
          } else if (s === "down") {
            subs.delete(f);
            clearTimer(t);
            reject(new Error("local stt unreachable"));
          }
        };
        subs.add(f);
        return () => void subs.delete(f);
      })();
      connect();
    });

  return {
    connected: live,
    state: () => st,
    speaker: () => (live() ? speakerModels : undefined),
    subscribe(f) {
      subs.add(f);
      return () => void subs.delete(f);
    },
    warm: connect,
    keep,
    async request(msg, o) {
      const deadline = now() + (o?.timeoutMs ?? REQUEST_TIMEOUT_MS);
      await whenReady(deadline);
      const rid = `r${nextRid++}`;
      return new Promise((resolve, reject) => {
        const timer = setTimer(() => {
          reqs.delete(rid);
          reject(new Error("local stt: no answer"));
        }, Math.max(0, deadline - now()));
        reqs.set(rid, { resolve, reject, timer });
        if (!send(JSON.stringify({ ...msg, rid }))) {
          reqs.delete(rid);
          clearTimer(timer);
          reject(new Error("local stt: send failed"));
        }
      });
    },
    close() {
      keep(false);
      const s = ws;
      ws = null;
      ready = false;
      speakerModels = undefined;
      setSt("idle");
      if (race) for (const o of endRace(race)) o.close();
      s?.close();
      failAll("local stt closed");
    },
    begin(onPartial, opts) {
      if (!urls.length) return null;
      // Down: held while the socket opens, instead of losing it to the cloud.
      return utterance(onPartial, now(), opts);
    },
  };
}

/** The page's "visible again" and "online" events (none outside a browser). */
function watchPage(f: (why: "visible" | "online") => void): () => void {
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
