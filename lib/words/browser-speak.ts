/**
 * One part said by the browser's speech (Web Speech API), with the server's
 * clip as its fallback. Every call ends exactly once — `done(played)` — so the
 * sequence (lib/words/sequence.ts) goes on at once and never waits for its
 * part watchdog (`words.partTimeoutMs`):
 *
 * - it ends: done(true);
 * - it fails after it started (a run of a mixed example whose voice breaks):
 *   done(false) — part of it was said, so the server does not say it again;
 * - it fails, ends or stays silent before it started: this language goes to
 *   the server from now on, and the server's clip says the part — or, with
 *   no clip either, done(false) at once;
 * - interrupted or canceled before it started (not by us): done(false).
 *
 * Nothing reports after `cancel()` (a new generation): the sequence moved on.
 */

/** The browser's events for one utterance, as the engine reports them. */
export type UtteranceEvents = {
  start(): void;
  end(): void;
  /** SpeechSynthesisErrorEvent.error, e.g. "synthesis-failed", "interrupted". */
  error(code: string): void;
  boundary(charIndex: number, name: string): void;
};

/** The word being said, highlighted while the part plays (follow-speech.ts). */
export type Follower = {
  start(): void;
  end(spoken: boolean): void;
  boundary(charIndex: number, name: string): void;
};

export type BrowserSpeakDeps<V> = {
  /** The page's speech generation; a cancel() moves it on. */
  generation(): number;
  /** The browser can say this language now (has a voice, not given up on). */
  can(lang: string): boolean;
  /** The device voice of this very language, or null. */
  voiceFor(lang: string): V | null;
  /** Speak `text` with `voice`; the engine's events go to `on`. */
  speak(text: string, voice: V, rate: number, on: UtteranceEvents): void;
  /** Silence our own utterances (never Li's). */
  cancel(): void;
  /** The browser failed this language: the server says it from now on. */
  giveUp(lang: string): void;
  /** The server's clip; false when there is none (no voice, limit, offline). */
  serverSpeak(
    text: string,
    lang: string,
    done: (played: boolean) => void,
    track: boolean,
    owner?: string,
  ): Promise<boolean>;
  /** The word being said, for a tracked part (an example), or null. */
  follow?(text: string, lang: string, rate: number, owner?: string): Follower | null;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(t: unknown): void;
  log?(e: Record<string, unknown>): void;
};

export type BrowserSpeakRequest = {
  text: string;
  lang: string;
  done: (played: boolean) => void;
  /** The server already failed this text: don't ask again. */
  serverTried?: boolean;
  /** Mark the word being said (an example). */
  track?: boolean;
  owner?: string;
};

/** Speech rate of /words' browser voice. */
export const BROWSER_RATE = 0.9;
/** An utterance that has not started by then never will (no engine behind the API). */
export const START_TIMEOUT_MS = 2000;

const INTERRUPTED = new Set(["interrupted", "canceled"]);

export function browserSpeak<V extends { name?: string; lang: string }>(
  deps: BrowserSpeakDeps<V>,
  req: BrowserSpeakRequest,
): void {
  const { text, lang, done, serverTried = false, track = false, owner } = req;
  const gen = deps.generation();
  const current = () => gen === deps.generation();
  let settled = false;
  let words: Follower | null = null;
  let watchdog: unknown;
  /** The one end of this part. */
  const finish = (played: boolean) => {
    if (settled) return;
    settled = true;
    deps.clearTimer(watchdog);
    words?.end(played);
    if (current()) done(played);
  };
  const viaServer = () => {
    if (serverTried) {
      // Neither engine can say it: log that, rather than going on in silence.
      deps.log?.({ ev: "silent", lang, text, reason: "no server clip, no browser voice" });
      return finish(false);
    }
    void deps.serverSpeak(text, lang, finish, track, owner).then(
      (ok) => !ok && finish(false),
      () => finish(false),
    );
  };
  // Only a voice of this very language. With none listed (Chrome on Android
  // often lists nothing) the OS picks its default voice — a Japanese voice
  // reading French. The server speaks instead, or nothing.
  const voice = deps.can(lang) ? deps.voiceFor(lang) : null;
  if (!voice) return viaServer();
  deps.log?.({ ev: "browser", lang, text, voice: voice.name, voiceLang: voice.lang });
  words = track ? (deps.follow?.(text, lang, BROWSER_RATE, owner) ?? null) : null;
  let started = false;
  /** Handed to the server: the utterance's own events no longer count. */
  let handedOff = false;
  const over = () => settled || handedOff;
  // Never started (no engine behind the API) or failed before a sound: the
  // server speaks this language from now on.
  const fallBack = () => {
    if (over() || started) return;
    if (!current()) return finish(false);
    handedOff = true;
    deps.clearTimer(watchdog);
    words?.end(false);
    words = null;
    deps.giveUp(lang);
    deps.cancel();
    viaServer();
  };
  deps.speak(text, voice, BROWSER_RATE, {
    start: () => {
      if (over()) return;
      started = true;
      deps.clearTimer(watchdog);
      if (current()) words?.start();
    },
    end: () => {
      if (over()) return;
      if (started) finish(true);
      else fallBack();
    },
    error: (code) => {
      if (over()) return;
      // Part of it was said: the part ends here, the next one goes on.
      if (started || !current()) return finish(false);
      if (INTERRUPTED.has(code)) return finish(false);
      fallBack();
    },
    boundary: (charIndex, name) => {
      if (!over() && current()) words?.boundary(charIndex, name);
    },
  });
  if (!started && !over()) watchdog = deps.setTimer(fallBack, START_TIMEOUT_MS);
}
