/**
 * Li's player: the one way an agent's audio plays on the page
 * (docs/li-sound-hub.md, "Playing audio from an agent"). Every kind of line
 * audio (play-audio.ts: file, stream, and later rtc, gen, webaudio) goes
 * through the same object, so they share the controls (play, pause, stop,
 * progress or live), the page's audio owner (audio-claim.ts: Li's voice
 * pauses it and it waits for Li; it pauses the reader), the mic rule (never
 * over his open mic: a tap with the mic on is refused with the reason, and
 * the mic opening pauses it) and the log.
 *
 * A kind is a **source** (`register(kind, source)`): it turns a line's audio
 * and its resolved URL into a sink. Phase 1 registers `file` and `stream` on
 * the page's one <audio> element; `rtc`, `gen` and `webaudio` slot in later
 * the same way. A kind with no source is refused by name, never silent.
 *
 * One per page on globalThis (`__lkLiPlay`), versioned: the app bundle and a
 * hot-loaded widget share it. Everything the browser gives is injected
 * (LiPlayEnv): unit/li-player.test.ts runs it on fakes and never makes a sound.
 * The player never touches a volume.
 */
import { AUDIO_PRIO, audioOwner, audioOwnerId, type AudioOwner } from "./audio-claim";
import {
  type AutoplayBlock,
  type LineAudio,
  type PlayKind,
  autoplayDecision,
  isHls,
  lineAudioOf,
  srcHost,
} from "./play-audio";
import { isDesktop } from "./voice-bg";

export const LI_PLAY_KEY = "__lkLiPlay";
export const LI_PLAY_V = 1;

export type PlayStatus =
  | "idle"
  | "loading"
  | "playing"
  | "paused"
  /** Another sound holds the page (Li speaking): it goes on when that is done. */
  | "waiting"
  /** The browser wants a tap first: the chip says "tap to play". */
  | "blocked"
  | "error"
  | "ended";

/** Why it stopped or did not start; the chip shows it in words. */
export type PlayWhy = "mic" | "unsupported" | "hls" | "file" | "load" | "locked";

export type PlayView = {
  /** The line playing (or last played); null before anything. */
  id: string | null;
  status: PlayStatus;
  kind?: PlayKind;
  /** Seconds. */
  pos: number;
  /** Seconds; Infinity or NaN for a live stream. */
  dur: number;
  live: boolean;
  why?: PlayWhy;
};

/** The slice of an HTMLAudioElement used here. */
export type MediaElLike = {
  src: string;
  paused: boolean;
  currentTime: number;
  duration: number;
  play(): Promise<void> | void;
  pause(): void;
  load?(): void;
  removeAttribute?(name: string): void;
  canPlayType?(type: string): string;
  addEventListener(t: string, f: () => void): void;
  removeEventListener(t: string, f: () => void): void;
};

/** One playback of one line, made by a source. */
export type PlaySink = {
  /** Resolves once it plays; rejects as the browser does (NotAllowedError: a tap is needed). */
  start(): Promise<void>;
  pause(): void;
  resume(): Promise<void>;
  stop(): void;
  pos(): number;
  dur(): number;
  /** time, duration, ended, error: `f` reads the sink again. */
  onChange(f: (ev: "time" | "ended" | "error") => void): () => void;
};

export type PlaySourceCtx = { el(): MediaElLike };
/** A kind's player: a sink, or why it cannot play this here. */
export type PlaySource = (audio: LineAudio, url: string, ctx: PlaySourceCtx) => PlaySink | { why: PlayWhy };

export type LiPlayEnv = {
  /** The page's one element for line audio (made on first use). */
  el: () => MediaElLike;
  /** `file:<id>` → a short-lived URL for this viewer (POST /api/my/files/<id>/play). */
  resolveFile: (id: string) => Promise<string>;
  /** His mic is open now (chat mic, /vibe), and its changes. */
  micOpen: () => boolean;
  onMic?: (f: () => void) => () => void;
  /** The browser says the page had a user activation (navigator.userActivation.hasBeenActive). */
  activated?: () => boolean;
  /** Where the claims go (the window); null: none. */
  target?: EventTarget | null;
  /** The page log (devLog): every play, by host and kind, never the URL. */
  log?: (ev: Record<string, unknown>) => void;
};

export type PlayOpts = { gesture?: boolean };

export type LiPlayer = {
  v: number;
  view(): PlayView;
  subscribe(f: (v: PlayView) => void): () => void;
  /** Play this line's audio (stopping another). `gesture`: called from a tap. */
  play(id: string, audio: LineAudio, o?: PlayOpts): Promise<PlayView>;
  /** The chip's ▶/⏸: plays, pauses or resumes this line. Always from a tap. */
  toggle(id: string, audio: LineAudio): Promise<PlayView>;
  pause(): void;
  stop(): void;
  /**
   * A line that did not start by itself: its chip shows ▶ with the reason
   * (`mic`: the mic is on; `locked`: a tap plays it). Nothing else playing is touched.
   */
  hold(id: string, audio: LineAudio, why: "mic" | "locked"): void;
  /** In a tap: prime the element so a later line may play without one (iOS). */
  unlock(): void;
  unlocked(): boolean;
  /** His mic is open now (the env's reading): never play over it. */
  micOpen(): boolean;
  /** Where its log lines go (the app's devLog), whoever made the player first. */
  setLog(f: (ev: Record<string, unknown>) => void): void;
  register(kind: PlayKind, source: PlaySource): void;
  retire(): void;
};

const IDLE: PlayView = { id: null, status: "idle", pos: 0, dur: NaN, live: false };

const ignore = () => {};
const isNotAllowed = (e: unknown) =>
  /NotAllowed/.test(String((e as { name?: string })?.name ?? e));

/** 10 ms of silence as a WAV data URL: what unlock() plays in the tap. */
export function silentWav(): string {
  const n = 80;
  const b = new Uint8Array(44 + n * 2);
  const v = new DataView(b.buffer);
  const s = (o: number, t: string) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  s(0, "RIFF");
  v.setUint32(4, 36 + n * 2, true);
  s(8, "WAVEfmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, 8000, true);
  v.setUint32(28, 16000, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  s(36, "data");
  v.setUint32(40, n * 2, true);
  let bin = "";
  for (const x of b) bin += String.fromCharCode(x);
  return `data:audio/wav;base64,${btoa(bin)}`;
}

/** `file` and `stream`: the page's <audio> element. HLS only where the browser plays it itself. */
export const elementSource: PlaySource = (audio, url, ctx) => {
  const el = ctx.el();
  if (isHls(audio)) {
    const can = el.canPlayType?.(audio.mime!) ?? "";
    if (!can) return { why: "hls" };
  }
  const subs = new Set<(ev: "time" | "ended" | "error") => void>();
  const fire = (ev: "time" | "ended" | "error") => () => {
    for (const f of [...subs]) f(ev);
  };
  const on = { timeupdate: fire("time"), durationchange: fire("time"), ended: fire("ended"), error: fire("error") };
  let attached = false;
  const attach = () => {
    if (attached) return;
    attached = true;
    for (const [t, f] of Object.entries(on)) el.addEventListener(t, f);
  };
  const detach = () => {
    if (!attached) return;
    attached = false;
    for (const [t, f] of Object.entries(on)) el.removeEventListener(t, f);
  };
  return {
    async start() {
      attach();
      el.src = url;
      await el.play();
    },
    pause: () => el.pause(),
    async resume() {
      await el.play();
    },
    stop() {
      detach();
      el.pause();
      el.removeAttribute?.("src");
      el.load?.();
    },
    pos: () => el.currentTime || 0,
    dur: () => el.duration,
    onChange(f) {
      subs.add(f);
      return () => void subs.delete(f);
    },
  };
};

export function createLiPlayer(env: LiPlayEnv): LiPlayer {
  const sources = new Map<PlayKind, PlaySource>([
    ["file", elementSource],
    ["stream", elementSource],
  ]);
  const subs = new Set<(v: PlayView) => void>();
  let v: PlayView = IDLE;
  let sink: PlaySink | null = null;
  let offSink: (() => void) | null = null;
  let owner: AudioOwner | null = null;
  let current: { id: string; audio: LineAudio } | null = null;
  let primed = false;
  let retired = false;
  let lastSec = -1;
  /** The sink was started (else a resume after waiting starts it). */
  let started = false;
  /** Each play() bumps it: a late settle of an older one changes nothing. */
  let turn = 0;

  const safe = <T>(f: () => T, d: T): T => {
    try {
      return f();
    } catch {
      return d;
    }
  };
  const emit = (next: Partial<PlayView>) => {
    v = { ...v, ...next };
    if (next.status && next.status !== "error" && next.status !== "paused" && next.status !== "blocked")
      if (!("why" in next)) v = { ...v, why: undefined };
    for (const f of [...subs]) safe(() => f(v), undefined);
  };
  let sinkLog = env.log;
  const log = (ev: Record<string, unknown>) => safe(() => sinkLog?.({ ev: "play", ...ev }), undefined);
  const isLive = (a: LineAudio, dur: number) => a.kind !== "file" || !Number.isFinite(dur);

  const release = () => {
    owner?.release();
    owner = null;
  };
  const drop = () => {
    offSink?.();
    offSink = null;
    safe(() => sink?.stop(), undefined);
    sink = null;
    release();
  };

  function micPause() {
    turn++;
    safe(() => sink?.pause(), undefined);
    release();
    if (current) log({ id: current.id, outcome: "mic" });
    emit({ status: "paused", why: "mic" });
  }

  const onSink = (ev: "time" | "ended" | "error") => {
    if (!sink || !current) return;
    if (ev === "ended") {
      log({ id: current.id, outcome: "ended" });
      const pos = sink.pos();
      drop();
      return emit({ status: "ended", pos });
    }
    if (ev === "error") {
      log({ id: current.id, outcome: "error", host: srcHost(current.audio.src) });
      drop();
      return emit({ status: "error", why: "load" });
    }
    // A mic opened by something this player did not hear (a session made later): pause now.
    if (v.status === "playing" && safe(() => env.micOpen(), false)) return micPause();
    const pos = sink.pos();
    const dur = sink.dur();
    const sec = Math.floor(pos);
    // A progress bar needs about one change a second, not each timeupdate.
    if (sec === lastSec && dur === v.dur) return;
    lastSec = sec;
    emit({ pos, dur, live: isLive(current.audio, dur) });
  };

  /** Start the sink once the page is ours; NotAllowed → blocked (a tap plays it). */
  const go = async (me: number) => {
    const s = sink;
    const c = current;
    if (!s || !c) return v;
    started = true;
    try {
      await s.start();
      // Paused meanwhile (his mic opened): the element must not play on.
      if (me !== turn) {
        if (sink === s && v.status === "paused") safe(() => s.pause(), undefined);
        return v;
      }
      log({ id: c.id, outcome: "playing", host: srcHost(c.audio.src), kind: c.audio.kind });
      emit({ status: "playing", dur: s.dur(), live: isLive(c.audio, s.dur()) });
    } catch (e) {
      if (me !== turn) return v;
      const blocked = isNotAllowed(e);
      log({ id: c.id, outcome: blocked ? "blocked" : "error", host: srcHost(c.audio.src) });
      if (blocked) {
        // Keep the line; a tap on the chip plays it (toggle → play with a gesture).
        drop();
        emit({ status: "blocked", why: "locked" });
      } else {
        drop();
        emit({ status: "error", why: "load" });
      }
    }
    return v;
  };

  /** The page's audio owner for this turn: Li speaking pauses it, and it goes on after. */
  const own = (me: number) =>
    audioOwner({
      id: audioOwnerId("play"),
      prio: AUDIO_PRIO.play,
      target: env.target ?? null,
      // Li speaks (or a newer card): pause here, keep the place.
      onYield: () => {
        if (me !== turn) return;
        safe(() => sink?.pause(), undefined);
        emit({ status: "waiting" });
      },
      // Ours again: start it if it never started, else go on from the place.
      onResume: () => {
        if (me !== turn || !sink) return;
        if (!started) return void go(me);
        sink.resume().then(
          () => me === turn && emit({ status: "playing" }),
          () => me === turn && (drop(), emit({ status: "blocked", why: "locked" })),
        );
      },
    });

  const play = async (id: string, audio: LineAudio, o: PlayOpts = {}): Promise<PlayView> => {
    if (retired) return v;
    const me = ++turn;
    drop();
    current = { id, audio };
    lastSec = -1;
    if (o.gesture) primed = true;
    emit({ id, status: "loading", kind: audio.kind, pos: 0, dur: NaN, live: audio.kind !== "file", why: undefined });
    // Never over his open mic: say why; he turns the mic off and taps again.
    if (safe(() => env.micOpen(), false)) {
      log({ id, outcome: "mic" });
      return (emit({ status: "paused", why: "mic" }), v);
    }
    const source = sources.get(audio.kind);
    if (!source) {
      log({ id, outcome: "unsupported", kind: audio.kind });
      return (emit({ status: "error", why: "unsupported" }), v);
    }
    let url = audio.src;
    if (url.startsWith("file:")) {
      try {
        url = await env.resolveFile(url.slice(5));
      } catch {
        if (me !== turn) return v;
        log({ id, outcome: "file" });
        return (emit({ status: "error", why: "file" }), v);
      }
      if (me !== turn) return v;
    }
    const made = safe(() => source(audio, url, { el: env.el }), { why: "load" as PlayWhy });
    if ("why" in made) {
      log({ id, outcome: made.why, host: srcHost(audio.src) });
      return (emit({ status: "error", why: made.why }), v);
    }
    sink = made;
    offSink = made.onChange(onSink);
    started = false;
    owner = own(me);
    if (!owner.claim()) {
      log({ id, outcome: "waiting" });
      return (emit({ status: "waiting" }), v);
    }
    return go(me);
  };

  const pause = () => {
    if (!sink || v.status !== "playing") return;
    safe(() => sink!.pause(), undefined);
    // Paused by him: the page is free for other sounds until he plays again.
    release();
    emit({ status: "paused" });
  };

  // His mic opening pauses the line (never over the open mic).
  const offMic = safe(
    () =>
      env.onMic?.(() => {
        if (v.status === "playing" || v.status === "loading" || v.status === "waiting")
          if (safe(() => env.micOpen(), false)) micPause();
      }),
    undefined,
  );

  return {
    v: LI_PLAY_V,
    view: () => v,
    subscribe(f) {
      subs.add(f);
      safe(() => f(v), undefined);
      return () => void subs.delete(f);
    },
    play,
    async toggle(id, audio) {
      primed = true;
      if (current?.id === id && sink && started) {
        if (v.status === "playing") return (pause(), v);
        if (v.status === "paused" && !safe(() => env.micOpen(), false)) {
          const me = ++turn;
          owner = own(me);
          if (!owner.claim()) return (emit({ status: "waiting" }), v);
          try {
            await sink.resume();
            if (me === turn) emit({ status: "playing" });
          } catch {
            if (me === turn) (drop(), emit({ status: "blocked", why: "locked" }));
          }
          return v;
        }
      }
      return play(id, audio, { gesture: true });
    },
    pause,
    hold(id, audio, why) {
      // Something already plays: it keeps the chip; this line's ▶ still plays on a tap.
      if (sink && (v.status === "playing" || v.status === "waiting" || v.status === "loading")) return;
      turn++;
      drop();
      current = { id, audio };
      log({ id, outcome: "held", why, host: srcHost(audio.src), kind: audio.kind });
      emit({
        id,
        status: why === "mic" ? "paused" : "blocked",
        why,
        kind: audio.kind,
        pos: 0,
        dur: NaN,
        live: audio.kind !== "file",
      });
    },
    stop() {
      if (current && v.status !== "idle") log({ id: current.id, outcome: "stopped" });
      turn++;
      drop();
      emit({ status: "idle", pos: 0 });
    },
    unlock() {
      if (primed) return;
      primed = true;
      if (sink) return;
      const el = safe(() => env.el(), null);
      if (!el || !el.paused) return;
      el.src = silentWav();
      const me = turn;
      safe(
        () =>
          Promise.resolve(el.play()).then(() => {
            // A line that started meanwhile is not paused by this late settle.
            if (me === turn && !sink) el.pause();
          }, ignore),
        undefined,
      );
    },
    unlocked: () => primed || safe(() => !!env.activated?.(), false),
    micOpen: () => safe(() => env.micOpen(), false),
    setLog(f) {
      sinkLog = f;
    },
    register(kind, source) {
      sources.set(kind, source);
    },
    retire() {
      if (retired) return;
      retired = true;
      turn++;
      drop();
      offMic?.();
      subs.clear();
    },
  };
}

/** The page's player, made once (a newer one kept, an older one retired). */
export function liPlayer(env?: LiPlayEnv): LiPlayer | null {
  const g = globalThis as unknown as Record<string, LiPlayer | undefined>;
  const have = g[LI_PLAY_KEY];
  if (have && (have.v ?? 0) >= LI_PLAY_V) return have;
  const e = env ?? browserPlayEnv();
  if (!e) return null;
  if (have) safe0(() => have.retire());
  const next = createLiPlayer(e);
  g[LI_PLAY_KEY] = next;
  return next;
}

const safe0 = (f: () => void) => {
  try {
    f();
  } catch {}
};

/** mic-session.ts MIC_SESSION_KEY; read here so this module does not load the mic. */
const MIC_SESSION_KEY = "__lkMic";

/** The real page's pieces; null outside a browser. */
export function browserPlayEnv(log?: (ev: Record<string, unknown>) => void): LiPlayEnv | null {
  if (typeof Audio === "undefined" || typeof fetch === "undefined") return null;
  let el: MediaElLike | null = null;
  const g = globalThis as unknown as Record<string, unknown>;
  const mic = () => g[MIC_SESSION_KEY] as
    | { view?: () => { state?: string }; subscribe?: (f: () => void) => () => void }
    | undefined;
  return {
    el: () => (el ??= new Audio() as unknown as MediaElLike),
    async resolveFile(id) {
      const r = await fetch(`/api/my/files/${encodeURIComponent(id)}/play`, {
        method: "POST",
        credentials: "same-origin",
      });
      const j = (await r.json().catch(() => null)) as { url?: unknown } | null;
      if (!r.ok || typeof j?.url !== "string") throw new Error(`play url ${r.status}`);
      return new URL(j.url, location.href).href;
    },
    micOpen: () => {
      const s = mic()?.view?.()?.state;
      const taps = g.__lkMicTaps as { blocked?: () => boolean } | undefined;
      return (!!s && s !== "off") || !!taps?.blocked?.();
    },
    onMic: (f) => mic()?.subscribe?.(f) ?? (() => {}),
    activated: () =>
      !!(navigator as { userActivation?: { hasBeenActive?: boolean } }).userActivation?.hasBeenActive,
    target: typeof window !== "undefined" ? window : null,
    log,
  };
}

/** What autoPlayLine reads from the page; each part can be given (tests: fakes). */
export type AutoPlayPage = {
  player?: LiPlayer | null;
  desktop?: boolean;
  visible?: boolean;
};

/**
 * A live agent line with audio arrived (DebugEval; the flag and the viewer's
 * `dev` already checked): play it by itself only when autoplayDecision says
 * so, else hold it on its chip with the reason. Returns the decision.
 */
export function autoPlayLine(
  m: { id: string; audio?: unknown; quiet?: boolean },
  speakerTab: boolean,
  log?: (ev: Record<string, unknown>) => void,
  page: AutoPlayPage = {},
): { play: true } | { play: false; why: AutoplayBlock } | null {
  const audio = lineAudioOf(m.audio);
  if (!audio) return null;
  const p = page.player !== undefined ? page.player : liPlayer(browserPlayEnv(log) ?? undefined);
  if (!p) return null;
  if (log) p.setLog(log);
  const doc = (globalThis as { document?: { visibilityState?: string } }).document;
  const d = autoplayDecision({
    flag: true,
    fresh: true,
    desktop: page.desktop ?? isDesktop(),
    visible: page.visible ?? doc?.visibilityState === "visible",
    unlocked: p.unlocked(),
    micOpen: p.micOpen(),
    quiet: m.quiet === true,
    speakerTab,
  });
  try {
    log?.({ ev: "play-auto", id: m.id, ...d });
  } catch {}
  if (d.play) void p.play(m.id, audio);
  else p.hold(m.id, audio, d.why === "mic" ? "mic" : "locked");
  return d;
}
