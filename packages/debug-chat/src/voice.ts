/**
 * The voice session (docs/monitoring.md, "Hands-free voice"): the one place
 * that decides when agent replies are read aloud, how loud, and how the mic
 * treats them. Both the bundled DebugEval (its speakReply) and the chat —
 * bundled or hot-loaded — use the same session through `voice()`, which keeps
 * it on globalThis, so a hot-loaded widget and the deployed page behave the
 * same.
 *
 * - Replies go in a FIFO queue, one utterance per sentence (sentences longer
 *   than CHUNK_MAX are cut at a clause or a space); a new reply waits behind
 *   the one being read and never cuts it off.
 * - Output (voice-out.ts, `lk:voice-out`): the device's speechSynthesis
 *   ("speech", default), or "cloud": each sentence from /api/words/tts played
 *   through the page's own audio, so the echo canceller hears it. A sentence
 *   the cloud cannot voice is read by speechSynthesis instead.
 * - Mic on: every reply is read, whatever the speaker toggle or focus says
 *   (the toggle itself is never changed, so it is "restored" when the mic
 *   stops). Mic off: a reply is read only with the toggle on and the chat
 *   input focused in a visible tab (the focus rule).
 * - Echo (`lk:voice-aec`, default on): the mic stays open while the agent
 *   speaks — echo cancellation, then the text guard (echo.ts) drops what
 *   leaks through. The user speaking over the agent ducks it to DUCK_LEVEL;
 *   speech that goes on for BARGE_IN_MS (and sounds like speech: isBargeIn)
 *   is a barge-in and pauses the reading. With `lk:voice-aec` = "0", the old
 *   way: `hold` is true while an utterance plays (and RESUME_TAIL_MS after),
 *   and the mic holds its capture.
 * - An interruption (a barge-in, a tap on the mic, typing) stops the utterance
 *   and remembers where: the clip's time (cloud), else the last word boundary
 *   the browser reported, else the start of that sentence. Speech or a tap
 *   resumes once the user's line was sent, or after IDLE_RESUME_MS of quiet;
 *   typing waits for a send or (mic on) a blur. `stop()` clears the queue.
 *
 * Everything browser-shaped is injected, so this is tested with fakes
 * (unit/voice-session.test.ts). Event-driven only: utterance and clip
 * events and one-shot timers, never polling.
 */
import { speechRate } from "./speech-rate";
import { ECHO_WINDOW_MS, type EchoScore, echoScore } from "./echo";
import { aecOn, cloudOut, outMode } from "./voice-out";
import { pickLang, pickVoice } from "./wire";
import { type Silence, type SpeakMeta, silenceHere } from "./quiet-hours";
import { getKey } from "./storage-keys";

/** Capture resumes this long after the last utterance ends (the room's echo; hold mode). */
export const RESUME_TAIL_MS = 400;
/** An interruption with nothing said (or nothing more) resumes the reading after this. */
export const IDLE_RESUME_MS = 1_500;
/** While the user talks over the agent, the agent plays this loud… */
export const DUCK_LEVEL = 0.25;
/** …reached over this long (cloud; speechSynthesis takes it from its next sentence)… */
export const DUCK_ATTACK_MS = 80;
/** …and back to full over this long once the user stops. */
export const DUCK_RELEASE_MS = 200;
/** The user talking over the agent this long is a barge-in: the reading pauses. */
export const BARGE_IN_MS = 1_500;
/**
 * …and only if it sounds like speech: the VAD's mean speech probability over
 * that window reaches this (above Silero's own 0.5 start threshold, since the
 * echo that leaks through tends to score lower). Weaker speech keeps the
 * agent ducked and is judged again after another BARGE_IN_MS.
 */
export const BARGE_IN_PROB = 0.7;
/** Sentences are cut to at most this many characters (the TTS route's limit). */
export const CHUNK_MAX = 200;
/** localStorage: the speaker toggle ("0" = replies silent). */
export const SPEAK_KEY = "lk:debug-chat-speak";
/** A reply with the same text within this long is a re-delivery, not a new one. */
export const REPLY_DEDUPE_MS = 10 * 60_000;
/** globalThis key of the shared session. */
const KEY = "__lkVoice";
/** The session's version: a copy on the page with another one is replaced. */
const V = 2;

const CJK_STOP = "。．！？";
const LATIN_STOP = ".!?";
const CLOSERS = "」』）】〕〉》\"'”’)]";

/**
 * A reply as sentences: cut after 。．！？ (with any closing quotes or
 * brackets), after . ! ? followed by a space or the end (so 3.14 and e.g.
 * mid-word stay whole), and at every newline. Blank pieces are dropped.
 */
export function sentences(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  const push = () => {
    const t = cur.trim();
    if (t) out.push(t);
    cur = "";
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\n" || c === "\r") {
      push();
      continue;
    }
    cur += c;
    const cjk = CJK_STOP.includes(c);
    if (!cjk && !LATIN_STOP.includes(c)) continue;
    while (i + 1 < text.length && (CJK_STOP + LATIN_STOP + CLOSERS).includes(text[i + 1]))
      cur += text[++i];
    if (cjk || i + 1 >= text.length || /\s/.test(text[i + 1])) push();
  }
  push();
  return out;
}

const CLAUSE = /[、，,;；:：]/;

/** Where a resumed utterance may start: just after one of these (and any spaces after it). */
const RESUME_MARK = /[。．！？，、.!?,;；\n\r]/;

/**
 * The place to resume an utterance from when the exact one is unknown: the
 * share `fraction` (0..1) of it already heard, as a character offset rounded
 * DOWN to the start of a sentence or clause (after 。．！？，、 . ! ? , ; or a
 * newline), so nothing unheard is skipped. 0 when no such start was passed.
 */
export function resumeOffset(text: string, fraction: number): number {
  const target = Math.floor(Math.min(1, Math.max(0, fraction)) * text.length);
  let best = 0;
  for (let i = 0; i < target; i++) {
    if (!RESUME_MARK.test(text[i]!)) continue;
    let j = i + 1;
    while (j < text.length && /\s/.test(text[j]!)) j++;
    if (j <= target) best = j;
  }
  return best;
}

/** Han, kana, hangul: read a character at a time. */
const CJK_TEXT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
/** Characters per second speechSynthesis reads at rate 1: CJK, and other scripts. */
export const SPEECH_CPS = { cjk: 5, other: 14 } as const;
/** The share of `text` heard after `ms` at `rate`, by the reading speed (no boundary events). */
export function heardFraction(text: string, ms: number, rate = 1): number {
  if (!text.length || ms <= 0) return 0;
  const cps = CJK_TEXT.test(text) ? SPEECH_CPS.cjk : SPEECH_CPS.other;
  return Math.min(1, (ms / 1000) * cps * Math.max(0.1, rate) / text.length);
}

/** A sentence in pieces of at most `max` chars: after the last clause mark, else a space, else hard. */
export function chunk(s: string, max = CHUNK_MAX): string[] {
  const out: string[] = [];
  let rest = s.trim();
  while (rest.length > max) {
    const head = rest.slice(0, max);
    let cut = -1;
    for (let i = head.length - 1; i > max / 3; i--)
      if (CLAUSE.test(head[i])) {
        cut = i + 1;
        break;
      }
    if (cut < 0) {
      const sp = head.lastIndexOf(" ");
      cut = sp > max / 3 ? sp + 1 : max;
    }
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/** A barge-in, by the VAD's speech probabilities over the window (none known, as with the energy VAD: yes). */
export function isBargeIn(probs: readonly number[], min = BARGE_IN_PROB): boolean {
  if (!probs.length) return true;
  return probs.reduce((a, b) => a + b, 0) / probs.length >= min;
}

export type UtterLike = {
  text: string;
  volume?: number;
  /** The reading speed (speech-rate.ts). */
  rate?: number;
  onend: ((e?: unknown) => void) | null;
  onerror: ((e?: unknown) => void) | null;
  /** The browser began speaking it (the latency record's t_audible). */
  onstart?: ((e?: unknown) => void) | null;
  onboundary: ((e: { charIndex: number; name?: string }) => void) | null;
};
export type SynthLike = { speak(u: UtterLike): void; cancel(): void };

/** One sentence playing, on either route. */
export type Playback = {
  route: "audio" | "speech";
  /** Stop now; the place to resume from (seconds into the clip). */
  stop(): { at?: number };
  /** Ramp the volume (audio route; speechSynthesis cannot change mid-utterance). */
  volume(level: number, ms: number): void;
};
export type PlayEvents = {
  /** It started playing (audible): the voice latency record (latency.ts). */
  onstart?(): void;
  onend(): void;
  onerror(): void;
  /** The cloud could not voice it (fetch, language, length, play refused): read it with speech. */
  onfail?(reason: string): void;
};
/** The cloud output (voice-out.ts createCloudOut). */
export type CloudOut = {
  prepare?(text: string, lang: string): void;
  play(
    s: { text: string; lang: string; at: number; volume: number; rate?: number },
    ev: PlayEvents,
  ): Playback;
};

export type VoiceState = {
  /** The mic is on (listening, loading or capturing). */
  mic: boolean;
  /** An utterance is playing, or just ended (the tail). */
  speaking: boolean;
  /** The mic holds its capture: speaking, with echo cancellation off (lk:voice-aec = "0"). */
  hold: boolean;
  /** The agent is ducked under the user's voice. */
  ducked: boolean;
  /** Sentences still to read, the current one included. */
  queued: number;
  /** The reading waits for an interruption to end. */
  paused: boolean;
};

export type Why = "speech" | "tap" | "typing";
export type OutMode = "speech" | "cloud";

type Sentence = { text: string; lang: string; from: number; at: number };
/** What the agent said, and when (for the echo guard). */
type Said = { text: string; start: number; end?: number };

/** What the echo check says about one transcript. */
export type EchoCheck = EchoScore & {
  /** The agent was audible at some point during the utterance. */
  during: boolean;
};

export function createVoice(d: {
  synth: () => SynthLike | null;
  /** A new utterance for `text` in `lang` (the browser picks a voice). */
  utter: (text: string, lang: string) => UtterLike;
  /** The speaker toggle. */
  enabled: () => boolean;
  /** The focus rule: this tab is visible and the chat input has focus. */
  here: () => boolean;
  /** The cloud output, for `mode() === "cloud"`. */
  cloud?: () => CloudOut | null;
  mode?: () => OutMode;
  /** Echo-cancelled barge-in (else capture is held while the agent speaks). */
  aec?: () => boolean;
  /** The reading speed, read for each utterance (speech-rate.ts; 1 if absent). */
  rate?: () => number;
  now?: () => number;
  log?: (ev: Record<string, unknown>) => void;
  setTimer?: (f: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}) {
  const setTimer = d.setTimer ?? ((f, ms) => setTimeout(f, ms));
  const clearTimer = d.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  const now = d.now ?? (() => Date.now());
  const cloud = () => d.cloud?.() ?? null;
  const mode = (): OutMode => (d.mode?.() === "cloud" && cloud() ? "cloud" : "speech");
  const aec = () => d.aec?.() ?? true;
  let log = d.log ?? (() => {});
  let mic = false;
  let speaking = false;
  const queue: Sentence[] = [];
  /** Replies queued lately, so a re-delivered one is not read twice. */
  const recent: { text: string; at: number }[] = [];
  /** Interruptions under way; the reading waits while any is. */
  const pauses = new Set<Why>();
  /** The sentence playing: how, (speech) the char of the last word boundary heard, and its record. */
  let current: { p: Playback; mark: number; said: Said } | null = null;
  let tail: unknown;
  let idle: unknown;
  /** Bumped whenever the utterance playing is dropped: its late events are ignored. */
  let epoch = 0;
  /** The agent's volume: 1, or DUCK_LEVEL while the user talks over it. */
  let level = 1;
  /** Ducked: the barge-in timer, and the speech probabilities heard since it was armed. */
  let duck: { timer: unknown; probs: number[] } | null = null;
  const said: Said[] = [];
  const subs = new Set<(s: VoiceState) => void>();
  /** Told each time a sentence starts playing (latency.ts). */
  const starts = new Set<() => void>();

  const state = (): VoiceState => ({
    mic,
    speaking,
    hold: speaking && !aec(),
    ducked: !!duck,
    queued: queue.length,
    paused: pauses.size > 0,
  });
  const emit = () => {
    const s = state();
    for (const f of subs) f(s);
  };
  const focusRule = () => d.enabled() && d.here();
  const canSpeak = () => !!d.synth() || mode() === "cloud";

  const ended = () => {
    if (current && current.said.end === undefined) current.said.end = now();
  };

  /** Read one sentence with speechSynthesis (from its last word boundary). */
  const speech = (head: Sentence, ev: PlayEvents, e: number): Playback | null => {
    const s = d.synth();
    if (!s) return null;
    const from = head.from;
    const u = d.utter(head.text.slice(from), head.lang);
    // iOS cannot change it mid-utterance: a duck applies from the next sentence.
    if (level !== 1) u.volume = level;
    // The speed, as set now: a change applies from the next utterance.
    u.rate = d.rate?.() ?? 1;
    u.onboundary = (b) => {
      if (e !== epoch || !current) return;
      if (b.name && b.name !== "word") return;
      current.mark = from + Math.max(0, b.charIndex | 0);
    };
    u.onend = () => ev.onend();
    u.onerror = () => ev.onerror();
    u.onstart = () => ev.onstart?.();
    s.speak(u);
    return {
      route: "speech",
      stop: () => {
        s.cancel();
        return {};
      },
      volume: () => {},
    };
  };

  /** Speak the head of the queue, if nothing is playing and nothing waits (the caller emits). */
  const next = () => {
    if (current || pauses.size || !canSpeak()) return;
    const head = queue[0];
    if (!head) return;
    const e = epoch;
    const done = () => {
      if (e !== epoch) return;
      ended();
      current = null;
      queue.shift();
      next();
      if (!current) {
        // Queue dry: capture resumes after the tail.
        clearTimer(tail);
        tail = setTimer(() => {
          if (e !== epoch || current) return;
          speaking = false;
          emit();
        }, RESUME_TAIL_MS);
      }
      emit();
    };
    const info = { lang: head.lang, chars: head.text.length };
    // A failure that is not ours (we only cancel after bumping the epoch) moves on too.
    const ev: PlayEvents = {
      onstart: () => {
        if (e !== epoch) return;
        for (const f of starts) f();
      },
      onend: done,
      onerror: done,
      onfail: (reason) => {
        if (e !== epoch || !current) return;
        log({ ev: "voice-out", out: "cloud", route: "speech", fallback: reason, ...info });
        const p = speech(head, ev, e);
        if (!p) return done();
        current.p = p;
      },
    };
    const rec: Said = { text: head.text, start: now() };
    const c = mode() === "cloud" ? cloud() : null;
    current = { p: null as unknown as Playback, mark: head.from, said: rec };
    const p = c
      ? c.play(
          { text: head.text, lang: head.lang, at: head.at, volume: level, rate: d.rate?.() ?? 1 },
          ev,
        )
      : speech(head, ev, e);
    if (!p) {
      current = null;
      return;
    }
    current.p = p;
    said.push(rec);
    if (said.length > 50) said.shift();
    log({
      ev: "voice-out",
      out: c ? "cloud" : "speech",
      route: p.route,
      ...info,
      volume: level,
      at: head.at || undefined,
      from: head.from || undefined,
    });
    // Fetch the next one while this plays.
    if (c && queue[1]) c.prepare?.(queue[1].text, queue[1].lang);
    clearTimer(tail);
    speaking = true;
  };

  /** Drop the utterance playing (keeping where it got to) and release the mic at once. */
  const halt = (keepPlace: boolean) => {
    epoch++;
    clearTimer(tail);
    if (current) {
      ended();
      const place = current.p.stop();
      const head = queue[0];
      if (keepPlace && head) {
        // The exact place when there is one: the clip's time (audio), or the
        // last word boundary the browser reported (speech). Without either
        // (Android's voices often send no boundaries), an estimate from the
        // time it has been speaking, rounded down to a sentence's start.
        if (current.p.route === "audio") head.at = place.at ?? head.at;
        else {
          const rest = head.text.slice(head.from);
          head.from =
            current.mark > head.from
              ? current.mark
              : head.from +
                resumeOffset(rest, heardFraction(rest, now() - current.said.start, d.rate?.() ?? 1));
          head.at = 0;
        }
      }
      current = null;
    }
    speaking = false;
  };

  const setLevel = (l: number, ms: number) => {
    level = l;
    current?.p.volume(l, ms);
  };
  /** Back to full volume: ramped (the user stopped) or at once (the reading stopped). */
  const unduck = (ms: number) => {
    if (!duck) return;
    clearTimer(duck.timer);
    duck = null;
    setLevel(1, ms);
  };
  const armBarge = () => {
    const dk = duck;
    if (!dk) return;
    clearTimer(dk.timer);
    dk.timer = setTimer(() => {
      if (duck !== dk) return;
      const probs = dk.probs;
      dk.probs = [];
      const prob = probs.length ? probs.reduce((a, b) => a + b, 0) / probs.length : undefined;
      if (!isBargeIn(probs)) {
        log({ ev: "voice-duck-hold", prob });
        return armBarge();
      }
      log({ ev: "voice-barge-in", prob });
      api.interrupt("speech");
    }, BARGE_IN_MS);
  };

  const resume = () => {
    clearTimer(idle);
    if (!pauses.size) return;
    pauses.clear();
    next();
    emit();
  };

  const api = {
    v: V,
    state,
    subscribe(f: (s: VoiceState) => void) {
      subs.add(f);
      return () => void subs.delete(f);
    },
    /** `f` runs each time a sentence starts playing (audible), on either route. */
    onStart(f: () => void) {
      starts.add(f);
      return () => void starts.delete(f);
    },
    /** Where the debug events go (DebugEval passes devLog). */
    setLog(f: (ev: Record<string, unknown>) => void) {
      log = f;
    },
    log: (ev: Record<string, unknown>) => log(ev),
    /** The output in use: "speech" or "cloud". */
    mode,
    aec,
    /** Whether a reply arriving now is read: always with the mic on, else by the focus rule. */
    shouldSpeak: () => mic || focusRule(),
    /** The speaker toggle as it applies now (forced on while the mic is on). */
    readAloud: () => mic || d.enabled(),
    /** The mic turned on or off. Off: what the focus rule would not read stops. */
    setMic(on: boolean) {
      if (mic === on) return;
      mic = on;
      if (!on && !focusRule()) return api.stop();
      emit();
    },
    /**
     * A reply arrived live: queue its sentences (if it should be read),
     * behind what is still being read (a reply arriving while the reading is
     * paused waits for it). The same reply delivered again (a reconnect
     * re-sending it) is not read again from its start. `meta` is the line's
     * quiet/loud/ask; voice() gates on it (gateVoice) first.
     */
    reply(text: string, _meta?: SpeakMeta): boolean {
      if (!canSpeak() || !api.shouldSpeak()) return false;
      const t = now();
      if (recent.some((r) => r.text === text && t - r.at < REPLY_DEDUPE_MS)) {
        log({ ev: "voice-reply-dup", chars: text.length });
        return false;
      }
      recent.push({ text, at: t });
      while (recent.length > 20) recent.shift();
      const lang = pickLang(text);
      const add = sentences(text)
        .flatMap((s) => chunk(s))
        .map((t) => ({ text: t, lang, from: 0, at: 0 }));
      if (!add.length) return false;
      const c = mode() === "cloud" ? cloud() : null;
      if (c && !queue.length) c.prepare?.(add[0].text, lang);
      queue.push(...add);
      next();
      emit();
      return true;
    },
    /**
     * The VAD heard the user start. Over the agent with echo cancellation on:
     * duck it, and pause the reading only if they keep going (BARGE_IN_MS).
     * Otherwise as interrupt("speech").
     */
    userSpeech() {
      if (current && aec()) {
        if (!duck) {
          duck = { timer: undefined, probs: [] };
          setLevel(DUCK_LEVEL, DUCK_ATTACK_MS);
          log({ ev: "voice-duck", route: current.p.route });
          emit();
        }
        armBarge();
        return;
      }
      api.interrupt("speech");
    },
    /** One VAD frame's speech probability while the user is heard (judges a barge-in). */
    userFrame(prob: number) {
      duck?.probs.push(prob);
    },
    /**
     * The user cut in: `speech` (a barge-in), `tap` (the mic button while the
     * agent speaks) or `typing`. Only when there is something to interrupt.
     * Speech and taps resume after IDLE_RESUME_MS unless more happens;
     * typing waits for resume().
     */
    interrupt(why: Why) {
      if (!queue.length && !current) {
        unduck(0);
        // Only the tail is left: release the mic now.
        if (speaking) {
          halt(false);
          emit();
        }
        return;
      }
      halt(true);
      unduck(0); // after the halt: what stopped is not turned back up first
      pauses.add(why);
      clearTimer(idle);
      if (why === "tap") idle = setTimer(resume, IDLE_RESUME_MS);
      emit();
    },
    /** The user's utterance ended (or misfired): unduck, or read on after a short quiet. */
    userIdle() {
      if (duck) {
        unduck(DUCK_RELEASE_MS);
        emit();
        return;
      }
      if (!pauses.has("speech") && !pauses.has("tap")) return;
      clearTimer(idle);
      idle = setTimer(resume, IDLE_RESUME_MS);
    },
    /** The interruption is over (a line was sent, or the input lost focus): read on. */
    resume,
    /**
     * Was `transcript` (an utterance `durationMs` long, just ended) the agent's
     * own voice? Checked against what it said in the last ECHO_WINDOW_MS.
     */
    echoCheck(transcript: string, durationMs = 0): EchoCheck {
      const t = now();
      const from = t - durationMs;
      const recent = said.filter((r) => (r.end ?? t) >= from - ECHO_WINDOW_MS).map((r) => r.text);
      const during = said.some((r) => r.start <= t && (r.end ?? t) >= from);
      return { ...echoScore(transcript, recent), during };
    },
    /**
     * A transcript was the agent's own echo (echoCheck): a barge-in it caused
     * was no barge-in, so the reading goes on now rather than after the idle.
     */
    echoDropped() {
      if (pauses.size === 1 && pauses.has("speech")) resume();
    },
    /** Clear the queue and stop reading ("Stop reading", the focus rule). */
    stop() {
      halt(false);
      unduck(0);
      clearTimer(idle);
      queue.length = 0;
      pauses.clear();
      emit();
    },
  };
  return api;
}

export type Voice = ReturnType<typeof createVoice>;

const synth = () =>
  typeof speechSynthesis === "undefined" ? null : (speechSynthesis as unknown as SynthLike);

/** Whether agent replies are read aloud on this device (on unless turned off). */
export const speechEnabled = () => {
  return getKey(SPEAK_KEY) !== "0";
};

/**
 * Replies are read only to someone typing here: this tab is visible and the
 * chat input has focus (checked as each reply arrives). The mic overrides it.
 */
export function speakHere() {
  if (typeof document === "undefined" || document.visibilityState !== "visible") return false;
  return document.activeElement?.getAttribute("data-testid") === "debug-chat-input";
}

/**
 * Utterances still playing are kept here: Chrome may garbage-collect one
 * nothing references, and then its `end` never fires.
 */
const alive = new Set<unknown>();

/** The gate's version: a session gated by an older copy is gated again by this one. */
const GATE_V = 1;
type Gated = Voice & { __gate?: number; __rawReply?: Voice["reply"] };

/**
 * Agent lines must not wake the owner (quiet-hours.ts): wrap the session's
 * `reply` so a hidden page, a quiet line or quiet hours keep it silent. It
 * wraps the shared session object itself, so a deployed copy of this module
 * calling `voice().reply(text)` (no meta) gets quiet hours and the hidden
 * rule from a hot-loaded widget too. It also stops the reading the moment
 * the page is hidden (one listener per page).
 */
export function gateVoice(v: Voice, why: (m: SpeakMeta) => Silence | null = silenceHere): Voice {
  const s = v as Gated;
  if (s.__gate === GATE_V) return v;
  const raw = s.__rawReply ?? v.reply;
  s.__rawReply = raw;
  s.reply = (text: string, meta?: SpeakMeta) => {
    const silence = why(meta ?? {});
    if (silence) {
      v.log({ ev: "voice-silent", why: silence });
      return false;
    }
    return raw(text, meta);
  };
  s.__gate = GATE_V;
  const g = globalThis as unknown as Record<string, unknown>;
  if (
    !g.__lkVoiceHide &&
    typeof document !== "undefined" &&
    typeof document.addEventListener === "function"
  ) {
    g.__lkVoiceHide = true;
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") (g[KEY] as Voice | undefined)?.stop();
    });
  }
  return v;
}

/** The session, shared by every copy of this module on the page. */
export function voice(): Voice {
  const g = globalThis as unknown as Record<string, Voice | undefined>;
  const have = g[KEY];
  if (have && have.v === V) return gateVoice(have);
  const v = createVoice({
    synth,
    enabled: speechEnabled,
    here: speakHere,
    cloud: cloudOut,
    mode: outMode,
    aec: aecOn,
    rate: () => speechRate(),
    utter: (text, lang) => {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = lang;
      const pick = pickVoice(speechSynthesis.getVoices(), lang);
      if (pick) u.voice = pick;
      alive.add(u);
      u.addEventListener("end", () => alive.delete(u));
      u.addEventListener("error", () => alive.delete(u));
      return u as unknown as UtterLike;
    },
  });
  g[KEY] = v;
  return gateVoice(v);
}
