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
 *   the cloud cannot voice is read by speechSynthesis instead. With
 *   "speech", a sentence in a language the device has no voice for (some
 *   Android Chromes list no voices at all) goes to the cloud instead of
 *   staying silent.
 * - Mic on: every reply is read, whatever the speaker toggle or focus says
 *   (the toggle itself is never changed, so it is "restored" when the mic
 *   stops). Mic off, on a phone (touch, `touch`): the speaker toggle alone
 *   decides (owner 2026-11-10: the focus rule needed the keyboard up, so a
 *   reader on /reader heard nothing). Mic off, on a computer: a reply is
 *   read with the toggle on, and either the mic has been used on this device
 *   (sticky, `voiced`, localStorage: replies to typed lines are read too,
 *   owner 2026-11-04; an iOS PWA relaunch clears sessionStorage, so it is no
 *   longer kept there) or the chat input is focused in a visible tab (the
 *   focus rule). Sticky means no time window: it lasts until he mutes (the
 *   toggle off clears it, `unvoice`); his mute always wins.
 * - Echo (`lk:voice-aec`, default on): the mic stays open while the agent
 *   speaks — echo cancellation, then the text guard (echo.ts) drops what
 *   leaks through. The user speaking over the agent ducks it to DUCK_LEVEL;
 *   speech that goes on for BARGE_IN_MS (and sounds like speech: isBargeIn)
 *   is a barge-in and pauses the reading. With `lk:voice-aec` = "0", the old
 *   way: `hold` is true while an utterance plays (and RESUME_TAIL_MS after),
 *   and the mic holds its capture. With "0" and flag `voice.talk-over`
 *   (`talkOver`, aec.ts): no hold and no ducking; each transcript, partial or
 *   final, is judged by time and text together (`duplexHeard`): it overlaps a
 *   sentence Li was playing and its words are inside that sentence = her echo,
 *   dropped; else, heard while she reads = his, and the reading pauses as for
 *   a barge-in (resumed by the same rules).
 * - An interruption (a barge-in, a tap on the mic, typing) stops the utterance
 *   and remembers where: the clip's time (cloud), else the last word boundary
 *   the browser reported, else the start of that sentence. Speech or a tap
 *   resumes once the user's line was sent, or after IDLE_RESUME_MS of quiet;
 *   typing waits for a send or (mic on) a blur. `stop()` clears the queue.
 * - Cutting in (docs/dev-debug-widget.md, "Supersede and interject"), only
 *   for a line that arrives live (`how.live`; history and resumes never):
 *   `cut: "supersede"` stops the sentence being read if it is the same
 *   sender's (speakerOf: its lane, else its token's name or agent id, else
 *   main), drops that sender's queued sentences, and is read next; other
 *   senders' sentences and anything already read are untouched.
 *   `cut: "interject"` pauses the sentence being read (any sender) where it
 *   got to, is read next, then that sentence goes on from there; nothing is
 *   dropped, and interjections in a row are read in arrival order first.
 *
 * Everything browser-shaped is injected, so this is tested with fakes
 * (unit/voice-session.test.ts). Event-driven only: utterance and clip
 * events and one-shot timers, never polling.
 */
import { speechRate } from "./speech-rate";
import { ECHO_WINDOW_MS, type EchoScore, echoContained, echoScore, normalizeEcho } from "./echo";
import { cloudOut, cloudSkip, existingCtx, outMode } from "./voice-out";
import { type HeardVoice, noteHeard } from "./voice-heard";
import { micAec, talkOver } from "./aec";
import { pickLang, pickVoice } from "./wire";
import { speakForm } from "./lexicon";
import { type Silence, type SpeakMeta, dropRetiredKeys, silenceHere } from "./speak-rules";
import { getKey } from "./storage-keys";
import { hideStops, isDesktop } from "./voice-bg";
import { reportPageError } from "./page-errors";
import { AUDIO_PRIO, audioOwner, audioOwnerId } from "./audio-claim";
import { outputBed } from "./output-bed";
import {
  type LineVoice,
  type VoiceId,
  cloudVoicesOn,
  findDeviceVoice,
  isProviderVoice,
  langVoice,
  laneOf,
  lineVoiceOf,
  resolveVoices,
  voiceIdOf,
} from "./voices";

/** A line's own voice beyond the table (voices.ts parseLineVoice): device, melo, aura, eleven. */
export type LinePick = Exclude<LineVoice, { kind: "table" }>;

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
/**
 * A sentence read by speechSynthesis on a device with no voice for its
 * language that has not started after this long is given up on: Chrome on
 * Android with no voices installed may never fire start, end or error, and
 * the whole queue would wait behind it in silence (2026-11-03).
 */
export const SPEECH_START_MS = 8_000;
/**
 * A sentence handed to speechSynthesis that, this long after, has not started
 * and is neither speaking nor pending was dropped: iOS WebKit returns from
 * speak() with no event at all until the page has spoken once inside a tap
 * (SpeechSynthesis::speak, RequireUserGestureForSpeechStart). Every page load
 * starts locked, a debug device's reload after a deploy included, so a reply
 * on /reader with no tap on the chat waited behind it forever and nothing
 * after it was read either (2026-11-10). It is treated as refused: the
 * reading waits for the next tap anywhere (`unblock`), which unlocks speech.
 */
export const SPEECH_REFUSED_MS = 1_000;
/**
 * Who a line is from, for superseding: its lane (voices.ts laneOf: the field,
 * else a `【lane】` prefix), else a lane token's name, else its agent id,
 * else main (a line with none of them is the chat lane's, as voices.ts reads it).
 */
export function speakerOf(meta: SpeakMeta | undefined, said: string): string {
  const lane = laneOf({ lane: meta?.lane, text: said }).lane;
  if (lane) return `lane:${lane}`;
  if (typeof meta?.tokenLane === "string" && meta.tokenLane) return `token:${meta.tokenLane}`;
  if (typeof meta?.agentId === "string" && meta.agentId) return `agent:${meta.agentId}`;
  return "lane:main";
}

/** How a reply reached the page: `live` = a chat frame just now (not history, not a resume). */
export type ReplyHow = { live?: boolean };

/** A line's cut-in mode (wire.ts ChatMessage.cut), only when it arrived live. */
export function cutOf(meta: SpeakMeta | undefined, how?: ReplyHow): "supersede" | "interject" | null {
  if (how?.live !== true) return null;
  return meta?.cut === "supersede" || meta?.cut === "interject" ? meta.cut : null;
}

/**
 * Talk-over (`duplexHeard`): a sentence counts as playing during an utterance
 * when their times overlap with this much slack each side (the room's echo,
 * the VAD's frames, the output's latency).
 */
export const TALK_OVER_SLACK_MS = 600;
/**
 * …and the utterance is her echo when at least this share of its words (as
 * n-grams, echo.ts echoContained) is inside the sentences playing then.
 */
export const TALK_OVER_ECHO = 0.6;
/** Sentences are cut to at most this many characters (the TTS route's limit). */
export const CHUNK_MAX = 200;
/** localStorage: the speaker toggle ("0" = replies silent). */
export const SPEAK_KEY = "lk:debug-chat-speak";
/** localStorage (this device): "1" once the mic was used here, until he mutes (sticky read-aloud). */
export const VOICED_KEY = "lk:agent:voiced";
/** A reply with the same text within this long is a re-delivery, not a new one. */
export const REPLY_DEDUPE_MS = 10 * 60_000;
/** globalThis key of the shared session. */
const KEY = "__lkVoice";
/** The session's version: a copy on the page with another one is replaced. */
const V = 7;

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

/**
 * Milliseconds per character at rate 1, by script class: how long
 * speechSynthesis takes to read (the same speeds as SPEECH_CPS). A
 * character of no listed class, spaces and marks included, is `other`.
 */
export const SPEECH_CHAR_MS = {
  cjk: 1000 / SPEECH_CPS.cjk,
  other: 1000 / SPEECH_CPS.other,
} as const;
/** Script classes by character, first match wins (the rest: `other`). */
export const SPEECH_SCRIPTS: readonly (readonly [RegExp, keyof typeof SPEECH_CHAR_MS])[] = [
  [CJK_TEXT, "cjk"],
];
/** How long speechSynthesis should take to read `text` at `rate` (no audio to measure). */
export function speechMs(text: string, rate = 1): number {
  let ms = 0;
  for (const ch of text) {
    const cls = SPEECH_SCRIPTS.find(([re]) => re.test(ch))?.[1] ?? "other";
    ms += SPEECH_CHAR_MS[cls];
  }
  return ms / Math.max(0.1, rate);
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
  /** The reading speed (speech-rate.ts); `utter` may set a factor first (a lane's last resort). */
  rate?: number;
  onend: ((e?: unknown) => void) | null;
  onerror: ((e?: unknown) => void) | null;
  /** The browser began speaking it (the latency record's t_audible). */
  onstart?: ((e?: unknown) => void) | null;
  onboundary: ((e: { charIndex: number; name?: string }) => void) | null;
  /** The device voice it is read in (absent or null: the device's default). */
  voice?: { name?: string } | null;
};
export type SynthLike = {
  speak(u: UtterLike): void;
  cancel(): void;
  /** speechSynthesis.speaking / .pending: both false right after speak() = it was dropped. */
  speaking?: boolean;
  pending?: boolean;
};

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
  /** The concrete voice it is read in, once known (voice-heard.ts: the line's details). */
  onvoice?(v: HeardVoice): void;
  /** How long it should take, once known; again if a better figure comes later. */
  ontiming?(t: ReadTiming): void;
};
/**
 * A sentence's expected reading time, as of when it is told: `ms` still to
 * go, at the reading speed, and the share `done` already behind it (a
 * sentence resumed part-way). From the clip's length (audio), or an estimate
 * from its characters (speechSynthesis, speechMs).
 */
export type ReadTiming = { ms: number; done: number };
/** The cloud output (voice-out.ts createCloudOut). */
export type CloudOut = {
  /** `written`: a provider voice's text before the lexicon (the server writes it as SSML). */
  prepare?(text: string, lang: string, voice?: VoiceId, pick?: LinePick, written?: string): void;
  play(
    s: {
      text: string;
      /** A provider voice (google:, azure:) gets the written text; every fallback reads `text`. */
      written?: string;
      lang: string;
      at: number;
      volume: number;
      rate?: number;
      voice?: VoiceId;
      /** The line's own cloud voice (melo, aura) or ElevenLabs preview (eleven). */
      pick?: LinePick;
    },
    ev: PlayEvents,
  ): Playback;
};

export type VoiceState = {
  /** The mic is on (listening, loading or capturing). */
  mic: boolean;
  /** The mic was used on this device: replies are read with the toggle on, focused or not (sticky). */
  voiced?: boolean;
  /** A phone (touch): the speaker toggle alone decides, no focus needed. */
  touch?: boolean;
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
  /**
   * The browser refused to play (autoplay: no tap on this page since it
   * loaded): the reading waits for one tap (`unblock`), the chat shows a chip.
   */
  blocked?: boolean;
};

export type Why = "speech" | "tap" | "typing";
export type OutMode = "speech" | "cloud";

/**
 * `voice`: the line's voice (voices.ts), absent = main; `pick`: its own voice
 * beyond the table; `id`: the line it came from (its meta), so a withdrawn ask
 * can be dropped (`drop`).
 */
type Sentence = {
  /** As spoken (lexicon.ts). */
  text: string;
  /** As written, for a provider voice only (its server applies the lexicon as SSML). */
  written?: string;
  lang: string;
  from: number;
  at: number;
  voice?: VoiceId;
  pick?: LinePick;
  id?: string;
  /** Its line's sender (speakerOf), for superseding. */
  who?: string;
  /** From an interjecting line: read before the line it paused. */
  jump?: true;
};
/** What the agent said, and when (for the echo guard). */
type Said = { text: string; start: number; end?: number };

/** What the echo check says about one transcript. */
export type EchoCheck = EchoScore & {
  /** The agent was audible at some point during the utterance. */
  during: boolean;
};

export function createVoice(d: {
  synth: () => SynthLike | null;
  /**
   * A new utterance for `text` in `lang`, in `voice` (voices.ts; absent =
   * main), or in the device voice a `device:<name>` pick names when the device has it.
   */
  utter: (text: string, lang: string, voice?: VoiceId, pick?: LinePick) => UtterLike;
  /** The device has the voice a `device:<name>` names (voices.ts findDeviceVoice); absent: never. */
  hasDeviceVoice?: (name: string) => boolean;
  /** The speaker toggle. */
  enabled: () => boolean;
  /** The focus rule: this tab is visible and the chat input has focus. */
  here: () => boolean;
  /** Where "the mic was used here" is kept (localStorage in the page; memory if absent). */
  voiced?: { get(): boolean; set(on: boolean): void };
  /**
   * A phone or tablet (no fine pointer, voice-bg.ts isDesktop): the speaker
   * toggle alone decides, since the input is rarely focused there (the
   * keyboard would cover the page). Absent: false.
   */
  touch?: () => boolean;
  /** The cloud output, for `mode() === "cloud"`, and for a language speechSynthesis has no voice for. */
  cloud?: () => CloudOut | null;
  /** speechSynthesis has a voice for `lang` (absent: assume it has). */
  hasVoice?: (lang: string) => boolean;
  mode?: () => OutMode;
  /** Echo-cancelled barge-in (else capture is held while the agent speaks). */
  aec?: () => boolean;
  /**
   * Flag `voice.talk-over` (aec.ts talkOver): with `aec` off, no hold; what is
   * heard is judged by `duplexHeard` instead. Absent: off.
   */
  talkOver?: () => boolean;
  /** The reading speed, read for each utterance (speech-rate.ts; 1 if absent). */
  rate?: () => number;
  /** A silence the owner should hear about (a page-error, page-errors.ts). */
  report?: (message: string) => void;
  now?: () => number;
  log?: (ev: Record<string, unknown>) => void;
  setTimer?: (f: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  /**
   * The page's audio owner (audio-claim.ts, AUDIO_PRIO.li): claimed before
   * each sentence plays, so the reader or a word read aloud pauses first;
   * released once nothing is speaking (after the tail), so they go on.
   * When Li speaks is not changed by it.
   */
  owner?: { claim(): boolean; release(): void };
  /**
   * Asked before each sentence: ms to wait, so the output device is awake
   * (output-bed.ts `begin`). 0 once the bed has run long enough, or has none.
   */
  preroll?: () => number;
}) {
  const setTimer = d.setTimer ?? ((f, ms) => setTimeout(f, ms));
  const clearTimer = d.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  const now = d.now ?? (() => Date.now());
  const cloud = () => d.cloud?.() ?? null;
  const mode = (): OutMode => (d.mode?.() === "cloud" && cloud() ? "cloud" : "speech");
  const aec = () => d.aec?.() ?? true;
  /** Talk-over is in force: echo cancellation off, and the flag on. */
  const duplex = () => !aec() && (d.talkOver?.() ?? false);
  let log = d.log ?? (() => {});
  let mic = false;
  let voicedMem = false;
  const voiced = d.voiced ?? {
    get: () => voicedMem,
    set: (on: boolean) => void (voicedMem = on),
  };
  const touch = () => d.touch?.() ?? false;
  let speaking = false;
  const queue: Sentence[] = [];
  /** Replies queued lately, so a re-delivered one is not read twice. */
  const recent: { text: string; at: number }[] = [];
  /** Interruptions under way; the reading waits while any is. */
  const pauses = new Set<Why | "blocked">();
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
  /** The user's utterance under way (VAD start to end), and when it began (talk-over's window). */
  let talking = false;
  let talkFrom = 0;
  const said: Said[] = [];
  const subs = new Set<(s: VoiceState) => void>();
  /** Told each time a sentence starts playing (latency.ts). */
  const starts = new Set<() => void>();
  /** Told how long the sentence playing should take (the chat's reading sweep, read-sweep.ts). */
  const timings = new Set<(t: ReadTiming) => void>();
  /** Told the line ids whose unread sentences a superseding line dropped (the chat's read mirror). */
  const drops = new Set<(ids: string[]) => void>();
  /** Told where an interjecting line's sentences went into the queue (the chat's read mirror). */
  const jumps = new Set<(j: { id: string; n: number; at: number }) => void>();

  const state = (): VoiceState => ({
    mic,
    voiced: voiced.get(),
    touch: touch(),
    speaking,
    hold: speaking && !aec() && !duplex(),
    ducked: !!duck,
    queued: queue.length,
    paused: pauses.size > 0,
    blocked: pauses.has("blocked"),
  });
  const emit = () => {
    if (!speaking) d.owner?.release();
    const s = state();
    for (const f of subs) f(s);
  };
  /** Mic off: the toggle on, and a phone, the mic used here (sticky) or the focus rule. */
  const focusRule = () => d.enabled() && (touch() || voiced.get() || d.here());
  /** Nothing on this device can read `lang`: no speechSynthesis, or no voice for it. */
  const noVoice = (lang: string) => !d.synth() || (d.hasVoice ? !d.hasVoice(lang) : false);
  /**
   * The cloud output when a sentence in `lang` goes there: always in cloud
   * mode; in speech mode when the device has no voice for it and the cloud
   * can voice that language.
   */
  const routeFor = (lang: string, pick?: LinePick, voice?: VoiceId): CloudOut | null => {
    // A line's own voice (voices.ts, "A line's own voice") wins over the output mode:
    // a device voice the device has is read with speech even in cloud mode…
    if (pick?.kind === "device" && devicePick(pick)) return null;
    const c = cloud();
    if (!c) return null;
    // …and a cloud, local (Kokoro neko) or ElevenLabs one goes to the cloud/audio route even in speech mode.
    if (pick && pick.kind !== "device") return c;
    if (voice === "bright" && getKey("lk:agent-local-tts") !== "off") return c;
    if (mode() === "cloud") return c;
    return noVoice(lang) && cloudSkip("x", lang) === null ? c : null;
  };
  /** A `device:<name>` this device can read (speechSynthesis and that voice). */
  const devicePick = (pick?: LinePick) =>
    pick?.kind === "device" && !!d.synth() && !!d.hasDeviceVoice?.(pick.name);
  /** Fetch a sentence's clip ahead, when the cloud will read it. */
  const prepare = (s: Sentence) => {
    if (s.pick?.kind === "eleven") return;
    routeFor(s.lang, s.pick, s.voice)?.prepare?.(
      s.text,
      s.lang,
      s.voice,
      s.pick && s.pick.kind !== "device" ? s.pick : undefined,
      s.written,
    );
  };
  /**
   * A text's sentences (each at most CHUNK_MAX), in `voice` and `pick`, as
   * they are spoken: terms in their spoken form (lexicon.ts; the chat line on
   * screen keeps the written one). Sentences are cut from the written text,
   * so a spoken form never moves a sentence break; chunks from the spoken
   * one, so a longer spoken form still fits CHUNK_MAX. A provider voice
   * (google:, azure:) also keeps each chunk as written: its server writes the
   * lexicon as SSML, phonemes included.
   */
  const toSentences = (text: string, lang: string, voice?: VoiceId, pick?: LinePick): Sentence[] =>
    sentences(text)
      .flatMap((s): { text: string; written?: string }[] =>
        isProviderVoice(pick)
          ? chunk(s).map((w) => ({ text: speakForm(w, lang), written: w }))
          : chunk(speakForm(s, lang)).map((t) => ({ text: t })),
      )
      .map((t) => ({
        ...t,
        lang,
        from: 0,
        at: 0,
        ...(voice ? { voice } : {}),
        ...(pick ? { pick } : {}),
      }));
  const canSpeak = () => !!d.synth() || !!cloud();

  const ended = () => {
    if (current && current.said.end === undefined) current.said.end = now();
  };

  /** Read one sentence with speechSynthesis (from its last word boundary). */
  const speech = (head: Sentence, ev: PlayEvents, e: number): Playback | null => {
    const s = d.synth();
    if (!s) return null;
    const from = head.from;
    const own = devicePick(head.pick) ? head.pick : undefined;
    const u = d.utter(head.text.slice(from), head.lang, head.voice, own);
    // iOS cannot change it mid-utterance: a duck applies from the next sentence.
    if (level !== 1) u.volume = level;
    // The speed, as set now: a change applies from the next utterance.
    u.rate = Math.min(10, (d.rate?.() ?? 1) * (u.rate ?? 1));
    u.onboundary = (b) => {
      if (e !== epoch || !current) return;
      if (b.name && b.name !== "word") return;
      current.mark = from + Math.max(0, b.charIndex | 0);
    };
    // No voice for this language here: it may stay silent with no event at all.
    let watch: unknown =
      !own && noVoice(head.lang)
      ? setTimer(() => {
          if (e !== epoch) return;
          log({ ev: "voice-stuck", route: "speech", lang: head.lang, ms: SPEECH_START_MS });
          d.report?.(`voice-out: speechSynthesis never started (${head.lang}, no voice); sentence skipped`);
          // Its late events must not move the queue again: they are dropped, and it is cancelled.
          u.onend = u.onerror = u.onstart = u.onboundary = null;
          s.cancel();
          ev.onerror();
        }, SPEECH_START_MS)
      : undefined;
    // Dropped without an event (iOS before the page's first tap): refused, wait for a tap.
    // (Only where the engine says whether it is speaking: a fake in a test may not.)
    let refused: unknown =
      typeof s.speaking === "boolean"
        ? setTimer(() => {
            refused = undefined;
            if (e !== epoch || s.speaking !== false || s.pending !== false) return;
            log({ ev: "voice-refused", route: "speech", lang: head.lang, ms: SPEECH_REFUSED_MS });
            settle();
            u.onend = u.onerror = u.onstart = u.onboundary = null;
            ev.onfail?.("speech NotAllowedError (dropped: no tap on this page yet)");
          }, SPEECH_REFUSED_MS)
        : undefined;
    const settle = () => {
      clearTimer(watch);
      watch = undefined;
      clearTimer(refused);
      refused = undefined;
    };
    u.onend = () => (settle(), ev.onend());
    u.onerror = (x) => {
      settle();
      // Chrome refuses speak() before any tap on the page: wait for one, as for a refused clip.
      if ((x as { error?: string } | undefined)?.error === "not-allowed")
        return ev.onfail?.("speech NotAllowedError");
      ev.onerror();
    };
    u.onstart = () => {
      settle();
      ev.onstart?.();
      // No clip to measure: estimated from its characters at this utterance's speed.
      const all = speechMs(head.text);
      ev.ontiming?.({
        ms: speechMs(head.text.slice(from), u.rate ?? 1),
        done: all > 0 ? speechMs(head.text.slice(0, from)) / all : 0,
      });
    };
    ev.onvoice?.({ name: u.voice?.name ? `device:${u.voice.name}` : "device" });
    s.speak(u);
    return {
      route: "speech",
      stop: () => {
        settle();
        s.cancel();
        return {};
      },
      volume: () => {},
    };
  };

  /** Waiting out the pre-roll: the first sentence comes when it fires. */
  let preroll: unknown = null;
  /** Speak the head of the queue, if nothing is playing and nothing waits (the caller emits). */
  const next = () => {
    if (current || preroll !== null || pauses.size || !canSpeak()) return;
    const head = queue[0];
    if (!head) return;
    const wait = d.preroll?.() ?? 0;
    if (wait > 0) {
      // A stop or an interruption meanwhile: this finds nothing to say, or a pause.
      preroll = setTimer(() => {
        preroll = null;
        next();
        emit();
      }, wait);
      return;
    }
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
      ontiming: (t) => {
        if (e !== epoch) return;
        for (const f of timings) f(t);
      },
      onend: done,
      onerror: done,
      onvoice: (v) => {
        if (e === epoch) noteHeard(head.id, head.text, v);
      },
      onfail: (reason) => {
        if (e !== epoch || !current) return;
        if (head.pick?.kind === "eleven") {
          // The preview could not play (refused, blocked, gone): the line is read in
          // its lane's voice instead, sentence by sentence. Never silence.
          log({ ev: "voice-out", out: "eleven", route: "lane", fallback: reason, ...info });
          epoch++;
          ended();
          current = null;
          queue.splice(
            0,
            1,
            ...toSentences(head.text, head.lang, head.voice).map((x) => ({
              ...x,
              ...(head.id ? { id: head.id } : {}),
              ...(head.who ? { who: head.who } : {}),
              ...(head.jump ? { jump: true as const } : {}),
            })),
          );
          next();
          emit();
          return;
        }
        const refused = /NotAllowed/.test(reason);
        // Refused by the browser with nothing else that could read it (or the
        // speech fallback refused too): keep the sentence and wait for a tap.
        if (refused && (current.p.route === "speech" || noVoice(head.lang))) return block(reason);
        if (noVoice(head.lang)) {
          // The fallback would be silent (no voice here) and might never end: skip it, and say so.
          log({ ev: "voice-out", out: "cloud", route: "none", fallback: reason, ...info });
          d.report?.(`voice-out: cloud could not read a sentence (${reason}); no speech voice, skipped`);
          return done();
        }
        log({ ev: "voice-out", out: "cloud", route: "speech", fallback: reason, ...info });
        const p = speech(head, ev, e);
        if (!p) return done();
        current.p = p;
      },
    };
    /** The browser refused to play: drop this try, keep the sentence, wait for a tap (unblock). */
    const block = (reason: string) => {
      epoch++;
      ended();
      current = null;
      clearTimer(tail);
      speaking = false;
      const first = !pauses.has("blocked");
      pauses.add("blocked");
      log({ ev: "voice-blocked", reason, ...info });
      if (first) d.report?.(`voice-out: playback blocked (${reason}); waiting for a tap to resume reading`);
      emit();
    };
    const rec: Said = { text: head.text, start: now() };
    // Before a sound of ours: the reader and word read-aloud pause now (never refused: Li ranks first).
    d.owner?.claim();
    const c = routeFor(head.lang, head.pick, head.voice);
    current = { p: null as unknown as Playback, mark: head.from, said: rec };
    const p = c
      ? c.play(
          {
            text: head.text,
            ...(head.written !== undefined ? { written: head.written } : {}),
            lang: head.lang,
            at: head.at,
            volume: level,
            rate: d.rate?.() ?? 1,
            ...(head.voice ? { voice: head.voice } : {}),
            ...(head.pick && head.pick.kind !== "device" ? { pick: head.pick } : {}),
          },
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
      // Speech mode, but no voice here for this language: the cloud reads it.
      ...(c && mode() !== "cloud" && !head.pick ? { fallback: "no-voice" } : {}),
      // The line's own voice: its kind only (a device voice's name stays on the page).
      ...(head.pick ? { pick: head.pick.kind, ...(head.pick.kind === "device" && !devicePick(head.pick) ? { missing: true } : {}) } : {}),
      ...info,
      volume: level,
      at: head.at || undefined,
      from: head.from || undefined,
    });
    // Fetch the next one while this plays.
    if (queue[1]) prepare(queue[1]);
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

  /**
   * Superseded: `who`'s sentence being read stops (not kept to resume) and
   * its queued ones go; nothing else changes. The caller moves the queue on
   * and emits. Returns how many sentences went.
   */
  const cut = (who: string): number => {
    const before = queue.length;
    const playing = !!current || preroll !== null;
    if (playing && queue[0]?.who === who) {
      halt(false);
      clearTimer(preroll);
      preroll = null;
    }
    const ids = new Set<string>();
    for (let i = queue.length - 1; i >= 0; i--) {
      const q = queue[i]!;
      // A sentence playing for another sender stays at the head; only `who`'s go.
      if (q.who !== who || (i === 0 && current)) continue;
      if (q.id) ids.add(q.id);
      queue.splice(i, 1);
    }
    const n = before - queue.length;
    if (!n) return 0;
    log({ ev: "voice-supersede", sentences: n });
    // Before any emit: the mirror drops these lines, so a fall of more than one is not "Stop reading".
    const list = [...ids];
    if (list.length) for (const f of drops) f(list);
    return n;
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
    /** `f` hears how long the sentence playing should take (after its start; again if refined). */
    onTiming(f: (t: ReadTiming) => void) {
      timings.add(f);
      return () => void timings.delete(f);
    },
    /** `f` hears where an interjecting line's sentences were put in the queue (read-progress mirror). */
    onInterject(f: (j: { id: string; n: number; at: number }) => void) {
      jumps.add(f);
      return () => void jumps.delete(f);
    },
    /** `f` hears the line ids a superseding line dropped from the queue (read-progress mirror). */
    onDrop(f: (ids: string[]) => void) {
      drops.add(f);
      return () => void drops.delete(f);
    },
    /**
     * A superseding line from `who` (speakerOf) that is not read itself (a
     * quiet one): `who`'s reading stops and its queued lines go. False: none.
     */
    supersede(who: string): boolean {
      if (!cut(who)) return false;
      next();
      emit();
      return true;
    },
    /** Where the debug events go (DebugEval passes devLog). */
    setLog(f: (ev: Record<string, unknown>) => void) {
      log = f;
    },
    log: (ev: Record<string, unknown>) => log(ev),
    /** The output in use: "speech" or "cloud". */
    mode,
    aec,
    /** Talk-over is in force (echo cancellation off, flag `voice.talk-over` on): no hold. */
    duplex,
    /** Whether a reply arriving now is read: always with the mic on, else by the toggle and (mic used here, or focus). */
    shouldSpeak: () => mic || focusRule(),
    /** The speaker toggle as it applies now (forced on while the mic is on). */
    readAloud: () => mic || d.enabled(),
    /** The mic turned on or off. Off: what the focus rule would not read stops. */
    setMic(on: boolean) {
      if (mic === on) return;
      mic = on;
      // Using the mic turns spoken replies on in this tab until he mutes (sticky).
      if (on && !voiced.get()) voiced.set(true);
      if (!on && !focusRule()) return api.stop();
      emit();
    },
    /**
     * A reply arrived live: queue its sentences (if it should be read),
     * behind what is still being read (a reply arriving while the reading is
     * paused waits for it). The same reply delivered again (a reconnect
     * re-sending it) is not read again from its start. `meta` is the line
     * itself (its id, quiet); voice() gates on it (gateVoice) first. With
     * `how.live` (a chat frame, never history) a `cut: "supersede"` line
     * first cuts its sender's reading (`cut`); a `cut: "interject"` one
     * pauses the sentence being read and goes in before the rest.
     */
    reply(said: string, meta?: SpeakMeta, how?: ReplyHow): boolean {
      const who = speakerOf(meta, said);
      const mode = cutOf(meta, how);
      const cutN = mode === "supersede" ? cut(who) : 0;
      /** Nothing queued for this line: still move on from what was cut. */
      const none = () => {
        if (cutN) {
          next();
          emit();
        }
        return false;
      };
      if (!canSpeak() || !api.shouldSpeak()) return none();
      // Its lane's voice; a `【lane】` prefix is not read out (voices.ts).
      const text = laneOf({ lane: meta?.lane, text: said }).text;
      const v = voiceIdOf({ voice: meta?.voice, lane: meta?.lane, text: said });
      const voice = v === "main" ? undefined : v;
      // Its own voice beyond the table (device:, melo:, aura:, eleven:, google:, azure:);
      // anything else: none. A provider voice only where they are on (voices.ts setCloudVoices).
      const own = lineVoiceOf(meta?.voice);
      const named = isProviderVoice(own) && !cloudVoicesOn() ? undefined : own;
      const t = now();
      // The same words in another voice are another line (a voice demo), not a re-delivery.
      const key = `${typeof meta?.voice === "string" ? meta.voice : v}\n${text}`;
      if (recent.some((r) => r.text === key && t - r.at < REPLY_DEDUPE_MS)) {
        log({ ev: "voice-reply-dup", chars: text.length });
        return none();
      }
      recent.push({ text: key, at: t });
      while (recent.length > 20) recent.shift();
      const lang = pickLang(text);
      // No voice of its own: the language → voice map's provider voice, if any (config voice.langVoices).
      const pick = named ?? (meta?.voice === undefined ? langVoice(lang) : undefined);
      // An ElevenLabs preview stands for the whole line: one item, its text kept for a fallback.
      const idOf = { ...(typeof meta?.id === "string" ? { id: meta.id } : {}), who };
      const add = (
        pick?.kind === "eleven" && cloud() && text.trim()
          ? [{ text, lang, from: 0, at: 0, ...(voice ? { voice } : {}), pick }]
          : toSentences(text, lang, voice, pick?.kind === "eleven" ? undefined : pick)
      ).map((s) => ({ ...s, ...idOf, ...(mode === "interject" ? { jump: true as const } : {}) }));
      if (!add.length) return none();
      if (mode === "interject" && queue.length) {
        // Interject: the sentence being read pauses where it got to (kept at
        // the head), unless it is an interjection itself; this line goes in
        // after any interjections already waiting, before everything else.
        if (current && !queue[0]!.jump) halt(true);
        let at = 0;
        while (at < queue.length && queue[at]!.jump) at++;
        if (at === 0) prepare(add[0]!);
        queue.splice(at, 0, ...add);
        log({ ev: "voice-interject", sentences: add.length, at });
        // Before any emit: the mirror puts them at the same place (not at the end).
        if (typeof meta?.id === "string") for (const f of jumps) f({ id: meta.id, n: add.length, at });
        next();
        emit();
        return true;
      }
      if (!queue.length) prepare(add[0]!);
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
      talking = true;
      talkFrom = now();
      // Talk-over: the VAD fires on her own voice too; the transcript decides (duplexHeard).
      if (duplex()) return;
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
      talking = false;
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
    /** A tap after playback was refused (the chat's chip, or any tap on the page): read on. */
    unblock() {
      if (!pauses.delete("blocked")) return;
      log({ ev: "voice-unblocked" });
      next();
      emit();
    },
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
     * Talk-over (`duplex()`): judge a transcript heard from `from` to `to`
     * (page clock; a partial too) by time AND text. The sentences Li was
     * playing then (overlap, TALK_OVER_SLACK_MS each side) are the only
     * candidates: when at least TALK_OVER_ECHO of its words are inside them,
     * it is her echo (`drop`). The same words at another time are his. Not
     * her echo, heard while she is reading: his speech, so the reading pauses
     * as a barge-in does (`paused`), and goes on by the usual rules (his line
     * sent, or IDLE_RESUME_MS after his speech ends).
     */
    duplexHeard(transcript: string, from: number, to: number): EchoCheck & { paused: boolean } {
      const t = now();
      const playing = said.filter(
        (r) => r.start <= to + TALK_OVER_SLACK_MS && (r.end ?? t) + TALK_OVER_SLACK_MS >= from,
      );
      const during = playing.length > 0;
      const words = normalizeEcho(transcript) !== "";
      const score = during && words ? echoContained(transcript, playing.map((r) => r.text)) : 0;
      const drop = during && words && score >= TALK_OVER_ECHO;
      const out = {
        score: Math.round(score * 1000) / 1000,
        against: drop ? playing.map((r) => r.text).join(" ") : null,
        drop,
        during,
        paused: false,
      };
      if (drop || !words || !duplex() || !current || !during) return out;
      log({ ev: "voice-talk-over", score: out.score, chars: transcript.length });
      api.interrupt("speech");
      // His speech already ended (a final arrives after it): read on after the quiet, as userIdle would.
      if (!talking) {
        clearTimer(idle);
        idle = setTimer(resume, IDLE_RESUME_MS);
      }
      return { ...out, paused: true };
    },
    /** Talk-over: the interim text of his utterance under way (mic-session `interim`). */
    heardInterim(text: string) {
      if (!duplex() || !current || !talking) return;
      api.duplexHeard(text, talkFrom, now());
    },
    /**
     * A transcript was the agent's own echo (echoCheck): a barge-in it caused
     * was no barge-in, so the reading goes on now rather than after the idle.
     */
    echoDropped() {
      if (pauses.size === 1 && pauses.has("speech")) resume();
    },
    /** The mic was used in this tab (sticky read-aloud). */
    voiced: () => voiced.get(),
    /** He muted read-aloud: the sticky "mic used here" ends with it (the mic itself is not touched). */
    unvoice() {
      if (!voiced.get()) return;
      voiced.set(false);
      emit();
    },
    /**
     * Drop line `id`'s sentences (an ask withdrawn while queued or playing):
     * stopped if it is playing; the other lines read on. False: none queued.
     */
    drop(id: string): boolean {
      const before = queue.length;
      if (current && queue[0]?.id === id) halt(false);
      for (let i = queue.length - 1; i >= 0; i--) if (queue[i]!.id === id) queue.splice(i, 1);
      if (queue.length === before) return false;
      log({ ev: "voice-drop", sentences: before - queue.length });
      next();
      emit();
      return true;
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
const GATE_V = 3;
/** How many unread line ids are kept (the note under each). */
const UNHEARD_MAX = 50;

/** Lines kept silent because the page was hidden, and the newest of them still to read. */
export type Unheard = {
  /** Ids of lines not read aloud because the page was in the background. */
  ids: ReadonlySet<string>;
  subscribe(f: () => void): () => void;
};
type Missed = { text: string; meta: SpeakMeta };
type Gated = Voice & {
  __gate?: number;
  __rawReply?: Voice["reply"];
  __unheard?: Unheard & { add(id: string): void; drop(id: string): void };
  __missed?: Missed | null;
  /** Read the newest line missed while hidden, once (on visible). */
  __readMissed?: () => void;
};

function unheardSet(): NonNullable<Gated["__unheard"]> {
  let ids = new Set<string>();
  const subs = new Set<() => void>();
  const set = (next: Set<string>) => {
    ids = next;
    for (const f of subs) f();
  };
  return {
    get ids() {
      return ids;
    },
    subscribe(f) {
      subs.add(f);
      return () => void subs.delete(f);
    },
    add(id) {
      if (ids.has(id)) return;
      const next = new Set(ids).add(id);
      while (next.size > UNHEARD_MAX) next.delete(next.values().next().value as string);
      set(next);
    },
    drop(id) {
      if (!ids.has(id)) return;
      const next = new Set(ids);
      next.delete(id);
      set(next);
    },
  };
}

/**
 * Speak rules (speak-rules.ts): wrap the session's `reply` so a hidden page
 * or a quiet line keeps it silent. It wraps the shared session object
 * itself, so a deployed copy of this module calling `voice().reply(text)`
 * (no meta) gets the hidden rule from a hot-loaded widget too. Hiding the
 * page stops the reading under way; showing it again reads the newest line
 * that arrived while hidden, once (not a backlog), and the lines left
 * unread are listed in `unheard()` for the chat's note.
 */
export function gateVoice(v: Voice, why: (m: SpeakMeta) => Silence | null = silenceHere): Voice {
  const s = v as Gated;
  if (s.__gate === GATE_V) return v;
  const raw = s.__rawReply ?? v.reply;
  s.__rawReply = raw;
  const unheard = (s.__unheard ??= unheardSet());
  s.__missed = null;
  s.reply = (text: string, meta?: SpeakMeta, how?: ReplyHow) => {
    const m = meta ?? {};
    const silence = why(m);
    const id = typeof m.id === "string" ? m.id : null;
    if (silence) {
      v.log({ ev: "voice-silent", why: silence });
      // A quiet superseding line still cuts its sender's reading; it reads nothing itself.
      if (silence === "quiet" && cutOf(m, how) === "supersede")
        (v as Partial<Voice>).supersede?.(speakerOf(m, text));
      if (silence === "hidden") {
        s.__missed = { text, meta: m };
        if (id) unheard.add(id);
      }
      return false;
    }
    const read = raw(text, meta, how);
    if (read && id) unheard.drop(id);
    return read;
  };
  s.__readMissed = () => {
    const m = s.__missed;
    s.__missed = null;
    if (!m) return;
    v.log({ ev: "voice-missed", chars: m.text.length });
    // Through the gate again (the page is visible now); a line read loses its note there.
    s.reply(m.text, m.meta);
  };
  s.__gate = GATE_V;
  const g = globalThis as unknown as Record<string, unknown>;
  if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
    if (!g.__lkVoiceHide) {
      g.__lkVoiceHide = true;
      document.addEventListener("visibilitychange", () => {
        // A phone stops reading on hide; a computer reads on in the background (voice-bg.ts).
        if (document.visibilityState === "hidden" && hideStops(isDesktop()))
          (g[KEY] as Voice | undefined)?.stop();
      });
    }
    if (!g.__lkVoiceShow) {
      g.__lkVoiceShow = true;
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") (g[KEY] as Gated | undefined)?.__readMissed?.();
      });
    }
    if (!g.__lkVoiceRetired) {
      g.__lkVoiceRetired = true;
      dropRetiredKeys();
    }
  }
  return v;
}

/** The lines on this page not read aloud because it was hidden (for the chat's note). */
export function unheard(v: Voice = voice()): Unheard {
  const s = gateVoice(v) as Gated;
  return s.__unheard ?? (s.__unheard = unheardSet());
}

/** VOICED_KEY in localStorage, guarded (private mode, sandboxed frames throw). */
const voicedStore = {
  get: () => {
    try {
      return localStorage.getItem(VOICED_KEY) === "1";
    } catch {
      return false;
    }
  },
  set: (on: boolean) => {
    try {
      if (on) localStorage.setItem(VOICED_KEY, "1");
      else localStorage.removeItem(VOICED_KEY);
    } catch {}
  },
};

/** The session, shared by every copy of this module on the page. */
export function voice(): Voice {
  const g = globalThis as unknown as Record<string, Voice | undefined>;
  const have = g[KEY];
  if (have && have.v === V) return gateVoice(have);
  const v = createVoice({
    synth,
    enabled: speechEnabled,
    here: speakHere,
    voiced: voicedStore,
    touch: () => !isDesktop(),
    cloud: cloudOut,
    // getVoices() can be empty (some Android Chromes always): the cloud reads those.
    hasVoice: (lang) => {
      try {
        return !!pickVoice(speechSynthesis.getVoices(), lang);
      } catch {
        return false;
      }
    },
    mode: outMode,
    preroll: () => outputBed().begin(),
    owner: audioOwner({ id: audioOwnerId("li"), prio: AUDIO_PRIO.li }),
    // The open track's mode (aec.ts), so hold and barge-in match what the mic does.
    aec: micAec,
    // Flag voice.talk-over: with echo cancellation off, no hold (duplexHeard judges instead).
    talkOver,
    rate: () => speechRate(),
    report: (message) => reportPageError({ kind: "media", message }),
    hasDeviceVoice: (name) => {
      try {
        return !!findDeviceVoice(speechSynthesis.getVoices(), name);
      } catch {
        return false;
      }
    },
    utter: (text, lang, id, pick) => {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = lang;
      const voices = speechSynthesis.getVoices();
      // The line's own device voice, as it is (no pitch or speed of a lane's).
      const own = pick?.kind === "device" ? findDeviceVoice(voices, pick.name) : undefined;
      if (own) {
        u.voice = own;
        u.lang = own.lang;
        alive.add(u);
        u.addEventListener("end", () => alive.delete(u));
        u.addEventListener("error", () => alive.delete(u));
        return u as unknown as UtterLike;
      }
      // Each lane its own voice model (voices.ts); main is the chat lane's cute voice.
      const r = resolveVoices(voices, lang, pickVoice)[id ?? "main"];
      if (r.voice) u.voice = r.voice;
      u.pitch = r.pitch;
      u.rate = r.rate;
      alive.add(u);
      u.addEventListener("end", () => alive.delete(u));
      u.addEventListener("error", () => alive.delete(u));
      return u as unknown as UtterLike;
    },
  });
  g[KEY] = v;
  // Leaving: the voice context stops too, unless the mic still runs on it.
  outputBed().onExit(() => {
    if (!v.state().mic) void existingCtx()?.suspend().catch(() => {});
  });
  return gateVoice(v);
}
