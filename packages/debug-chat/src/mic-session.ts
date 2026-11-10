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
  keepStream,
} from "./mic";
import type { FilterVerdict, LocalFinal, LocalState } from "./local-stt";
import type { SttGuardLimits } from "./stt-guard";
import type { SpeakerTag } from "./wire";
import type { KwsState } from "./wake-kws";
import { type SpotResult, type WakeCommand, type WakeMode, type WakeReason, createWake } from "./wake";
import { micTaps } from "./mic-taps";

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
/**
 * Bumped when the session's shape changes; an older one is migrated, its
 * stream kept. A newer one is left alone (an older bundle never downgrades
 * it). 10: it offers finals to the command taps first (mic-taps.ts). 11:
 * reopen (the echo cancellation switch, aec.ts applyAec). 12: the voice cues
 * (cues.ts), and the guard over what the VAD hears while one plays. 13: the
 * silence guard (stt-guard.ts) over each final, and the route's signals for it.
 */
export const MIC_SESSION_V = 13;
/** sessionStorage: "1" while this tab has the mic on (cleared by an explicit off). */
export const MIC_ON_KEY = "lk:agent:mic";

/** Shown by the button when a tap finds another listener owns the room. */
export const MIC_BLOCKED_NOTE = "in use by a conversation";

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
  /** Why it is in that mode (its last change), sent with each chat line for the agents. */
  wakeReason?: WakeReason;
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
  /** The start and end cues (cues.ts; createMic's `cue`). */
  cue?: { guard(): boolean; edge(edge: "start" | "end"): void };
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
  /** Overrides of the silence guard (createMic's `guard`), for tests. */
  guard?: Partial<SttGuardLimits>;
  /** A client for the local streaming STT at this URL (local-stt.ts createLocalStt). */
  localStt?: (url: string) => LocalClient;
  /** Each kept final's speaker tag and the Mac's signed proof of it (voiceprint.ts noteSpeaker). */
  speaker?: (tag: SpeakerTag | undefined, proof?: string) => void;
  /** A passive utterance the Mac's voiceprint filter stopped (voiceprint.ts noteFiltered). */
  filtered?: (v: FilterVerdict) => void;
  /** A final utterance's timestamps (createMic's `timing`; latency.ts). */
  timing?: (seq: number, marks: UttMarks) => void;
  /**
   * The on-device "Linky" spotter (wake-kws.ts createKws), made on first use:
   * the first time the mic goes passive. Without it the mic never goes passive.
   */
  kws?: (onState: (s: KwsState) => void) => {
    load(): Promise<void>;
    spot(audio: Float32Array): Promise<SpotResult>;
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
    wakeReason: "mic-on",
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
  /** Bumped by every explicit off: a reopen or an open under way does not turn the mic back on. */
  let offs = 0;
  const ensureStream = async () => {
    if (live(stream)) return stream as StreamLike;
    gumCalls++;
    const at = offs;
    const s = await deps.getStream();
    // (or the mic is off by now: a fallback VAD asking for it after the off).
    if (at !== offs || mic.state() === "off") {
      // Turned off while the browser opened it: never left running (the VAD built on it is dropped).
      for (const t of s.getTracks()) t.stop();
      return s;
    }
    stream = s;
    return stream;
  };
  const stopStream = () => {
    for (const t of stream?.getTracks() ?? []) t.stop();
    stream = null;
  };
  let prev: MicState = "off";
  /** reopen() under way: its own off is not shown (the mic is coming straight back). */
  let reopening = false;
  let reopenRun: Promise<boolean> | null = null;
  let reopenAgain = false;
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
  /** The command taps and pins (mic-taps.ts), shared by every session on the page. */
  const taps = micTaps();
  const wake = createWake({
    onChange: (v, from, reason) => {
      emit({ wake: v.mode, wakeReason: v.reason });
      deps.log?.({ ev: "wake", from, to: v.mode, reason });
      if (v.mode === "passive") void spotter()?.load().catch(() => {});
    },
  });
  /** Set the mode (the agent, a tap); "ignored": the agent says the last line was not for it. */
  const command = (c: WakeCommand, reason: WakeReason = "agent") => {
    // Pinned (a voice mode is on, mic-taps.ts): it stays active.
    if (taps.pinned() && c !== "active") return;
    if (c === "ignored") return void wake.reject();
    if (c === "passive" && !deps.kws) return;
    wake.set(c, reason);
  };
  /** The enrolment card's hook while it records (voiceprint.ts), and whether it turned the mic on. */
  let enrolHook: ((f: Promise<LocalFinal> | null) => void) | null = null;
  /** The open enrolment's id on the Mac (its start answer). */
  let enrolId = "";
  let enrolOpened = false;
  const mic = createMic({
    stream: localStream,
    enrol: {
      active: () => !!enrolHook,
      begin: (cb) => localStream()?.begin(cb, { enrol: enrolId }) ?? null,
      done: (f) => enrolHook?.(f),
    },
    adapt: deps.adapt,
    cue: deps.cue,
    wake: deps.kws
      ? {
          // In whisper mode it stays active: the spotter is unproven on whispers.
          passive: () =>
            wake.mode() === "passive" && !taps.pinned() && !deps.adapt?.state().whisper,
          spot: async (audio) => {
            const k = spotter();
            return k ? k.spot(audio) : { hit: false };
          },
          onWake: () => void wake.set("active", "wake-word"),
          // Pinned: what is said is for the voice mode, so it never counts towards passive.
          verdict: (ok) => void (ok ? wake.accept() : taps.pinned() ? undefined : wake.reject()),
        }
      : undefined,
    load: async (ev) => deps.load(ev, await ensureStream()),
    fallback: deps.fallback ? async (ev) => deps.fallback!(ev, await ensureStream()) : undefined,
    upload: (wav, info) => deps.upload(wav, info, cfg),
    onState: (s) => {
      const was = prev;
      if (reopening && s === "off") {
        // Not shown, but speech under way has ended: the voice session hears it (unduck, read on).
        if (was === "capturing") deps.onState?.("listening", "capturing");
        prev = "listening";
        return;
      }
      prev = s;
      // Listening always starts active: a tap on means "I'm talking to you".
      if (was === "off" && s !== "off") wake.set("active", "mic-on");
      emit({ state: s, wakeReason: wake.view().reason, ...(s !== "off" ? { resume: false } : {}) });
      deps.onState?.(s, was);
    },
    // A command tap (mic-taps.ts) may keep it; the rest goes to the chat as before.
    onText: (t) => {
      if (taps.offer(t)) return;
      if (sink) sink.onText(t);
      else held.push(t);
    },
    onPending: (n, interim) => {
      emit({ pending: n, interim });
      sink?.onPending(n, interim);
    },
    onError: (e) => emit({ error: e }),
    onProb: (p) => deps.onProb?.(p),
    log: (ev) => deps.log?.(ev),
    guard: deps.guard,
    timing: (seq, m) => deps.timing?.(seq, m),
    speaker: (t, p) => deps.speaker?.(t, p),
    filtered: (v) => deps.filtered?.(v),
  });
  const unhold = deps.subscribeHold?.((h) => mic.hold(h));
  // A voice mode turning on wakes the mic: commands need no "Linky".
  const unpin = taps.onPin(() => {
    if (wake.mode() !== "active") wake.set("active", "voice-mode");
  });

  // /vibe owns the room (mic-taps.ts block): this mic goes off and stays off.
  const unblock = taps.onBlock?.(() => {
    if (mic.state() !== "off") void session.off();
  });

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
    /** The config in force (a voice mode adds its local STT URL without dropping the widget's). */
    configured: (): MicConfig => cfg,
    configure(c: MicConfig) {
      cfg = c;
      localStream(); // a changed or removed URL takes effect (and shows) at once
      if (mic.state() !== "off") keepStream(local?.c, true);
    },
    /** Active or passive (wake.ts); the chat lane's {type: "wake"} and the tests. */
    wake: (c: WakeCommand, reason?: WakeReason) => command(c, reason),
    /** A tap: on (remembered for a reload), back to active from passive, or an explicit off. */
    async toggle() {
      if (taps.blocked?.()) return void emit({ error: new Error(MIC_BLOCKED_NOTE) });
      emit({ error: null });
      if (mic.state() !== "off" && wake.mode() === "passive") return void wake.set("active", "tap");
      if (mic.state() === "off") {
        store.on();
        await mic.toggle();
      } else await session.off();
    },
    /** The explicit off: the VAD, the stream and the reload flag all go. */
    async off() {
      offs++;
      store.clear();
      emit({ resume: false });
      await mic.off();
      stopStream();
    },
    hold: (on: boolean) => mic.hold(on),
    /**
     * Open the mic again with the constraints in force now (aec.ts applyAec:
     * the echo cancellation switch, heard at once). Only when it is on; the
     * off in between is not shown, and the reload flag stays. False: it was
     * off, or could not come back (the error shows as for a tap).
     */
    reopen(): Promise<boolean> {
      // One at a time: a toggle during a reopen asks for one more pass after it.
      if (reopenRun) {
        reopenAgain = true;
        return reopenRun;
      }
      if (mic.state() === "off") return Promise.resolve(false);
      const run = async () => {
        let ok = false;
        do {
          reopenAgain = false;
          const was = view.state;
          const offsAt = offs;
          reopening = true;
          try {
            await mic.off();
            stopStream();
          } finally {
            reopening = false;
          }
          if (offsAt !== offs) {
            // An explicit off came meanwhile: it stays off, and now shows it.
            emit({ state: "off" });
            deps.onState?.("off", was);
            return false;
          }
          // Shown as off only if it fails to come back.
          await mic.toggle();
          ok = mic.state() !== "off";
          deps.log?.({ ev: "mic-reopen", ok });
        } while (ok && reopenAgain);
        return ok;
      };
      reopenRun = run().finally(() => {
        reopenRun = null;
      });
      return reopenRun;
    },
    /**
     * Enrolment (voiceprint.ts): on, every utterance goes to `onFinal` as an
     * enrolment sentence (to the Mac only), turning the mic on if it was off
     * (the consent tap is the gesture); off, back to the chat, and the mic off
     * again if enrolment turned it on.
     */
    async enrolCapture(
      on: boolean,
      onFinal: (f: Promise<LocalFinal> | null) => void,
      id = "",
      /**
       * The voiceprint test: no enrolment id, so each utterance goes to the Mac
       * as a plain final (scored, never kept) and only to `onFinal`.
       */
      test = false,
    ) {
      if (!on || (!id && !test)) {
        enrolHook = null;
        enrolId = "";
        if (enrolOpened && mic.state() !== "off") await session.off();
        enrolOpened = false;
        return;
      }
      enrolHook = onFinal;
      enrolId = id;
      if (mic.state() === "off") {
        enrolOpened = true;
        emit({ error: null });
        await mic.toggle();
        if (mic.state() === "off") {
          // Refused or unavailable: nothing to enrol with.
          enrolHook = null;
          enrolId = "";
          enrolOpened = false;
          throw new Error("microphone not available");
        }
      }
    },
    /** Enrolling now: the button shows it, and the chat's draft gets nothing. */
    enrolling: () => !!enrolHook,
    /**
     * Replaced by a newer session: the VAD goes, the stream stays (the new
     * session builds its VAD on it).
     */
    async retire() {
      unhold?.();
      unpin();
      unblock?.();
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
      if (!store.get() || taps.blocked?.()) return;
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
      // Something turned it on meanwhile (a voice mode, a tap): a toggle now would turn it off.
      if (mic.state() !== "off") return;
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
  if (have && have.v >= MIC_SESSION_V) return have;
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
