/**
 * Li's sound hub, phase 0: it only watches (owner, 2026-11-07 19:00 JST,
 * "所有声音相关的功能都应该通过你实现"; docs/li-sound-hub.md). Who holds the mic, who
 * is playing, and when two of them collide — read from the pieces that already
 * exist, changing none of them:
 *
 * - the chat mic: `pageAudio().mic()` (MicButton sets it) and the `__lkMic`
 *   session's view, read, never subscribed;
 * - /vibe's room: `__lkMicTaps` blocked, and /words voice mode's pin;
 * - captures: every getUserMedia that asked for audio, while its tracks live;
 * - the page's audio owner: `lk:audio-claim` / `lk:audio-release`
 *   (audio-claim.ts), heard and never cancelled;
 * - sinks actually playing: media elements (attached or `new Audio()`) between
 *   `playing` and `pause`/`ended`, and speechSynthesis utterances between
 *   `start` and `end`.
 *
 * Every wrapper calls the original with the same `this` and arguments and
 * returns its result unchanged (the same promise object). Nothing here is
 * awaited by a caller, cancels an event, or touches the DOM.
 *
 * One hub per page on globalThis (LI_KEY), versioned like `__lkMic`: a newer
 * bundle retires an older hub (its wrappers come off, its listeners go) and
 * a hub is never replaced by an older one. Its state is derived, so a new hub
 * starts from what the sources say now. Everything the browser gives is
 * injected (LiEnv): unit/li-audio.test.ts runs it on fakes.
 */
import { AUDIO_CLAIM, AUDIO_RELEASE, type AudioClaimDetail } from "./audio-claim";

/** globalThis key of the hub. */
export const LI_KEY = "__lkLi";
/** Bumped when the hub's shape changes: an older one is retired, a newer one kept. */
export const LI_V = 1;

/** What a mic holder is: the chat's mic, or /vibe's own capture owning the room. */
export type LiMic = "chat" | "vibe";

export type LiView = {
  /** Who holds the mic now. */
  mic: LiMic[];
  /** /words voice mode keeps the chat mic in active mode. */
  pinned: boolean;
  /** Audio captures (getUserMedia streams) seen live, since this hub started. */
  captures: number;
  /** The page's audio owner (audio-claim.ts), by id (`li:…`, `card:…`, `para:…`). */
  claim: string | null;
  /** Sinks sounding now: `media#n` (an element), `speech#n` (an utterance). */
  playing: string[];
  /** pageAudio says something plays (or did less than its tail ago). */
  page: boolean;
};

export type LiConflict = {
  /** `two-captures`: two live streams, or the chat mic on while /vibe owns the room. */
  kind: "two-captures" | "overlap";
  view: LiView;
};

/** The slices of the existing pieces the hub reads. */
export type PageAudioLike = {
  playing(): boolean;
  mic(): boolean;
  subscribe(f: (p: boolean) => void): () => void;
};
export type MicTapsLike = {
  blocked(): boolean;
  pinned(): boolean;
  onBlock?(f: () => void): () => void;
  onPin?(f: () => void): () => void;
};
type TrackLike = { kind?: string; readyState: string };
type StreamLike = { getTracks(): TrackLike[] };
type Listenable = {
  addEventListener(t: string, f: (e?: unknown) => void): void;
  removeEventListener?(t: string, f: (e?: unknown) => void): void;
};
type Gum = (c?: { audio?: unknown }) => Promise<StreamLike>;

export type LiEnv = {
  /** The window: audio-claim events. */
  target?: EventTarget | null;
  pageAudio?: () => PageAudioLike | null;
  taps?: () => MicTapsLike | null;
  /** The `__lkMic` session's state ("off" or not), read at each change. */
  micState?: () => string | null;
  /** navigator.mediaDevices: its getUserMedia is wrapped. */
  media?: { getUserMedia?: Gum } | null;
  /** HTMLMediaElement.prototype: its play is wrapped. */
  mediaProto?: { play?: (...a: unknown[]) => unknown } | null;
  /** window.speechSynthesis: its speak is wrapped. */
  speech?: { speak?: (u: unknown) => void } | null;
};

export type LiHub = {
  v: number;
  view(): LiView;
  /** Each change of the view (deduplicated); called once at once with the current one. */
  subscribe(f: (v: LiView) => void): () => void;
  /** Each conflict as it begins (not again until it has ended). */
  onConflict(f: (c: LiConflict) => void): () => void;
  /** Wrappers off (where still ours), listeners gone. */
  retire(): void;
};

const MEDIA_ON = ["playing"];
const MEDIA_OFF = ["pause", "ended", "emptied", "error", "abort"];

export function createLiHub(env: LiEnv): LiHub {
  const undo: (() => void)[] = [];
  const views = new Set<(v: LiView) => void>();
  const conflicts = new Set<(c: LiConflict) => void>();
  let retired = false;
  let last = "";
  let current: LiView | null = null;
  const inConflict = { "two-captures": false, overlap: false };
  const streams = new Set<StreamLike>();
  const sounding = new Map<unknown, string>();
  let claim: string | null = null;
  let n = 0;

  const safe = <T>(f: () => T, d: T): T => {
    try {
      return f();
    } catch {
      return d;
    }
  };
  const liveStream = (s: StreamLike) =>
    safe(() => {
      const t = s.getTracks().filter((x) => !x.kind || x.kind === "audio");
      return t.length > 0 && t.some((x) => x.readyState === "live");
    }, false);

  const read = (): LiView => {
    for (const s of streams) if (!liveStream(s)) streams.delete(s);
    const pa = safe(() => env.pageAudio?.() ?? null, null);
    const taps = safe(() => env.taps?.() ?? null, null);
    const ms = safe(() => env.micState?.() ?? null, null);
    const chat = safe(() => !!pa?.mic(), false) || (ms !== null && ms !== "off");
    const vibe = safe(() => !!taps?.blocked(), false);
    const mic: LiMic[] = [];
    if (chat) mic.push("chat");
    if (vibe) mic.push("vibe");
    return {
      mic,
      pinned: safe(() => !!taps?.pinned(), false),
      captures: streams.size,
      claim,
      playing: [...sounding.values()],
      page: safe(() => !!pa?.playing(), false),
    };
  };

  const fire = (kind: LiConflict["kind"], on: boolean, v: LiView) => {
    if (on === inConflict[kind]) return;
    inConflict[kind] = on;
    if (on) for (const f of [...conflicts]) safe(() => f({ kind, view: v }), undefined);
  };

  /** Re-read and tell the subscribers if anything changed. Never throws. */
  const change = () => {
    if (retired) return;
    const v = read();
    const key = JSON.stringify(v);
    current = v;
    if (key === last) return;
    last = key;
    for (const f of [...views]) safe(() => f(v), undefined);
    fire("two-captures", v.captures >= 2 || v.mic.length >= 2, v);
    fire("overlap", v.playing.length >= 2, v);
  };

  /** Swap `obj[name]` for `wrap(orig)`; the undo restores it only while it is still ours. */
  const patch = <F extends (...a: never[]) => unknown>(
    obj: Record<string, unknown> | null | undefined,
    name: string,
    wrap: (orig: F) => F,
  ) => {
    const orig = obj?.[name];
    if (!obj || typeof orig !== "function") return;
    // Most of these live on a prototype (MediaDevices, SpeechSynthesis): the
    // wrapper is an own property, and taking it off leaves the object as it was.
    const own = Object.hasOwn(obj, name);
    const w = wrap(orig as F);
    obj[name] = w;
    undo.push(() => {
      if (obj[name] !== w) return;
      if (own) obj[name] = orig;
      else delete obj[name];
    });
  };

  // The page's audio owner: heard after the dispatch (a microtask), so a cancel
  // by any listener is seen; this hub never cancels.
  const t = env.target ?? null;
  if (t) {
    const onClaim = (e: Event) => {
      const d = (e as CustomEvent<AudioClaimDetail>).detail;
      if (!d?.id) return;
      queueMicrotask(() => {
        if (!e.defaultPrevented) claim = d.id;
        change();
      });
    };
    const onRelease = (e: Event) => {
      const d = (e as CustomEvent<{ id: string }>).detail;
      if (d?.id && d.id === claim) claim = null;
      change();
    };
    t.addEventListener(AUDIO_CLAIM, onClaim);
    t.addEventListener(AUDIO_RELEASE, onRelease);
    undo.push(() => {
      t.removeEventListener(AUDIO_CLAIM, onClaim);
      t.removeEventListener(AUDIO_RELEASE, onRelease);
    });
  }

  const pa = safe(() => env.pageAudio?.() ?? null, null);
  const offPa = safe(() => pa?.subscribe(() => change()), undefined);
  if (offPa) undo.push(offPa);
  const taps = safe(() => env.taps?.() ?? null, null);
  for (const on of [taps?.onBlock, taps?.onPin]) {
    const off = safe(() => on?.call(taps, () => queueMicrotask(change)), undefined);
    if (off) undo.push(off);
  }

  patch<Gum>(env.media as Record<string, unknown>, "getUserMedia", (orig) =>
    function (this: unknown, c) {
      const p = orig.call(this, c);
      if (c?.audio && p && typeof p.then === "function")
        p.then(
          (s) => {
            if (retired || !s) return;
            streams.add(s);
            for (const tr of safe(() => s.getTracks(), [] as TrackLike[]))
              safe(() => (tr as unknown as Listenable).addEventListener?.("ended", change), undefined);
            change();
          },
          () => {},
        );
      return p;
    } as Gum,
  );

  const watched = new WeakSet<object>();
  const watch = (el: Listenable, label: string, on: string[], off: string[]) => {
    if (watched.has(el)) return;
    watched.add(el);
    const start = () => {
      if (retired) return;
      sounding.set(el, label);
      change();
    };
    const stop = () => {
      if (!sounding.delete(el)) return;
      change();
    };
    safe(() => {
      for (const e of on) el.addEventListener(e, start);
      for (const e of off) el.addEventListener(e, stop);
    }, undefined);
  };

  patch<(...a: unknown[]) => unknown>(env.mediaProto as Record<string, unknown>, "play", (orig) =>
    function (this: unknown, ...a: unknown[]) {
      if (!retired && this && typeof this === "object")
        watch(this as Listenable, `media#${++n}`, MEDIA_ON, MEDIA_OFF);
      return orig.apply(this, a);
    },
  );
  patch<(u: unknown) => void>(env.speech as Record<string, unknown>, "speak", (orig) =>
    function (this: unknown, u: unknown) {
      if (!retired && u && typeof u === "object")
        watch(u as Listenable, `speech#${++n}`, ["start"], ["end", "error"]);
      return orig.call(this, u);
    },
  );

  change();

  return {
    v: LI_V,
    view: () => current ?? read(),
    subscribe(f) {
      views.add(f);
      safe(() => f(current ?? read()), undefined);
      return () => void views.delete(f);
    },
    onConflict(f) {
      conflicts.add(f);
      return () => void conflicts.delete(f);
    },
    retire() {
      if (retired) return;
      retired = true;
      for (const u of undo.splice(0).reverse()) safe(u, undefined);
      views.clear();
      conflicts.clear();
      sounding.clear();
      streams.clear();
    },
  };
}

/**
 * The page's hub, made once: a newer one is kept as it is, an older one
 * retired and replaced (never the other way round).
 */
export function liHub(env: LiEnv): LiHub {
  const g = globalThis as unknown as Record<string, LiHub | undefined>;
  const have = g[LI_KEY];
  if (have && (have.v ?? 0) >= LI_V) return have;
  if (have) safe0(() => have.retire?.());
  const next = createLiHub(env);
  g[LI_KEY] = next;
  return next;
}

/** Take the page's hub down (the last observer left): wrappers off, key gone. */
export function dropLiHub(hub: LiHub) {
  const g = globalThis as unknown as Record<string, LiHub | undefined>;
  hub.retire();
  if (g[LI_KEY] === hub) delete g[LI_KEY];
}

const safe0 = (f: () => void) => {
  try {
    f();
  } catch {}
};
