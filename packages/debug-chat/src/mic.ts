/**
 * The debug chat's mic, without the browser (docs/monitoring.md, "Mic"): a
 * listening mode in which a voice-activity detector cuts speech into
 * utterances, each one sent to /api/debug/stt as soon as it ends. Requests run
 * in parallel; transcripts are appended in the order spoken. A long utterance
 * also sends rolling partial chunks, whose text shows dimmed until the final
 * one replaces it. Nothing is sent as a chat message: the text lands in the
 * input, and the usual rules send it. The VAD, the upload and the timers are
 * injected, so all of this is tested with fakes (unit/mic.test.ts); MicButton.tsx
 * is the glue. Nothing here imports from the app.
 *
 * With a local streaming STT (local-stt.ts, the owner's Mac) the frames of
 * each utterance are streamed there as they are heard: its partials replace
 * the rolling chunks, and its final is handed to `upload` as `info.local`,
 * which falls back to /api/debug/stt when it fails.
 */
import type { UttMarks } from "./latency";
import type { LocalFinal, LocalUtt } from "./local-stt";
import { STT_PROMPTS } from "./stt-hint";
import type { WakeSpot } from "./wake";

/** Longest utterance: past this it is cut and sent, and listening goes on. */
export const MAX_UTTERANCE_MS = 30_000;
/** The VADs hand over 16 kHz mono. */
export const RATE = 16_000;
/** Partials: one every PARTIAL_EVERY_MS of speech, once it is PARTIAL_MIN_MS long… */
export const PARTIAL_EVERY_MS = 2_500;
export const PARTIAL_MIN_MS = 3_000;
/** …each chunk overlapping the one before by this much, so a word cut at its edge is heard whole. */
export const PARTIAL_OVERLAP_MS = 1_500;
/** Shown in the input for an utterance still being transcribed. */
export const PENDING_MARK = "…";
/** localStorage: the owner's dev server that keeps utterances (the sink URL only; the switch is the hub's, clips.ts). */
export { CLIP_SINK_KEY, clipSinkFrom } from "./clips";

export type MicState = "off" | "loading" | "listening" | "capturing";
/** What the button shows, from the state and the transcripts still out. */
export type MicStatus =
  | "idle"
  | "loading"
  | "listening"
  | "capturing"
  | "transcribing"
  | "speaking";

/**
 * `speaking`: the agent's reply is being read while the mic is on. Capturing
 * wins: with echo cancellation the user can talk over the agent.
 */
export function micStatus(state: MicState, pending: number, speaking = false): MicStatus {
  if (state === "capturing") return "capturing";
  if (speaking && state === "listening") return "speaking";
  if (pending > 0) return "transcribing";
  if (state === "off") return "idle";
  return state;
}

/** What a VAD must do. `flush` ends the current utterance now (the 30 s cap). */
export type Vad = {
  start(): Promise<void> | void;
  pause(): Promise<void> | void;
  flush(): Promise<void> | void;
  destroy(): Promise<void> | void;
};
export type VadEvents = {
  onSpeechStart(): void;
  /** One utterance, 16 kHz mono samples in [-1, 1]. */
  onSpeechEnd(samples: Float32Array): void;
  /** Speech seemed to start but was too short to keep. */
  onMisfire(): void;
  /**
   * Every frame heard (16 kHz), for the partials; only those while capturing
   * are kept. `prob`: the VAD's speech probability for it (Silero only).
   */
  onFrame?(frame: Float32Array, prob?: number): void;
};
export type VadFactory = (ev: VadEvents) => Promise<Vad>;

/** A non-2xx answer from /api/debug/stt. */
export class SttError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "SttError";
  }
}

const nameOf = (e: unknown) => (e as { name?: string } | null)?.name;

/** getUserMedia refused or found nothing: the fallback needs the mic too, so it is not tried. */
export function isMicDenied(e: unknown): boolean {
  const n = nameOf(e);
  return n === "NotAllowedError" || n === "SecurityError" || n === "NotFoundError";
}

/** The short note by the button for an error. */
export function micErrorNote(e: unknown): string {
  const n = nameOf(e);
  if (n === "NotAllowedError" || n === "SecurityError") return "Microphone permission denied";
  if (n === "NotFoundError") return "No microphone found";
  if (e instanceof SttError) {
    if (e.status === 401) return "Sign in to use the mic";
    if (e.status === 429) return "Too much speech for now; try again in a minute";
    return `Transcription failed (${e.status})`;
  }
  return `Mic: ${String((e as Error | null)?.message ?? e).slice(0, 100)}`;
}

/**
 * Utterances in flight, in the order they were spoken. `take()` hands back
 * the text of every finished one that has nothing unfinished before it.
 */
export class UtteranceQueue {
  private next = 0;
  private head = 0;
  private done = new Map<number, string | null>();
  private partials = new Map<number, string>();
  add(): number {
    return this.next++;
  }
  resolve(seq: number, text: string | null) {
    if (seq < this.head) return;
    this.done.set(seq, text);
    this.partials.delete(seq);
  }
  /** Interim text for one not yet resolved (ignored once it is). */
  partial(seq: number, text: string) {
    if (seq >= this.head && !this.done.has(seq)) this.partials.set(seq, text);
  }
  getPartial(seq: number): string {
    return this.partials.get(seq) ?? "";
  }
  /** Text now in order (failed ones are skipped), joined with joinText. */
  take(): string {
    let out = "";
    while (this.done.has(this.head)) {
      const t = this.done.get(this.head);
      this.done.delete(this.head++);
      if (t) out = joinText(out, t);
    }
    return out;
  }
  /** Utterances still being transcribed. */
  pending(): number {
    return this.next - this.head;
  }
  /**
   * What the input shows, dimmed, after the draft: for each utterance not yet
   * taken, its text (done, waiting on an earlier one), its partial, or
   * PENDING_MARK (one mark for a run of them).
   */
  interim(): string {
    let out = "";
    let mark = false;
    for (let s = this.head; s < this.next; s++) {
      const t = this.done.has(s) ? (this.done.get(s) ?? "") : this.partials.get(s) || PENDING_MARK;
      if (t === PENDING_MARK && mark) continue;
      mark = t === PENDING_MARK;
      out = joinText(out, t);
    }
    return out;
  }
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}。、！？]/u;

/** Append `b` to `a`: a space between them, except between CJK characters or at a line start. */
export function joinText(a: string, b: string): string {
  const t = b.trim();
  if (!t) return a;
  if (!a || /\s$/.test(a)) return a + t;
  return CJK.test(a.at(-1) as string) && CJK.test(t[0]) ? a + t : `${a} ${t}`;
}

/** A draft ending a sentence (any script's full stop, ! or ?). */
export const ENDS_SENTENCE = /[。．.!?！？]$/;
/**
 * Spoken (or IME-dictated) sentences go out at once from this many characters
 * (trimmed): typing arrives a character at a time, so 3 at once is dictation.
 */
export const AUTO_SEND_MIN = 3;

/**
 * Typed text that arrived at once (an outside dictation IME): AUTO_SEND_MIN
 * or more characters since the draft last settled, and the draft now ends a
 * sentence. Then it is sent at once.
 */
export function isDictationBurst(settledLen: number, draft: string): boolean {
  return draft.length - settledLen >= AUTO_SEND_MIN && ENDS_SENTENCE.test(draft.trim());
}

const QUESTION_CJK = /(?:吗|嗎|呢|么|麼|吧|か|かな|かしら|の|でしょう|ですか|ますか|니까|나요|까요)$/u;
const QUESTION_LATIN =
  /^(?:what|why|how|when|where|who|whom|whose|which|can|could|do|does|did|is|are|was|were|will|would|should|shall|may|might|have|has|had)\b/i;
const TRAILING_PUNCT = /[\p{P}\s]+$/u;

/**
 * Spoken text always ends a sentence ("auto-punctuate, then commit"): Whisper
 * usually adds the stop itself; when it doesn't, add one that fits the text —
 * 。/？ for CJK, ./? otherwise, a question by its particle or opening word.
 * Text that already ends in any punctuation (…, ～, quotes) is left alone.
 */
export function punctuate(text: string): string {
  const t = text.trim();
  if (!t || /[\p{P}～]$/u.test(t)) return t;
  const bare = t.replace(TRAILING_PUNCT, "");
  if (CJK.test(t)) return t + (QUESTION_CJK.test(bare) ? "？" : "。");
  return t + (QUESTION_LATIN.test(bare) ? "?" : ".");
}

/** Letters or digits in any script: something was actually said. */
const SPOKEN = /[\p{L}\p{N}]/u;

/**
 * A final transcript lands in the draft, punctuated, and is committed at once
 * (上屏 + send) whenever it carries any words — a short "好" or "OK" too.
 * Partials never come here; typing never does (see isDictationBurst).
 */
export function appendDictation(draft: string, text: string): { draft: string; send: boolean } {
  const said = punctuate(text);
  if (!said) return { draft, send: false };
  const next = joinText(draft, said);
  return { draft: next, send: SPOKEN.test(said) && ENDS_SENTENCE.test(next.trim()) };
}

/**
 * What Whisper says over silence or noise (its training subtitles' credits).
 * A final transcript that is one of these (once normalized, possibly
 * repeated) from a short or faint utterance is dropped (isHallucination).
 * `…` stands for anything.
 */
export const HALLUCINATIONS: readonly string[] = [
  "ご視聴ありがとうございました",
  "ご清聴ありがとうございました",
  "チャンネル登録よろしくお願いします",
  "おやすみなさい",
  "Thanks for watching",
  "Thank you for watching",
  "Please subscribe",
  "Subtitles by …",
  "字幕由…提供",
  "字幕製作…",
  "请不吝点赞 订阅 转发…",
  "請不吝點贊 訂閱 轉發…",
  "请不吝点赞订阅转发…",
  "谢谢观看",
  "謝謝觀看",
  "感谢观看",
  "感謝觀看",
  "感谢收看",
  "感謝收看",
  "谢谢收看",
  "謝謝收看",
  "谢谢您的观看",
  "謝謝您的觀看",
  "感谢您的观看",
  "感謝您的觀看",
  // "字幕志愿者 李宗盛" and the like: a subtitle credit (never 李宗盛 alone, a real name).
  "字幕志愿者…",
  "字幕志願者…",
  // "中文字幕提供", "字幕提供": a credit line on its own clause.
  "…字幕提供",
  "请订阅",
  "請訂閱",
  "订阅我的频道…",
  "訂閱我的頻道…",
  // Our own route's STT prompts, which cloud Whisper reads back as speech.
  ...STT_PROMPTS,
  "…明镜与点点栏目…",
  "…明鏡與點點欄目…",
  "Ondertiteling …",
  "Sous-titres réalisés par …",
];
/** Under this much speech an utterance is short enough to be one of those. */
export const HALLUCINATION_MAX_MS = 1_200;
/** Under this mean speech probability (Silero) an utterance is faint enough. */
export const HALLUCINATION_MIN_PROB = 0.5;
/** A frame at or over this probability counts as speech, for the speech length. */
export const SPEECH_FRAME_PROB = 0.5;

/** For matching: NFKC, lowercased, without punctuation, symbols or whitespace. */
export function normalizeTranscript(s: string): string {
  return s.normalize("NFKC").toLowerCase().replace(/[\p{P}\p{S}\s]/gu, "");
}

/**
 * Phrases dropped only as a whole message (by isHallucination), never cut out
 * of one: real speech says them mid-sentence (「おやすみなさい、また明日。」).
 */
const WHOLE_ONLY: ReadonlySet<string> = new Set(["おやすみなさい"]);
/** The phrases cut out of a longer message too (cleanTranscript, stripHallucinationTail). */
const IN_TEXT = HALLUCINATIONS.filter((h) => !WHOLE_ONLY.has(h));

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Normalized text that is one of `list` (or a run of them). */
const wholeRe = (list: readonly string[]) =>
  new RegExp(
    `^(?:${list
      .map((h) =>
        h
          .split("…")
          .map((part) => escapeRe(normalizeTranscript(part)))
          .join(".*"),
      )
      .join("|")})+$`,
    "u",
  );
const HALLUCINATION_RE = wholeRe(HALLUCINATIONS);
const IN_TEXT_RE = wholeRe(IN_TEXT);

/** A known phrase (or a run of them) at the very end of a transcript, whatever its punctuation. */
/** Punctuation, symbols or spaces, anywhere between a phrase's characters. */
const GAP = "[\\p{P}\\p{S}\\s]*";
/** The phrases on raw text: each character in turn, any punctuation or spacing between. */
const PHRASE_ALT = IN_TEXT.map((h) =>
  h
    .split("…")
    .map((part) => [...normalizeTranscript(part)].map(escapeRe).join(GAP))
    .join(".*?"),
).join("|");
const HALLUCINATION_TAIL_RE = new RegExp(`(?:${PHRASE_ALT})(?:${GAP}(?:${PHRASE_ALT}))*${GAP}$`, "iu");

/**
 * Real speech with a known phrase stuck on its end ("…明天见。谢谢观看"):
 * the speech without it. Text that is all phrase is left as it is (that is
 * isHallucination's to judge), and so is text without one.
 */
export function stripHallucinationTail(text: string): string {
  const m = HALLUCINATION_TAIL_RE.exec(text);
  if (!m || m.index === 0) return text;
  const kept = text.slice(0, m.index).trimEnd();
  return normalizeTranscript(kept) ? kept : text;
}

/** The text is a known hallucination phrase (or a run of them), whatever its punctuation. */
export function isHallucinationPhrase(text: string): boolean {
  const n = normalizeTranscript(text);
  return !!n && HALLUCINATION_RE.test(n);
}

/**
 * Drop this final transcript: a known hallucination phrase from an utterance
 * with under HALLUCINATION_MAX_MS of speech, or a mean speech probability
 * under HALLUCINATION_MIN_PROB. The same words said at length and clearly are
 * kept: the user may really say them.
 */
export function isHallucination(text: string, ms: number, prob?: number): boolean {
  if (!isHallucinationPhrase(text)) return false;
  return ms < HALLUCINATION_MAX_MS || (prob !== undefined && prob < HALLUCINATION_MIN_PROB);
}

/**
 * Where a transcript breaks into clauses: CJK and Latin sentence and clause
 * marks, but a "." or "," only before a space, another mark or the end, so
 * "Amara.org" and "3.5" stay whole.
 */
const CLAUSE_BREAK = /(?:[。，、！？；：…!?;:\n]|[.,](?=[\s.,。，、！？…!?]|$))+\s*/gu;

type Clause = { body: string; end: string };

/** The text in clauses, each with the marks (and spaces) that end it. */
function clauses(text: string): Clause[] {
  const out: Clause[] = [];
  let at = 0;
  for (const m of text.matchAll(CLAUSE_BREAK)) {
    out.push({ body: text.slice(at, m.index), end: m[0] });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push({ body: text.slice(at), end: "" });
  return out;
}

/** A prompt clause shorter than this (normalized) is never stripped: a lone 中文 is speech. */
export const PROMPT_CLAUSE_MIN = 4;
/** A prompt clause this long (normalized) is stripped inside a clause too, not only as one. */
export const PROMPT_INLINE_MIN = 8;

/** One prompt, ready for matching: the whole of it, and its clauses (split on 。，,.!?). */
function promptParts(prompt: string) {
  const whole = normalizeTranscript(prompt);
  const parts = prompt
    .split(/[。，,.!?！？]/u)
    .map(normalizeTranscript)
    .filter((c) => c.length >= PROMPT_CLAUSE_MIN);
  return {
    whole,
    clauses: new Set([whole, ...parts]),
    inline: [whole, ...parts.filter((c) => c.length >= PROMPT_INLINE_MIN)],
  };
}

/** A normalized string on raw text: its characters in turn, any punctuation or spacing between. */
const looseRe = (n: string) => new RegExp([...n].map(escapeRe).join(GAP) + GAP, "giu");

/** Real short English words (and sounds): a run of these is speech, kept once, not a fragment. */
const SHORT_WORDS = new Set(
  (
    "a i o an am as at be by do go he hi if in is it me my no of oh ok on or so to up us we ya ye yo " +
    "ah aw eh ha hm uh um " +
    "all and any are ask bad big boy but bye can cat day did dog eat far few for fun get god " +
    "got had has her hey him his how its let lot man may new nor not now off old one our out " +
    "own put ran red run sad saw say see she sir sit six ten the too top try two use was way " +
    "who why win yes yet you wow huh hmm yay lol omg"
  ).split(" "),
);

const CJK_CHAR = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]$/u;

/** A Latin token that is no word: no vowel, or three letters or fewer and not a real short word. */
function isFragment(tok: string): boolean {
  if (!/^[\p{Script=Latin}']+$/u.test(tok)) return false;
  if (!/[aeiouy]/i.test(tok)) return true;
  return tok.length <= 3 && !SHORT_WORDS.has(tok.toLowerCase());
}

/** Repeated this many times in a row, a token or n-gram is a decoding loop. */
export const REPEAT_MIN = 4;
/** A single CJK character needs this many ("哈哈哈哈" is laughter, not a loop). */
export const REPEAT_MIN_CJK_CHAR = 6;
const REPEAT_MAX_N = 4;
const TOKEN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|[\p{L}\p{N}']+/gu;

/**
 * Whisper's decoding loops ("ert ert ert ert ert", "好的好的好的好的"): a run
 * of the same token or n-gram (n ≤ 4) REPEAT_MIN times or more in a row goes
 * to one copy, or to nothing when it is a Latin fragment that is no word.
 * Three in a row ("no no no") is speech and stays. Returns the text and the
 * repeated units.
 */
export function collapseRepeats(text: string): { text: string; runs: string[] } {
  const toks = [...text.matchAll(TOKEN)].map((m) => ({
    start: m.index,
    end: m.index + m[0].length,
    raw: m[0],
    key: m[0].normalize("NFKC").toLowerCase(),
  }));
  const runs: string[] = [];
  let out = "";
  let at = 0;
  for (let i = 0; i < toks.length; ) {
    let best: { n: number; k: number } | undefined;
    for (let n = 1; n <= REPEAT_MAX_N && i + 2 * n <= toks.length; n++) {
      let k = 1;
      while (
        i + (k + 1) * n <= toks.length &&
        toks.slice(i + k * n, i + (k + 1) * n).every((t, j) => t.key === toks[i + j].key)
      )
        k++;
      const min = n === 1 && CJK_CHAR.test(toks[i].raw) ? REPEAT_MIN_CJK_CHAR : REPEAT_MIN;
      if (k >= min && (!best || n * k > best.n * best.k)) best = { n, k };
    }
    if (!best) {
      i++;
      continue;
    }
    const unit = toks.slice(i, i + best.n);
    const fragment = unit.every((t) => isFragment(t.raw));
    out += fragment
      ? text.slice(at, toks[i].start).trimEnd()
      : text.slice(at, toks[i].start) + text.slice(toks[i].start, unit.at(-1)!.end);
    at = toks[i + best.n * best.k - 1].end;
    runs.push(unit.map((t) => t.raw).join(" "));
    i += best.n * best.k;
  }
  return runs.length ? { text: out + text.slice(at), runs } : { text, runs };
}

/** What cleanTranscript took out of a transcript, by kind. */
export type TranscriptCleaning = {
  /** The cleaned text: the input itself when nothing was taken out. */
  text: string;
  /** Nothing meaningful was left: drop the message as a hallucination. */
  drop: boolean;
  /** Echoes of the STT prompt taken out. */
  prompt: number;
  /** Stock subtitle and outro phrases taken out. */
  phrase: number;
  /** Repeated runs collapsed. */
  repeat: number;
  /** What was taken out (Whisper's text, not the user's), for the devLog. */
  removed: string[];
};

const joinClauses = (cs: Clause[]) => cs.map((c) => c.body + c.end).join("");

/**
 * Every final transcript, cloud or local, before it is used: Whisper's own
 * additions taken out of real speech (docs/workers-ai.md, "Speech to text").
 *
 * 1. An echo of the STT prompt (`prompts`, by default every prompt the route
 *    may send): the whole prompt, or one of its clauses of PROMPT_CLAUSE_MIN
 *    characters or more, as a clause of the text once normalized; the whole
 *    prompt, and a clause of PROMPT_INLINE_MIN or more, inside a clause too.
 *    A short word that is merely in the prompt (a lone 中文) stays.
 * 2. A stock subtitle or outro phrase (HALLUCINATIONS) that is a clause, or a
 *    run of clauses, of its own anywhere in the text, or is stuck on its end
 *    (stripHallucinationTail). One inside a sentence ("他说感谢观看这个视频的人")
 *    stays.
 * 3. Decoding loops (collapseRepeats).
 *
 * A text of nothing but stock phrases is left as it is when nothing else was
 * found: isHallucination judges that by length and loudness, since the user
 * may say them. Otherwise, when nothing is left but punctuation, or only
 * scraps of a prompt whose echo was found ("中文。"), `drop` is set.
 */
export function cleanTranscript(text: string, prompts: readonly string[] = STT_PROMPTS): TranscriptCleaning {
  const res: TranscriptCleaning = { text, drop: false, prompt: 0, phrase: 0, repeat: 0, removed: [] };
  if (!normalizeTranscript(text)) return res;
  const ps = prompts.filter((p) => normalizeTranscript(p)).map(promptParts);

  // 3 first: a loop can sit between two parts of a prompt echo.
  const rep = collapseRepeats(text);
  let t = rep.text;
  res.repeat = rep.runs.length;
  res.removed.push(...rep.runs);

  // 1 inside clauses: the whole prompt and its long clauses, wherever they are.
  for (const p of ps)
    for (const c of p.inline) {
      const re = looseRe(c);
      const probe = new RegExp(re.source, "iu");
      // Full-width echoes ("ｅｎｇｌｉｓｈ") match once the text is NFKC too.
      if (!probe.test(t) && probe.test(t.normalize("NFKC"))) t = t.normalize("NFKC");
      t = t.replace(re, (m) => {
        res.prompt++;
        res.removed.push(m);
        return "";
      });
    }

  // 1 and 2 by clause: a prompt clause, or a run of clauses that is stock phrases.
  const cs = clauses(t);
  const keep: Clause[] = [];
  let phraseOnly = true;
  for (let i = 0; i < cs.length; ) {
    const n = normalizeTranscript(cs[i].body);
    if (!n) {
      i++;
      continue;
    }
    if (ps.some((p) => p.clauses.has(n))) {
      res.prompt++;
      res.removed.push(cs[i++].body.trim());
      continue;
    }
    let j = -1; // the longest run of clauses from i that is one or more stock phrases
    for (let e = cs.length; e > i && j < 0; e--) {
      const run = normalizeTranscript(joinClauses(cs.slice(i, e)));
      if (run && IN_TEXT_RE.test(run)) j = e;
    }
    if (j > 0) {
      res.phrase++;
      res.removed.push(joinClauses(cs.slice(i, j)).trim());
      i = j;
      continue;
    }
    phraseOnly = false;
    keep.push(cs[i++]);
  }
  // Stock phrases alone, and nothing else found: isHallucination's call.
  if (phraseOnly && !res.prompt && !res.repeat) return { ...res, phrase: 0, removed: [] };

  let out = joinClauses(keep).trim();
  // 2 at the end: a phrase stuck onto the last clause ("嗯 字幕志愿者 李宗盛").
  const tail = stripHallucinationTail(out);
  if (tail !== out) {
    res.phrase++;
    res.removed.push(out.slice(tail.length).trim());
    out = tail;
  }
  if (!res.prompt && !res.phrase && !res.repeat) return res;

  const left = clauses(out)
    .map((c) => normalizeTranscript(c.body))
    .filter(Boolean);
  const scraps = res.prompt > 0 && left.every((c) => ps.some((p) => p.whole.includes(c)));
  return { ...res, text: out, drop: !left.length || scraps };
}

/** Words (or, in CJK text, characters), and their keys: lowercased, without punctuation. */
function tokens(s: string): { raw: string[]; key: string[]; cjk: boolean } {
  const cjk = CJK.test(s);
  const raw = cjk ? [...s.replace(/\s+/g, "")] : s.split(/\s+/).filter(Boolean);
  const key = raw.map((w) => w.toLowerCase().replace(/[\p{P}\p{S}]/gu, ""));
  return { raw, key, cjk };
}

/**
 * Two overlapping chunks' transcripts as one: the longest run of words that
 * ends `a` and starts `b` is kept once ("the quick brown" + "brown fox" →
 * "the quick brown fox"). With no overlap they are just joined.
 */
export function mergeOverlap(a: string, b: string): string {
  const A = tokens(a.trim());
  const B = tokens(b.trim());
  for (let k = Math.min(A.key.length, B.key.length); k > 0; k--) {
    const end = A.key.slice(-k);
    if (end.join("") && end.every((w, i) => w === B.key[i]))
      return joinText(a.trim(), B.raw.slice(k).join(B.cjk ? "" : " "));
  }
  return joinText(a.trim(), b);
}

/** Linear resampling to `to` Hz (the fallback VAD records at the device's rate). */
export function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return input;
  const n = Math.max(1, Math.round((input.length * to) / from));
  const out = new Float32Array(n);
  const step = from / to;
  for (let i = 0; i < n; i++) {
    const x = i * step;
    const j = Math.floor(x);
    const a = input[Math.min(j, input.length - 1)];
    const b = input[Math.min(j + 1, input.length - 1)];
    out[i] = a + (b - a) * (x - j);
  }
  return out;
}

/** 16-bit PCM WAV, mono: what every STT model takes, and every browser can make. */
export function encodeWav(samples: Float32Array, rate = RATE): Uint8Array {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, "RIFF");
  v.setUint32(4, 36 + samples.length * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buf);
}

/** The RMS level of a frame, for the energy fallback. */
export function rms(frame: Float32Array): number {
  let sum = 0;
  for (const x of frame) sum += x * x;
  return Math.sqrt(sum / (frame.length || 1));
}

function concat(chunks: Float32Array[]): Float32Array {
  const all = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) {
    all.set(c, o);
    o += c.length;
  }
  return all;
}

/**
 * The energy-threshold VAD the mic falls back to when Silero cannot load:
 * feed it frames; it says when speech starts (two frames over `on`) and
 * ends (`hangMs` under `off`), keeping a frame of audio from before the start.
 */
export function energyGate(opts: {
  rate: number;
  on?: number;
  off?: number;
  hangMs?: number;
  minMs?: number;
}) {
  const on = opts.on ?? 0.02;
  const off = opts.off ?? 0.01;
  const hang = ((opts.hangMs ?? 700) * opts.rate) / 1000;
  const min = ((opts.minMs ?? 250) * opts.rate) / 1000;
  let loud = 0;
  let quiet = 0;
  let speaking = false;
  let pre: Float32Array[] = [];
  let chunks: Float32Array[] = [];
  const cut = (): Float32Array | "misfire" => {
    const all = concat(chunks);
    speaking = false;
    chunks = [];
    quiet = 0;
    loud = 0;
    return all.length < min ? "misfire" : all;
  };
  return {
    /** null: nothing happened; "start"; or the finished utterance (or "misfire"). */
    push(frame: Float32Array): null | "start" | "misfire" | Float32Array {
      const level = rms(frame);
      if (!speaking) {
        pre = [...pre.slice(-1), frame];
        loud = level > on ? loud + 1 : 0;
        if (loud < 2) return null;
        speaking = true;
        chunks = pre;
        pre = [];
        return "start";
      }
      chunks.push(frame);
      quiet = level < off ? quiet + frame.length : 0;
      return quiet >= hang ? cut() : null;
    },
    /** End the utterance now (the cap, or listening turned off). */
    flush(): null | "misfire" | Float32Array {
      return speaking ? cut() : null;
    },
  };
}

/**
 * While streaming to the local STT the mic ends an utterance itself, after
 * ENDPOINT_MS under the threshold, instead of waiting out vad-web's own
 * silence (redemptionMs, 1400 ms by default): partials already show, so the
 * final may come sooner. The threshold sits ENDPOINT_MARGIN over the noise
 * floor (the mean Silero probability between utterances, an EMA), within
 * [ENDPOINT_MIN, ENDPOINT_MAX], so steady noise neither holds speech open nor
 * cuts it short.
 */
export const ENDPOINT_MS = 600;
export const ENDPOINT_MARGIN = 0.25;
export const ENDPOINT_MIN = 0.35;
export const ENDPOINT_MAX = 0.8;
/**
 * The semantic endpoint (off unless set): when the local STT's latest
 * partial ends a sentence (。！？.!? — never 、 or a comma) and Silero has
 * dropped under the threshold, the utterance ends after this much silence
 * instead of ENDPOINT_MS. 0 = off, until the cut-sentence rate is measured
 * on the owner's clips (scripts/local-stt/ab-eval.py). Set it on the page:
 * `globalThis.__lkVoiceTune = { semanticMs: 300 }` (read at each frame).
 */
export const SEMANTIC_ENDPOINT_MS = 0;
export function semanticMs(
  over: unknown = (globalThis as { __lkVoiceTune?: unknown }).__lkVoiceTune,
): number {
  const v = over && typeof over === "object" ? (over as { semanticMs?: unknown }).semanticMs : undefined;
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : SEMANTIC_ENDPOINT_MS;
}
/** A partial that ends a sentence: terminal punctuation only. */
export function endsSentence(partial: string): boolean {
  return ENDS_SENTENCE.test(partial.trim());
}

/** The floor's EMA weight per 32 ms frame (~1 s to settle). */
export const FLOOR_ALPHA = 0.05;
export function endpointThreshold(
  floor: number,
  margin = ENDPOINT_MARGIN,
  min = ENDPOINT_MIN,
): number {
  return Math.min(ENDPOINT_MAX, Math.max(min, floor + margin));
}

/**
 * The room and voice estimator (adaptive.ts): it hears every frame and each
 * utterance's end, and sets the endpoint (a whisper in a quiet room waits
 * longer, over a lower threshold).
 */
export type MicAdapt = {
  frame(frame: Float32Array, prob: number | undefined, capturing: boolean): void;
  end(kept: boolean): void;
  state(): { endpointMs: number; endpointMargin: number; endpointMin: number; whisper?: boolean };
};

export type UploadInfo = {
  seq: number;
  durationMs: number;
  partial: boolean;
  /** The local streaming STT's final for this utterance (it may reject: then fall back). */
  local?: Promise<LocalFinal>;
  /**
   * The upload calls this when it drops the transcript as the agent's own
   * echo (echo.ts): an echo is not "not for the agent", so it never counts
   * towards passive mode (the wake gate's verdict is skipped).
   */
  onEcho?: () => void;
};
/**
 * The wake-word gate (wake.ts, docs/wake-word.md). While `passive()` is true
 * when an utterance starts, it is neither streamed nor sent in partials; at
 * its end `spot` checks it on-device, and only the words after "Linky" are
 * uploaded (a bare "Linky" uploads nothing). `verdict` hears each final in
 * active mode: false for an empty or hallucinated transcript.
 */
export type WakeGate = {
  passive(): boolean;
  spot(audio: Float32Array): Promise<WakeSpot & { ms?: number; error?: string }>;
  /** "Linky" was heard: the mic becomes active. */
  onWake(): void;
  verdict(ok: boolean, why: "ok" | "empty" | "hallucination"): void;
};
/** What createMic needs of a streaming STT (local-stt.ts LocalStt). */
export type StreamStt = {
  begin(onPartial: (text: string) => void): LocalUtt | null;
  warm?(): void;
  /** While the mic is on: keep the socket open (reopen on close, visible, online). */
  keep?(on: boolean): void;
  /** The socket is up now (the post-"Linky" rest streams only then: it is already over). */
  connected?(): boolean;
};
/** Mic on: keep the stream's socket open (or just open it, for one without keep). */
export function keepStream(s: StreamStt | undefined, on: boolean) {
  if (s?.keep) s.keep(on);
  else if (on) s?.warm?.();
}

/**
 * Listening mode. `toggle()` turns it on (loading the VAD, or the fallback if
 * that fails, unless the mic itself was refused) and off. Each utterance is
 * encoded and uploaded at once; its transcript (in order) goes to `onText`,
 * and `onPending` counts those still out, with the interim text to show
 * dimmed. A capture longer than MAX_UTTERANCE_MS is cut and sent. A 401 turns
 * listening off; a 429 on a partial stops partials until the next turn-on.
 */
export function createMic(d: {
  load: VadFactory;
  fallback?: VadFactory;
  upload: (wav: Uint8Array, info: UploadInfo) => Promise<string>;
  onState: (s: MicState) => void;
  onText: (text: string) => void;
  onPending: (n: number, interim: string) => void;
  onError?: (e: unknown) => void;
  /** Each frame's speech probability while capturing (the barge-in judge, voice.ts). */
  onProb?: (prob: number) => void;
  /** Debug events (a dropped hallucination: `{ev: "stt-hallucination", text, ms, prob}`). */
  log?: (ev: Record<string, unknown>) => void;
  /** Rolling partial chunks for long utterances (on unless false). */
  partials?: boolean;
  /** The local streaming STT, if one is configured now (asked at each utterance). */
  stream?: () => StreamStt | undefined;
  /**
   * A final utterance's timestamps, for the voice latency record (latency.ts):
   * at its end `{t_lastVoice?, t_speechEnd, audioMs}`, then `{t_uploadStart}`,
   * then `{t_sttDone, dropped}`. Partials are not timed.
   */
  timing?: (seq: number, marks: UttMarks) => void;
  /** The wake-word gate; without it every utterance is uploaded (as before). */
  wake?: WakeGate;
  /** The adaptive estimator (adaptive.ts); without it the endpoint is the fixed one. */
  adapt?: MicAdapt;
  now?: () => number;
  setTimer?: (f: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}) {
  const now = d.now ?? Date.now;
  const setTimer = d.setTimer ?? ((f, ms) => setTimeout(f, ms));
  const clearTimer = d.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  const q = new UtteranceQueue();
  let state: MicState = "off";
  let vad: Vad | null = null;
  let cap: unknown;
  /** Bumped on every toggle, so a VAD that finishes loading after "off" is dropped. */
  let gen = 0;
  /** The utterance being captured: its frames, and its seq once a partial reserved one. */
  let live: Float32Array[] = [];
  let liveLen = 0;
  let sincePartial = 0;
  let cur: number | null = null;
  let partialBusy = false;
  let partialsOn = d.partials !== false;
  /** The utterance being streamed to the local STT, if it is. */
  let utt: LocalUtt | null = null;
  /** Our own end-of-speech while streaming: noise floor, speech heard, silence since, flushed. */
  const ep = { floor: 0.1, heard: false, quiet: 0, sent: false, partial: "" };
  const dropUtt = () => {
    utt?.cancel();
    utt = null;
  };
  /** The agent is speaking (hold): capture stops, and anything heard is dropped. */
  let held = false;
  /** Set by a hold: speech that began before it is dropped, even if it ends after. */
  let tainted = false;
  /**
   * The utterance's speech so far, for the hallucination guard: samples in
   * frames at or over SPEECH_FRAME_PROB, and the probabilities' sum and count.
   * Reset when speech starts; kept past resetLive, so a flush on "off" has them.
   */
  let speechLen = 0;
  let probSum = 0;
  let probN = 0;
  /** When the last frame at or over SPEECH_FRAME_PROB was heard (Silero only). */
  let lastVoice: number | undefined;
  /** The utterance being captured began in passive mode: only the wake gate hears it. */
  let gated = false;
  /** VAD pause/start calls, in order. */
  let ctl: Promise<unknown> = Promise.resolve();
  const toMs = (n: number) => Math.round((n / RATE) * 1000);
  const toSamples = (ms: number) => (ms * RATE) / 1000;

  const set = (s: MicState) => {
    state = s;
    d.onState(s);
  };
  const pending = () => d.onPending(q.pending(), q.interim());
  const report = () => {
    const t = q.take();
    if (t) d.onText(t);
    pending();
  };
  const resetLive = () => {
    live = [];
    liveLen = 0;
    sincePartial = 0;
  };
  /** An utterance whose seq a partial reserved ended in nothing. */
  const dropCur = () => {
    if (cur === null) return;
    q.resolve(cur, null);
    cur = null;
    report();
  };
  const fail = (e: unknown) => {
    d.onError?.(e);
    if (e instanceof SttError && e.status === 401) void off();
  };
  const sendPartial = () => {
    const seq = cur ?? (cur = q.add());
    const n = Math.min(liveLen, sincePartial + toSamples(PARTIAL_OVERLAP_MS));
    const chunk = concat(live).subarray(liveLen - n);
    sincePartial = 0;
    partialBusy = true;
    pending();
    d.upload(encodeWav(chunk), { seq, durationMs: toMs(n), partial: true })
      .then(
        (text) => q.partial(seq, mergeOverlap(q.getPartial(seq), text)),
        (e) => {
          // Best effort: a 429 stops partials, a 401 stops listening, the rest is quiet.
          if (e instanceof SttError && e.status === 429) partialsOn = false;
          if (e instanceof SttError && e.status === 401) fail(e);
        },
      )
      .finally(() => {
        partialBusy = false;
        pending();
      });
  };
  const events = (g: number): VadEvents => ({
    onSpeechStart() {
      if (g !== gen || held) return;
      tainted = false;
      set("capturing");
      resetLive();
      speechLen = probSum = probN = 0;
      lastVoice = undefined;
      clearTimer(cap);
      cap = setTimer(() => void vad?.flush(), MAX_UTTERANCE_MS);
      dropUtt();
      ep.heard = ep.sent = false;
      ep.quiet = 0;
      ep.partial = "";
      gated = d.wake?.passive() ?? false;
      utt = gated
        ? null
        : d.stream?.()?.begin((text) => {
          if (g !== gen || held) return;
          const seq = cur ?? (cur = q.add());
          ep.partial = text;
          q.partial(seq, text);
          pending();
        }) ?? null;
    },
    onFrame(frame, prob) {
      if (g !== gen) return;
      if (!held) d.adapt?.frame(frame, prob, state === "capturing");
      // The noise floor: Silero's probability on what is heard between utterances.
      if (prob !== undefined && state === "listening") ep.floor += (prob - ep.floor) * FLOOR_ALPHA;
      if (state !== "capturing") return;
      if (utt && prob !== undefined && !ep.sent) {
        // Streaming: our own end of speech, ENDPOINT_MS under a threshold over the floor.
        const a = d.adapt?.state();
        if (prob >= endpointThreshold(ep.floor, a?.endpointMargin, a?.endpointMin)) {
          ep.heard = true;
          ep.quiet = 0;
        } else ep.quiet += frame.length;
        const sem = semanticMs();
        const early = sem > 0 && endsSentence(ep.partial);
        const wait = early ? Math.min(sem, a?.endpointMs ?? ENDPOINT_MS) : (a?.endpointMs ?? ENDPOINT_MS);
        if (ep.heard && ep.quiet >= toSamples(wait)) {
          ep.sent = true;
          d.log?.({
            ev: "stt-endpoint",
            floor: Math.round(ep.floor * 100) / 100,
            ...(early ? { semantic: true, waitMs: wait } : {}),
          });
          void vad?.flush();
        }
      }
      if (prob !== undefined) {
        d.onProb?.(prob);
        probSum += prob;
        probN++;
        if (prob >= SPEECH_FRAME_PROB) {
          speechLen += frame.length;
          lastVoice = now();
        }
      }
      live.push(frame);
      liveLen += frame.length;
      sincePartial += frame.length;
      if (utt) return void utt.frame(frame);
      if (
        partialsOn &&
        !gated &&
        !partialBusy &&
        liveLen >= toSamples(PARTIAL_MIN_MS) &&
        sincePartial >= toSamples(PARTIAL_EVERY_MS)
      )
        sendPartial();
    },
    onMisfire() {
      d.adapt?.end(false);
      if (g !== gen || held) return;
      clearTimer(cap);
      dropUtt();
      resetLive();
      dropCur();
      if (state === "capturing") set("listening");
    },
    onSpeechEnd(audio) {
      // Only speech that is kept teaches the speech level (never the agent's echo).
      d.adapt?.end(g === gen && !held && !tainted);
      const u = utt;
      utt = null;
      // Heard while the agent spoke (or begun before it did): the reply's echo, dropped.
      if (held || tainted) return void u?.cancel();
      clearTimer(cap);
      const mine = g === gen;
      if (mine && state === "capturing") set("listening");
      const seq = mine && cur !== null ? cur : q.add();
      if (mine) {
        cur = null;
        resetLive();
      }
      // Speech length and mean probability (Silero); without them, the clip's length.
      const ms = toMs(probN ? speechLen : audio.length);
      const prob = probN ? Math.round((probSum / probN) * 1000) / 1000 : undefined;
      speechLen = probSum = probN = 0;
      d.timing?.(seq, {
        ...(lastVoice !== undefined ? { t_lastVoice: lastVoice } : {}),
        t_speechEnd: now(),
        audioMs: toMs(audio.length),
      });
      lastVoice = undefined;
      pending();
      if (gated && d.wake) {
        // Passive: nothing leaves the phone unless "Linky" is in it.
        const w = d.wake;
        gated = false;
        u?.cancel();
        void w.spot(audio).then(
          (r) => {
            d.log?.({
              ev: "wake-spot",
              hit: r.hit,
              audioMs: toMs(audio.length),
              ...(r.ms !== undefined ? { ms: r.ms } : {}),
              ...(r.error ? { error: r.error } : {}),
              ...(r.hit ? { tokens: r.tokens.join(" "), restMs: toMs(r.rest.length) } : {}),
            });
            if (!r.hit) {
              d.timing?.(seq, { t_sttDone: now(), dropped: true });
              q.resolve(seq, null);
              return report();
            }
            w.onWake();
            if (!r.rest.length) {
              d.timing?.(seq, { t_sttDone: now(), dropped: true });
              q.resolve(seq, null);
              return report();
            }
            // The words after "Linky" go to the Mac too when its socket is up (as a
            // pre-pad and an end: the audio is already whole); else the cloud.
            const s = d.stream?.();
            const lu = s?.connected?.() ? s.begin(() => {}) : null;
            send(seq, r.rest, toMs(r.rest.length), prob, lu?.end(r.rest));
          },
          () => {
            q.resolve(seq, null);
            report();
          },
        );
        return;
      }
      send(seq, audio, ms, prob, u?.end(audio));
    },
  });
  /** Upload one final utterance and hand its transcript to the queue in order. */
  const send = (
    seq: number,
    audio: Float32Array,
    ms: number,
    prob: number | undefined,
    local?: Promise<LocalFinal>,
  ) => {
    const wav = encodeWav(audio);
    local?.catch(() => {}); // upload decides; never an unhandled rejection
    d.timing?.(seq, { t_uploadStart: now() });
    let echo = false;
    d.upload(wav, {
      seq,
      durationMs: toMs(audio.length),
      partial: false,
      local,
      onEcho: () => void (echo = true),
    })
      .then(
        (heard) => {
          // Whisper's additions out of real speech: prompt echo, stock phrases, loops.
          const c = cleanTranscript(heard);
          const text = c.drop ? "" : c.text;
          if (c.prompt || c.phrase || c.repeat)
            d.log?.({
              ev: "stt-cleaned",
              prompt: c.prompt,
              phrase: c.phrase,
              repeat: c.repeat,
              dropped: c.drop,
              text: c.removed.join(" | ").slice(0, 80),
            });
          const drop = c.drop || isHallucination(text, ms, prob);
          if (drop && !c.drop) d.log?.({ ev: "stt-hallucination", text: text.slice(0, 80), ms, prob });
          d.timing?.(seq, { t_sttDone: now(), dropped: drop || !text.trim() });
          if (!echo) d.wake?.verdict(!drop && !!text.trim(), drop ? "hallucination" : text.trim() ? "ok" : "empty");
          q.resolve(seq, drop ? null : text);
        },
        (e) => {
          d.timing?.(seq, { t_sttDone: now(), dropped: true });
          q.resolve(seq, null);
          fail(e);
        },
      )
      .finally(report);
  };
  const on = async () => {
    const g = ++gen;
    partialsOn = d.partials !== false;
    set("loading");
    let v: Vad;
    try {
      v = await d.load(events(g));
    } catch (e) {
      if (!d.fallback || isMicDenied(e)) {
        if (g === gen) set("off");
        d.onError?.(e);
        return;
      }
      try {
        v = await d.fallback(events(g));
      } catch (e2) {
        if (g === gen) set("off");
        d.onError?.(e2);
        return;
      }
    }
    if (g !== gen) return void v.destroy();
    vad = v;
    keepStream(d.stream?.(), true);
    if (!held) await v.start();
    set("listening");
  };
  async function off() {
    if (state === "off") return;
    gen++;
    clearTimer(cap);
    const v = vad;
    vad = null;
    // The seq a partial reserved: the flush below sends the speech as a new one.
    const reserved = cur;
    cur = null;
    resetLive();
    set("off");
    keepStream(d.stream?.(), false);
    if (v) {
      // Speech under way when listening stops is still sent.
      await v.flush();
      await v.destroy();
    }
    if (reserved !== null) {
      cur = reserved;
      dropCur();
    }
  }
  /**
   * Hold capture while the agent speaks (on), resume it (off). Speech being
   * captured is dropped, partials stop, and the VAD is paused; what it hands
   * over meanwhile (a submit-on-pause) is dropped too.
   */
  function hold(on: boolean) {
    if (held === on) return;
    held = on;
    if (on) {
      tainted = true;
      clearTimer(cap);
      dropUtt();
      resetLive();
      dropCur();
      if (state === "capturing") set("listening");
    }
    const v = vad;
    if (v) ctl = ctl.then(() => (on ? v.pause() : v.start())).catch(() => {});
  }
  return {
    toggle: () => (state === "off" ? on() : off()),
    hold,
    held: () => held,
    off,
    state: () => state,
  };
}

/** The STT route's answer (agent C's contract). */
export type SttResult = { text: string; model?: string; ms?: number; language?: string };

/**
 * POST one recording to /api/debug/stt, the raw audio as the body, with the
 * speaker's language as `?hint=` when known. Throws SttError on non-2xx.
 */
export async function postStt(
  wav: Uint8Array,
  f: typeof fetch = fetch,
  type = "audio/wav",
  hint?: string,
): Promise<SttResult> {
  const res = await f(hint ? `/api/debug/stt?hint=${encodeURIComponent(hint)}` : "/api/debug/stt", {
    method: "POST",
    body: wav as unknown as BodyInit,
    headers: { "content-type": type },
  });
  const out = (await res.json().catch(() => ({}))) as Partial<SttResult> & { error?: string };
  if (!res.ok) throw new SttError(res.status, out.error ?? `stt ${res.status}`);
  return { ...out, text: out.text ?? "" };
}

/** What the sink said about one clip: its name, or why it was not kept. */
export type ClipResult = { ok: true; name?: string } | { ok: false; status?: number; error: string };

/**
 * Keep one utterance on the owner's dev server (scripts/dev/clip-sink): a
 * multipart POST to `<sink>/clips` with the audio and a JSON `meta` (when,
 * type, how long, from which page, and what was heard, once known). Never
 * rejects: it resolves to the sink's answer, so a failure can be shown (the
 * recording badge) instead of lost.
 */
export function postClip(
  sink: string,
  wav: Uint8Array,
  meta: {
    at: number;
    durationMs: number;
    label: string;
    transcript?: string;
    model?: string;
    /** The mic's mode for this utterance (lk:voice-aec), for the A/B. */
    aec?: boolean;
    /** How the browser opened the mic (track.getSettings()), for the A/B. */
    track?: Record<string, unknown> | null;
  },
  f: typeof fetch = fetch,
  /** The sink's write key (the session's, from the hub): `authorization: Bearer`. */
  key?: string,
): Promise<ClipResult> {
  const mime = "audio/wav";
  const form = new FormData();
  form.append("audio", new Blob([wav as unknown as BlobPart], { type: mime }), "clip.wav");
  form.append(
    "meta",
    JSON.stringify({
      at: new Date(meta.at).toISOString(),
      mime,
      durationMs: meta.durationMs,
      label: meta.label,
      transcript: meta.transcript ?? "",
      model: meta.model,
      aec: meta.aec,
      track: meta.track ?? undefined,
    }),
  );
  return f(`${sink}/clips`, {
    method: "POST",
    body: form,
    ...(key ? { headers: { authorization: `Bearer ${key}` } } : {}),
  }).then(
    async (r): Promise<ClipResult> => {
      if (!r.ok) return { ok: false, status: r.status, error: `sink ${r.status}` };
      const j = (await r.json().catch(() => ({}))) as { name?: unknown };
      return typeof j.name === "string" ? { ok: true, name: j.name } : { ok: true };
    },
    (e): ClipResult => ({ ok: false, error: String((e as Error)?.message ?? e).slice(0, 120) }),
  );
}

/**
 * The clip sink is a side path: the upload (and the FormData it builds) runs
 * in a later task, after the caller already has its transcript. It never
 * delays recognition, and the VAD never waits on it. A failure is silent.
 */
export function sideClip(
  post: () => Promise<unknown>,
  defer: (run: () => void) => void = (run) => void setTimeout(run, 0),
): void {
  defer(() => {
    try {
      void post().catch(() => {});
    } catch {}
  });
}

/** The custom DOM event fired on window when a spoken sentence is sent by itself. */
export const VOICE_SENT_EVENT = "lk:voice-sent";
/** The send tick: two soft sine tones, this loud at their peak, this long in all. */
export const TICK_GAIN = 0.08;
export const TICK_MS = 80;

/** The slice of an AudioContext the tick uses (a fake in the tests). */
export type TickContext = {
  currentTime: number;
  destination: unknown;
  createOscillator(): {
    type: string;
    frequency: { setValueAtTime(v: number, t: number): unknown };
    connect(n: unknown): unknown;
    start(t: number): void;
    stop(t: number): void;
  };
  createGain(): {
    gain: {
      setValueAtTime(v: number, t: number): unknown;
      linearRampToValueAtTime(v: number, t: number): unknown;
      exponentialRampToValueAtTime(v: number, t: number): unknown;
    };
    connect(n: unknown): unknown;
  };
};

/**
 * A short, soft "tick" when a spoken sentence goes out: two sine tones (the
 * second a fifth up, 30 ms later) through one gain with a 5 ms attack and an
 * exponential decay, TICK_MS long, peaking at TICK_GAIN. Web Audio only — no
 * <audio> element — so iOS keeps it silent when the ringer is muted.
 */
export function scheduleTick(ctx: TickContext, at = ctx.currentTime) {
  const end = at + TICK_MS / 1000;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, at);
  g.gain.linearRampToValueAtTime(TICK_GAIN, at + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, end);
  g.connect(ctx.destination);
  const tones: [number, number][] = [
    [880, at],
    [1320, at + 0.03],
  ];
  for (const [hz, t] of tones) {
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.setValueAtTime(hz, t);
    o.connect(g);
    o.start(t);
    o.stop(end);
  }
  return end;
}
