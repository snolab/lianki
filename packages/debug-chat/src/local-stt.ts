/**
 * Streaming speech-to-text on the owner's own Mac (docs/local-stt.md): while
 * he speaks, the mic's frames go over one WebSocket to scripts/local-stt
 * (SenseVoice), which answers partials as he talks and the final text the
 * moment the VAD ends the utterance. Owner pages only, behind
 * localStorage[LOCAL_STT_KEY]: one wss:// URL, or several separated by spaces
 * or commas (the tailnet first, then wss://stt.lianki.com, the tunnel). Any
 * failure — not connected, a dropped socket, an error, no final in time — is
 * a reject, and the mic falls back to /api/debug/stt for that utterance, as
 * before. Nothing here polls: the socket is opened on the first utterance and
 * again on the next one after it closes.
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
  /** Start an utterance; null when the socket isn't open (it is opened for next time). */
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
  const lost = (what: "closed" | "unreachable", code: unknown, where: string) => {
    d.log?.({ ev: "local-stt", state: what, url: where });
    reportPageError({
      kind: "socket",
      message: `local STT socket ${what}${typeof code === "number" ? ` (${code})` : ""}`,
    });
    ready = false;
    speakerModels = undefined;
    setSt("down");
    failAll("local stt closed");
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
    const ms = (spk as { models?: unknown } | undefined)?.models;
    speakerModels = Array.isArray(ms) ? ms.filter((x): x is string => typeof x === "string") : undefined;
    // Which device this is, so its finals are scored against its own voiceprint.
    if (d.device)
      try {
        s.send(JSON.stringify({ t: "hello", device: d.device }));
      } catch {}
    setSt("ready");
    d.log?.({ ev: "local-stt", state: "ready", model, via: hostOf(u) });
  };
  const connect = () => {
    if (ws || race || !urls.length) return;
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
          ws = null;
          lost(ready ? "closed" : "unreachable", (e as { code?: unknown } | undefined)?.code, u);
          return;
        }
        if (r.socks.delete(s)) fail(u, "closed");
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
      if (!live()) {
        connect();
        return null;
      }
      const id = nextId++;
      const p: Pending = { onPartial, began: now() };
      utts.set(id, p);
      send(JSON.stringify(opts?.enrol ? { t: "begin", id, enrol: true } : { t: "begin", id }));
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
                tf !== undefined && Number.isInteger(tf) && tf > 0 ? { t: "end", id, textFrom: tf } : { t: "end", id },
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
    },
  };
}
