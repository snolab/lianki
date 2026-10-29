/**
 * The voice session (docs/monitoring.md, "Hands-free voice"): the one place
 * that decides when agent replies are read aloud, and that tells the mic when
 * to hold its capture so it never transcribes the reply. Both the bundled
 * DebugEval (its speakReply) and the chat — bundled or hot-loaded — use the
 * same session through `voice()`, which keeps it on globalThis, so a hot-loaded
 * widget and the deployed page behave the same.
 *
 * - Replies go in a FIFO queue, one utterance per sentence; a new reply waits
 *   behind the one being read and never cuts it off.
 * - Mic on: every reply is read, whatever the speaker toggle or focus says
 *   (the toggle itself is never changed, so it is "restored" when the mic
 *   stops). Mic off: a reply is read only with the toggle on and the chat
 *   input focused in a visible tab (the focus rule).
 * - While an utterance plays (and RESUME_TAIL_MS after the queue runs dry)
 *   `speaking` is true: the mic holds its capture and drops what it heard.
 * - An interruption (the user starts speaking, taps the mic, or types) stops
 *   the utterance and remembers where: the last word boundary the browser
 *   reported, else the start of that utterance. Speech or a tap resumes once
 *   the user's line was sent, or after IDLE_RESUME_MS of quiet; typing waits
 *   for a send or (mic on) a blur. `stop()` clears the queue.
 *
 * Everything browser-shaped is injected, so this is tested with fakes
 * (unit/voice.test.ts). Event-driven only: utterance end/error/boundary
 * events and one-shot timers, never polling.
 */
import { pickLang, pickVoice } from "./wire";

/** Capture resumes this long after the last utterance ends (the room's echo). */
export const RESUME_TAIL_MS = 400;
/** An interruption with nothing said (or nothing more) resumes the reading after this. */
export const IDLE_RESUME_MS = 1_500;
/** localStorage: the speaker toggle ("0" = replies silent). */
export const SPEAK_KEY = "lk:debug-chat-speak";
/** globalThis key of the shared session. */
const KEY = "__lkVoice";

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

export type UtterLike = {
  text: string;
  onend: ((e?: unknown) => void) | null;
  onerror: ((e?: unknown) => void) | null;
  onboundary: ((e: { charIndex: number; name?: string }) => void) | null;
};
export type SynthLike = { speak(u: UtterLike): void; cancel(): void };

export type VoiceState = {
  /** The mic is on (listening, loading or capturing). */
  mic: boolean;
  /** An utterance is playing, or just ended (the tail): the mic holds its capture. */
  speaking: boolean;
  /** Sentences still to read, the current one included. */
  queued: number;
  /** The reading waits for an interruption to end. */
  paused: boolean;
};

export type Why = "speech" | "tap" | "typing";

type Sentence = { text: string; lang: string; from: number };

export function createVoice(d: {
  synth: () => SynthLike | null;
  /** A new utterance for `text` in `lang` (the browser picks a voice). */
  utter: (text: string, lang: string) => UtterLike;
  /** The speaker toggle. */
  enabled: () => boolean;
  /** The focus rule: this tab is visible and the chat input has focus. */
  here: () => boolean;
  setTimer?: (f: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}) {
  const setTimer = d.setTimer ?? ((f, ms) => setTimeout(f, ms));
  const clearTimer = d.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  let mic = false;
  let speaking = false;
  const queue: Sentence[] = [];
  /** Interruptions under way; the reading waits while any is. */
  const pauses = new Set<Why>();
  /** The utterance playing, and the char (in its sentence) of the last word boundary heard. */
  let current: { u: UtterLike; mark: number } | null = null;
  let tail: unknown;
  let idle: unknown;
  /** Bumped whenever the utterance playing is dropped: its late events are ignored. */
  let epoch = 0;
  const subs = new Set<(s: VoiceState) => void>();

  const state = (): VoiceState => ({
    mic,
    speaking,
    queued: queue.length,
    paused: pauses.size > 0,
  });
  const emit = () => {
    const s = state();
    for (const f of subs) f(s);
  };
  const focusRule = () => d.enabled() && d.here();

  /** Speak the head of the queue, if nothing is playing and nothing waits (the caller emits). */
  const next = () => {
    const s = d.synth();
    if (current || pauses.size || !s) return;
    const head = queue[0];
    if (!head) return;
    const e = epoch;
    const u = d.utter(head.text.slice(head.from), head.lang);
    current = { u, mark: head.from };
    const from = head.from;
    u.onboundary = (ev) => {
      if (e !== epoch || !current) return;
      if (ev.name && ev.name !== "word") return;
      current.mark = from + Math.max(0, ev.charIndex | 0);
    };
    // A failure that is not ours (we only cancel after bumping the epoch) moves on too.
    u.onend = u.onerror = () => {
      if (e !== epoch) return;
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
    clearTimer(tail);
    speaking = true;
    s.speak(u);
  };

  /** Drop the utterance playing (keeping where it got to) and release the mic at once. */
  const halt = (keepPlace: boolean) => {
    epoch++;
    clearTimer(tail);
    if (current) {
      if (keepPlace && queue[0]) queue[0].from = current.mark;
      current = null;
      d.synth()?.cancel();
    }
    speaking = false;
  };

  const resume = () => {
    clearTimer(idle);
    if (!pauses.size) return;
    pauses.clear();
    next();
    emit();
  };

  const api = {
    v: 1 as const,
    state,
    subscribe(f: (s: VoiceState) => void) {
      subs.add(f);
      return () => void subs.delete(f);
    },
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
    /** A reply arrived live: queue its sentences (if it should be read). */
    reply(text: string): boolean {
      if (!d.synth() || !api.shouldSpeak()) return false;
      const lang = pickLang(text);
      const add = sentences(text).map((t) => ({ text: t, lang, from: 0 }));
      if (!add.length) return false;
      queue.push(...add);
      next();
      emit();
      return true;
    },
    /**
     * The user cut in: `speech` (the VAD heard them start), `tap` (the mic
     * button while the agent speaks) or `typing`. Only when there is
     * something to interrupt. Speech and taps resume after IDLE_RESUME_MS
     * unless more happens; typing waits for resume().
     */
    interrupt(why: Why) {
      if (!queue.length && !current) {
        // Only the tail is left: release the mic now.
        if (speaking) {
          halt(false);
          emit();
        }
        return;
      }
      halt(true);
      pauses.add(why);
      clearTimer(idle);
      if (why === "tap") idle = setTimer(resume, IDLE_RESUME_MS);
      emit();
    },
    /** The user's utterance ended (or misfired): the reading resumes after a short quiet. */
    userIdle() {
      if (!pauses.has("speech") && !pauses.has("tap")) return;
      clearTimer(idle);
      idle = setTimer(resume, IDLE_RESUME_MS);
    },
    /** The interruption is over (a line was sent, or the input lost focus): read on. */
    resume,
    /** Clear the queue and stop reading ("Stop reading", the focus rule). */
    stop() {
      halt(false);
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
  try {
    return localStorage.getItem(SPEAK_KEY) !== "0";
  } catch {
    return true;
  }
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

/** The session, shared by every copy of this module on the page. */
export function voice(): Voice {
  const g = globalThis as unknown as Record<string, Voice | undefined>;
  const have = g[KEY];
  if (have && have.v === 1) return have;
  const v = createVoice({
    synth,
    enabled: speechEnabled,
    here: speakHere,
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
  return v;
}
