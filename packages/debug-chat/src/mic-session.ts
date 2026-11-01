/**
 * The mic as one page-wide session, outside the swappable widget: the
 * stream, the VAD (createMic, mic.ts), the transcripts on their way, and the
 * voice session's hooks. It lives on globalThis (MIC_SESSION_KEY), so a
 * hot-swapped widget, a React remount or a client-side route change finds it
 * still listening and re-attaches; unmounting never stops it — only an
 * explicit "mic off" does. One getUserMedia per capture: a live stream is
 * reused.
 *
 * On a real reload the session is new. If this tab had the mic on
 * (sessionStorage MIC_ON_KEY, per tab, surviving a refresh), it tries to
 * resume at once: with the microphone permission granted (or the query not
 * supported, as on iOS) and the AudioContext running, it turns capture back
 * on without a gesture ({ev: "mic-resume", path: "auto", ok: true}).
 * Otherwise the button waits in a "tap to resume" state
 * ({ev: "mic-resume", path: "tap", reason}).
 *
 * Everything that touches the browser is injected (MicDeps), so this is
 * unit-tested with fakes.
 */
import type { MicAdapt } from "./mic";
import type { UttMarks } from "./latency";
import {
  type MicState,
  type StreamStt,
  type UploadInfo,
  type Vad,
  type VadEvents,
  createMic,
} from "./mic";
import type { LocalFinal, LocalState } from "./local-stt";
import type { SpeakerTag } from "./wire";
import type { KwsState } from "./wake-kws";
import { type WakeCommand, type WakeMode, type WakeReason, type WakeSpot, createWake } from "./wake";

/** What the session needs of a local STT client (local-stt.ts LocalStt). */
export type LocalClient = StreamStt & {
  close(): void;
  state(): LocalState;
  subscribe(f: (s: LocalState) => void): () => void;
  /** A voiceprint request (local-stt.ts request); absent on an older client. */
  request?(msg: Record<string, unknown>): Promise<Record<string, unknown>>;
};

/** globalThis key of the session. */
export const MIC_SESSION_KEY = "__lkMic";
/** Bumped when the session's shape changes; an older one is migrated, its stream kept. */
export const MIC_SESSION_V = 8;
/** sessionStorage: "1" while this tab has the mic on (cleared by an explicit off). */
export const MIC_ON_KEY = "lk:agent:mic";

/** The slice of a MediaStream the session uses. */
export type StreamLike = {
  id: string;
  getTracks(): { readyState: string; stop(): void }[];
};
export type MicView = {
  state: MicState;
  /** Transcripts still out, and the dimmed partial text. */
  pending: number;
  interim: string;
  /** The last error's note for the button (cleared on the next tap). */
  error: unknown;
  /** Reloaded with the mic on, but it could not resume by itself: one tap does. */
  resume: boolean;
  /** The local streaming STT's socket, when one is configured (the button's dot). */
  local?: LocalState;
  /** Active: everything goes to STT. Passive: only "Linky" wakes it (wake.ts). */
  wake: WakeMode;
  /** The on-device spotter, once passive mode first asked for it (wake-kws.ts). */
  kws?: Exclude<KwsState, "idle">;
};
export type MicConfig = {
  clipSink?: string;
  label: string;
  /** The owner's local streaming STT (local-stt.ts), a ws(s) URL. */
  localStt?: string;
};
export type MicDeps = {
  /** The room and voice estimator (adaptive.ts): the endpoint follows it. */
  adapt?: MicAdapt;
  /** getUserMedia with the session's constraints. */
  getStream: () => Promise<StreamLike>;
  /** The VAD on a stream (Silero), and the fallback (an energy gate). Neither stops the stream. */
  load: (ev: VadEvents, stream: StreamLike) => Promise<Vad>;
  fallback?: (ev: VadEvents, stream: StreamLike) => Promise<Vad>;
  upload: (wav: Uint8Array, info: UploadInfo, cfg: MicConfig) => Promise<string>;
  /** The voice session's side of a state change (voice.ts: setMic, userSpeech, …). */
  onState?: (s: MicState, prev: MicState) => void;
  onProb?: (p: number) => void;
  /** Subscribe to "hold capture" (the agent speaking, AEC off); returns an unsubscribe. */
  subscribeHold?: (f: (hold: boolean) => void) => () => void;
  /** sessionStorage, guarded (iOS private mode throws). */
  storage?: { get(k: string): string | null; set(k: string, v: string): void; remove(k: string): void };
  /** navigator.permissions' microphone state, or "unknown" where it can't be asked. */
  permission?: () => Promise<"granted" | "denied" | "prompt" | "unknown">;
  /** Try to get the AudioContext running without a gesture; false if it stays suspended. */
  resumeAudio?: () => Promise<boolean>;
  log?: (ev: Record<string, unknown>) => void;
  /** A client for the local streaming STT at this URL (local-stt.ts createLocalStt). */
  localStt?: (url: string) => LocalClient;
  /** Each kept final's speaker tag (voiceprint.ts noteSpeaker). */
  speaker?: (tag: SpeakerTag | undefined) => void;
  /** A final utterance's timestamps (createMic's `timing`; latency.ts). */
  timing?: (seq: number, marks: UttMarks) => void;
  /**
   * The on-device "Linky" spotter (wake-kws.ts createKws), made on first use:
   * the first time the mic goes passive. Without it the mic never goes passive.
   */
  kws?: (onState: (s: KwsState) => void) => {
    load(): Promise<void>;
    spot(audio: Float32Array): Promise<WakeSpot & { ms?: number; error?: string }>;
  };
};

type Listener = (v: MicView) => void;
type Sink = { onText: (t: string) => void; onPending: (n: number, interim: string) => void };

export type MicSession = ReturnType<typeof createMicSession>;

const live = (s: StreamLike | null) =>
  !!s && s.getTracks().length > 0 && s.getTracks().every((t) => t.readyState === "live");

export function createMicSession(
  deps: MicDeps,
  from?: { stream: StreamLike | null; on: boolean },
) {
  let stream: StreamLike | null = from?.stream ?? null;
  let view: MicView = {
    state: "off",
    pending: 0,
    interim: "",
    error: null,
    resume: false,
    wake: "active",
  };
  let cfg: MicConfig = { label: "" };
  const listeners = new Set<Listener>();
  let sink: Sink | null = null;
  /** Transcripts that landed while no widget was attached (mid-swap): handed over on attach. */
  let held: string[] = [];
  let gumCalls = 0;
  const emit = (patch: Partial<MicView>) => {
    view = { ...view, ...patch };
    for (const f of listeners) f(view);
  };
  const store = {
    on: () => {
      try {
        deps.storage?.set(MIC_ON_KEY, "1");
      } catch {}
    },
    clear: () => {
      try {
        deps.storage?.remove(MIC_ON_KEY);
      } catch {}
    },
    get: () => {
      try {
        return deps.storage?.get(MIC_ON_KEY) === "1";
      } catch {
        return false;
      }
    },
  };
  /** The live stream, or a new one (the only getUserMedia). */
  const ensureStream = async () => {
    if (live(stream)) return stream as StreamLike;
    gumCalls++;
    stream = await deps.getStream();
    return stream;
  };
  const stopStream = () => {
    for (const t of stream?.getTracks() ?? []) t.stop();
    stream = null;
  };
  let prev: MicState = "off";
  /** The local STT client for cfg.localStt; replaced when the URL changes. */
  let local: { url: string; c: LocalClient; off: () => void } | null = null;
  const localStream = (): StreamStt | undefined => {
    const url = cfg.localStt;
    if (local && local.url !== url) {
      local.off();
      local.c.close();
      local = null;
      emit({ local: undefined });
    }
    if (!url || !deps.localStt) return undefined;
    if (!local) {
      const c = deps.localStt(url);
      local = { url, c, off: c.subscribe((s) => emit({ local: s })) };
      emit({ local: c.state() });
    }
    return local.c;
  };
  /** The spotter, made the first time the mic goes passive. */
  let kws: ReturnType<NonNullable<MicDeps["kws"]>> | null = null;
  const spotter = () => {
    if (!kws && deps.kws)
      kws = deps.kws((s) => {
        emit({ kws: s === "idle" ? undefined : s });
        // Never deaf: a spotter that cannot load puts the mic back in active mode.
        if ((s === "failed" || s === "needs-wifi") && wake.mode() === "passive")
          wake.set("active", "kws-failed");
      });
    return kws;
  };
  const wake = createWake({
    onChange: (v, from, reason) => {
      emit({ wake: v.mode });
      deps.log?.({ ev: "wake", from, to: v.mode, reason });
      if (v.mode === "passive") void spotter()?.load().catch(() => {});
    },
  });
  /** Set the mode (the agent, a tap); "ignored": the agent says the last line was not for it. */
  const command = (c: WakeCommand, reason: WakeReason = "agent") => {
    if (c === "ignored") return void wake.reject();
    if (c === "passive" && !deps.kws) return;
    wake.set(c, reason);
  };
  /** The enrolment card's hook while it records (voiceprint.ts), and whether it turned the mic on. */
  let enrolHook: ((f: Promise<LocalFinal> | null) => void) | null = null;
  let enrolOpened = false;
  const mic = createMic({
    stream: localStream,
    enrol: {
      active: () => !!enrolHook,
      begin: (cb) => localStream()?.begin(cb, { enrol: true }) ?? null,
      done: (f) => enrolHook?.(f),
    },
    adapt: deps.adapt,
    wake: deps.kws
      ? {
          // In whisper mode it stays active: the spotter is unproven on whispers.
          passive: () => wake.mode() === "passive" && !deps.adapt?.state().whisper,
          spot: async (audio) => {
            const k = spotter();
            return k ? k.spot(audio) : { hit: false };
          },
          onWake: () => void wake.set("active", "wake-word"),
          verdict: (ok) => void (ok ? wake.accept() : wake.reject()),
        }
      : undefined,
    load: async (ev) => deps.load(ev, await ensureStream()),
    fallback: deps.fallback ? async (ev) => deps.fallback!(ev, await ensureStream()) : undefined,
    upload: (wav, info) => deps.upload(wav, info, cfg),
    onState: (s) => {
      const was = prev;
      prev = s;
      // Listening always starts active: a tap on means "I'm talking to you".
      if (was === "off" && s !== "off") wake.set("active", "mic-on");
      emit({ state: s, ...(s !== "off" ? { resume: false } : {}) });
      deps.onState?.(s, was);
    },
    onText: (t) => (sink ? sink.onText(t) : void held.push(t)),
    onPending: (n, interim) => {
      emit({ pending: n, interim });
      sink?.onPending(n, interim);
    },
    onError: (e) => emit({ error: e }),
    onProb: (p) => deps.onProb?.(p),
    log: (ev) => deps.log?.(ev),
    timing: (seq, m) => deps.timing?.(seq, m),
    speaker: (t) => deps.speaker?.(t),
  });
  const unhold = deps.subscribeHold?.((h) => mic.hold(h));

  const session = {
    v: MIC_SESSION_V,
    view: () => view,
    stream: () => stream,
    /** How many times this session asked for the microphone. */
    gumCalls: () => gumCalls,
    subscribe(f: Listener) {
      listeners.add(f);
      f(view);
      return () => void listeners.delete(f);
    },
    /** The mounted widget takes the transcripts; detaching never stops the mic. */
    attach(s: Sink) {
      sink = s;
      const t = held;
      held = [];
      for (const x of t) s.onText(x);
      s.onPending(view.pending, view.interim);
      return () => {
        if (sink === s) sink = null;
      };
    },
    configure(c: MicConfig) {
      cfg = c;
      localStream(); // a changed or removed URL takes effect (and shows) at once
      if (mic.state() !== "off") local?.c.warm?.();
    },
    /** Active or passive (wake.ts); the chat lane's {type: "wake"} and the tests. */
    wake: (c: WakeCommand, reason?: WakeReason) => command(c, reason),
    /** A tap: on (remembered for a reload), back to active from passive, or an explicit off. */
    async toggle() {
      emit({ error: null });
      if (mic.state() !== "off" && wake.mode() === "passive") return void wake.set("active", "tap");
      if (mic.state() === "off") {
        store.on();
        await mic.toggle();
      } else await session.off();
    },
    /** The explicit off: the VAD, the stream and the reload flag all go. */
    async off() {
      store.clear();
      emit({ resume: false });
      await mic.off();
      stopStream();
    },
    hold: (on: boolean) => mic.hold(on),
    /**
     * Enrolment (voiceprint.ts): on, every utterance goes to `onFinal` as an
     * enrolment sentence (to the Mac only), turning the mic on if it was off
     * (the consent tap is the gesture); off, back to the chat, and the mic off
     * again if enrolment turned it on.
     */
    async enrolCapture(on: boolean, onFinal: (f: Promise<LocalFinal> | null) => void) {
      if (!on) {
        enrolHook = null;
        if (enrolOpened && mic.state() !== "off") await session.off();
        enrolOpened = false;
        return;
      }
      enrolHook = onFinal;
      if (mic.state() === "off") {
        enrolOpened = true;
        emit({ error: null });
        await mic.toggle();
        if (mic.state() === "off") {
          // Refused or unavailable: nothing to enrol with.
          enrolHook = null;
          enrolOpened = false;
          throw new Error("microphone not available");
        }
      }
    },
    /** Enrolling now: the button shows it, and the chat's draft gets nothing. */
    enrolling: () => !!enrolHook,
    /** A voiceprint request to the Mac (status, enrol, delete); rejects without a local STT. */
    voiceprint(msg: Record<string, unknown>) {
      const c = localStream() as LocalClient | undefined;
      if (!c?.request) return Promise.reject(new Error("no local speech model"));
      return c.request(msg);
    },
    /**
     * Replaced by a newer session: the VAD goes, the stream stays (the new
     * session builds its VAD on it).
     */
    async retire() {
      unhold?.();
      listeners.clear();
      sink = null;
      const s = stream;
      stream = null; // so the off below can't stop it
      await mic.off();
      // The new session opens its own socket to the local STT.
      local?.off();
      local?.c.close();
      local = null;
      return s;
    },
    /** After a reload with the mic on: resume without a gesture if we may, else wait for a tap. */
    async autoResume() {
      if (!store.get()) return;
      const tap = (reason: string) => {
        emit({ resume: true });
        deps.log?.({ ev: "mic-resume", path: "tap", reason });
      };
      let perm: string = "unknown";
      try {
        perm = (await deps.permission?.()) ?? "unknown";
      } catch {}
      if (perm !== "granted" && perm !== "unknown") return tap(`permission ${perm}`);
      let audio = true;
      try {
        audio = (await deps.resumeAudio?.()) ?? true;
      } catch {
        audio = false;
      }
      if (!audio) return tap("audio context suspended");
      await mic.toggle();
      if (mic.state() === "off") {
        const e = view.error as { name?: string; message?: string } | null;
        return tap(e?.name || e?.message || "capture did not start");
      }
      deps.log?.({ ev: "mic-resume", path: "auto", ok: true, permission: perm });
    },
  };
  if (from?.on) void mic.toggle();
  return session;
}

/**
 * The page's mic session, made once: a widget that mounts later (a hot swap,
 * a remount) gets the same one. An older version is retired and its stream
 * handed to the new session, which resumes listening if it was.
 */
export function micSession(deps: MicDeps): MicSession {
  const g = globalThis as unknown as Record<string, MicSession | undefined>;
  const have = g[MIC_SESSION_KEY];
  if (have && have.v === MIC_SESSION_V) return have;
  if (have) {
    // Migrate: the old VAD goes, its stream stays and the new one listens on it.
    const on = (have.view?.().state ?? "off") !== "off";
    const kept = have.stream?.() ?? null;
    void have.retire?.();
    const next = createMicSession(deps, { stream: kept, on });
    g[MIC_SESSION_KEY] = next;
    return next;
  }
  const s = createMicSession(deps);
  g[MIC_SESSION_KEY] = s;
  // A fresh page: if this tab had the mic on, try to pick it up again.
  queueMicrotask(() => void s.autoResume());
  return s;
}
