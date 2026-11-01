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

import { reportPageError } from "./page-errors";
import { type SpeakerTag, cleanSpeaker } from "./wire";

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
/** A socket that lived this long before closing was good: the backoff starts over. */
export const STABLE_MS = 10_000;
/** The subprotocol the tunnel listener selects (scripts/local-stt/ticket.py). */
export const STT_SUBPROTOCOL = "lianki-stt";
/** Where an owner page gets a ticket for the tunnel (app/api/dev/stt-ticket). */
export const STT_TICKET_PATH = "/api/dev/stt-ticket";

const TAG_FRAME = 1;
const TAG_PRE = 2;

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

function oneUrl(raw: string): string | undefined {
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
export function localSttFrom(raw: string | null | undefined): string | undefined {
  const urls = (raw ?? "")
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(oneUrl)
    .filter((u): u is string => !!u);
  const uniq = [...new Set(urls)];
  return uniq.length ? uniq.join(" ") : undefined;
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
  /** On an enrolment sentence: whether it was kept, and why not. */
  enrol?: EnrolSentence;
};

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

/** `enrol`: an enrolment sentence (its final carries `enrol`, never `speaker`). */
export type BeginOpts = { enrol?: boolean };

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
  request(msg: Record<string, unknown>): Promise<Record<string, unknown>>;
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
  onPartial: (t: string) => void;
  resolve?: (f: LocalFinal) => void;
  reject?: (e: Error) => void;
  endAt?: number;
  began: number;
  firstPartialMs?: number;
  timer?: unknown;
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
    d.visible ?? (() => typeof document === "undefined" || document.visibilityState !== "hidden");
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

  const failAll = (why: string) => {
    for (const [id, p] of utts) {
      clearTimer(p.timer);
      p.reject?.(new Error(why));
      utts.delete(id);
    }
    const held = [...waiting];
    waiting.clear();
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
      return new URL(u).host;
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
    enrol?: unknown;
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
    const p = m.id === undefined ? undefined : utts.get(m.id);
    if (!p) return;
    if (m.t === "partial" && typeof m.text === "string" && !p.resolve) {
      p.firstPartialMs ??= Math.round(now() - p.began);
      p.onPartial(m.text);
    } else if (m.t === "partial" && typeof m.text === "string") {
      // Already ended: only the final counts now.
    } else if (m.t === "final" && p.resolve) {
      clearTimer(p.timer);
      utts.delete(m.id as number);
      const speaker = cleanSpeaker(m.speaker);
      const enrol = enrolOf(m.enrol);
      p.resolve({
        text: m.text ?? "",
        model: `local:${m.model ?? "?"}`,
        lang: m.lang,
        ms: m.ms ?? 0,
        endToFinalMs: Math.round(now() - (p.endAt ?? now())),
        firstPartialMs: p.firstPartialMs,
        ...(speaker ? { speaker } : {}),
        ...(enrol ? { enrol } : {}),
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
    failAll(what === "closed" ? "local stt closed" : "local stt unreachable");
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
        s.send(JSON.stringify({ t: "hello", device: d.device }));
      } catch {}
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
      }, CONNECT_TIMEOUT_MS),
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
  /**
   * Begun while the socket is down: the frames wait here while it opens
   * (connect's deadline bounds that), then go out as one burst behind the
   * begin, and an end() that came first is sent right after. If opening
   * fails, end() rejects (the cloud takes the utterance).
   */
  const hold = (onPartial: (t: string) => void, began: number, opts?: BeginOpts): LocalUtt => {
    let held: Float32Array[] | null = [];
    let inner: LocalUtt | null = null;
    let ending: {
      audio: Float32Array;
      eo?: { textFrom?: number };
      ok: (f: LocalFinal) => void;
      ko: (e: Error) => void;
    } | null = null;
    let lostWhy = "local stt closed";
    const w: Waiter = {
      go() {
        if (!held) return; // cancelled meanwhile
        const frames = held;
        held = null;
        inner = stream(onPartial, began, opts);
        for (const f of frames) inner.frame(f);
        d.log?.({
          ev: "local-stt",
          state: "held-streamed",
          heldMs: Math.round(now() - began),
          frames: frames.length,
          ended: !!ending,
        });
        const e = ending;
        ending = null;
        if (e) inner.end(e.audio, e.eo).then(e.ok, e.ko);
      },
      fail(why) {
        held = null;
        lostWhy = why;
        const e = ending;
        ending = null;
        e?.ko(new Error(why));
      },
    };
    waiting.add(w);
    connect();
    return {
      frame(f) {
        if (inner) return inner.frame(f);
        if (held && !ending) held.push(f);
      },
      end(audio, eo) {
        if (inner) return inner.end(audio, eo);
        if (!held || ending) return Promise.reject(new Error(lostWhy));
        return new Promise<LocalFinal>((ok, ko) => void (ending = { audio, eo, ok, ko }));
      },
      cancel() {
        if (inner) return inner.cancel();
        if (!held || ending) return;
        held = null;
        waiting.delete(w);
      },
    };
  };
  /** An utterance on the open socket (the steady path). */
  const stream = (onPartial: (t: string) => void, began = now(), opts?: BeginOpts): LocalUtt => {
    const id = nextId++;
    const p: Pending = { onPartial, began };
    utts.set(id, p);
    const enrol = opts?.enrol;
    send(JSON.stringify(enrol ? { t: "begin", id, enrol } : { t: "begin", id }));
    let streamed = 0;
    let over = false;
    return {
      frame(f) {
        if (over || !live()) return;
        streamed += f.length;
        send(packPcm(TAG_FRAME, f));
      },
      end(audio, eo) {
        over = true;
        return new Promise<LocalFinal>((resolve, reject) => {
          if (!live() || !utts.has(id)) {
            utts.delete(id);
            return reject(new Error("local stt not connected"));
          }
          p.resolve = resolve;
          p.reject = reject;
          // The VAD's pre-pad: the head of its audio that came before the first frame.
          const head = audio.length - streamed;
          if (head > 0) send(packPcm(TAG_PRE, audio.subarray(0, head)));
          p.endAt = now();
          const tf = eo?.textFrom;
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
            reject(new Error("local stt timed out"));
          }, FINAL_TIMEOUT_MS);
        });
      },
      cancel() {
        if (over) return;
        over = true;
        utts.delete(id);
        if (live()) send(JSON.stringify({ t: "cancel", id }));
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
    async request(msg) {
      const deadline = now() + REQUEST_TIMEOUT_MS;
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
      if (live()) return stream(onPartial, now(), opts);
      if (!urls.length) return null;
      // Down: hold this utterance while the socket opens, instead of losing it to the cloud.
      return hold(onPartial, now(), opts);
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
