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
import { type MicState, type UploadInfo, type Vad, type VadEvents, createMic } from "./mic";

/** globalThis key of the session. */
export const MIC_SESSION_KEY = "__lkMic";
/** Bumped when the session's shape changes; an older one is migrated, its stream kept. */
export const MIC_SESSION_V = 1;
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
};
export type MicConfig = { clipSink?: string; label: string };
export type MicDeps = {
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
  let view: MicView = { state: "off", pending: 0, interim: "", error: null, resume: false };
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
  const mic = createMic({
    load: async (ev) => deps.load(ev, await ensureStream()),
    fallback: deps.fallback ? async (ev) => deps.fallback!(ev, await ensureStream()) : undefined,
    upload: (wav, info) => deps.upload(wav, info, cfg),
    onState: (s) => {
      const was = prev;
      prev = s;
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
    },
    /** A tap: on (remembered for a reload), or an explicit off. */
    async toggle() {
      emit({ error: null });
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
