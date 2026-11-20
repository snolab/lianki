/**
 * The text-level echo guard (docs/monitoring.md, "Hands-free voice"): with the
 * mic left open while the agent speaks, what leaks past the browser's echo
 * canceller comes back from STT as the agent's own words. A transcript that
 * closely matches a sentence the agent spoke in the last ECHO_WINDOW_MS is
 * dropped. Pure functions, tested in unit/echo-guard.test.ts.
 */

/** Dropped from this similarity (Dice over character n-grams) to one recent agent sentence. */
export const ECHO_SIMILARITY = 0.6;
/** Agent sentences still playing, or ended at most this long before the utterance, count. */
export const ECHO_WINDOW_MS = 10_000;
/**
 * Shorter transcripts (normalized) are dropped only when they equal a whole
 * sentence: "OK" or "はい" said by the user must not vanish because the
 * agent's sentence contained it.
 */
export const ECHO_MIN_CHARS = 4;

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** Case, width, punctuation, symbols and spaces gone: "Hello, World!" → "helloworld". */
export function normalizeEcho(s: string): string {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}\s]/gu, "");
}

/** Character n-grams with counts (the whole string when it is shorter than n). */
export function grams(s: string, n: number): Map<string, number> {
  const out = new Map<string, number>();
  const chars = [...s];
  if (chars.length && chars.length < n) out.set(s, 1);
  for (let i = 0; i + n <= chars.length; i++) {
    const g = chars.slice(i, i + n).join("");
    out.set(g, (out.get(g) ?? 0) + 1);
  }
  return out;
}

/** Dice coefficient of two n-gram bags: 2·|A∩B| / (|A|+|B|), in [0, 1]. */
export function dice(a: Map<string, number>, b: Map<string, number>): number {
  let na = 0;
  let nb = 0;
  let both = 0;
  for (const c of a.values()) na += c;
  for (const c of b.values()) nb += c;
  for (const [g, c] of a) both += Math.min(c, b.get(g) ?? 0);
  return na + nb ? (2 * both) / (na + nb) : 0;
}

export type EchoScore = {
  /** 0 … 1: 1 for a substring, else the best Dice similarity. */
  score: number;
  /** The agent text it matched best (null when nothing did). */
  against: string | null;
  /** score ≥ ECHO_SIMILARITY. */
  drop: boolean;
};

/**
 * How much `transcript` looks like the agent's own speech: compared with each
 * recent sentence, and each pair of consecutive ones (a transcript can span
 * a sentence break). Bigrams for CJK, trigrams otherwise, after normalizeEcho.
 */
export function echoScore(transcript: string, spoken: readonly string[]): EchoScore {
  const t = normalizeEcho(transcript);
  const none: EchoScore = { score: 0, against: null, drop: false };
  if (!t || !spoken.length) return none;
  const n = CJK.test(t) ? 2 : 3;
  const short = [...t].length < ECHO_MIN_CHARS;
  const cands = [...spoken];
  for (let i = 0; i + 1 < spoken.length; i++) cands.push(`${spoken[i]} ${spoken[i + 1]}`);
  const tg = grams(t, n);
  let best = none;
  for (const c of cands) {
    const nc = normalizeEcho(c);
    if (!nc) continue;
    let score: number;
    if (nc === t || (!short && nc.includes(t))) score = 1;
    else if (short) score = 0;
    else score = dice(tg, grams(nc, n));
    if (score > best.score) best = { score, against: c, drop: false };
  }
  return { ...best, score: Math.round(best.score * 1000) / 1000, drop: best.score >= ECHO_SIMILARITY };
}

/**
 * How much of `transcript` is inside `spoken` (talk-over, voice.ts
 * `duplexHeard`): the share of the transcript's n-grams (bigrams for CJK,
 * trigrams otherwise, after normalizeEcho) found in the spoken texts, in
 * [0, 1]. Containment, not Dice: a partial or a cut-off final is a fragment
 * of the sentence it echoes, and Dice would score a fragment low against the
 * whole. A transcript shorter than an n-gram scores 1 when it is a substring.
 */
export function echoContained(transcript: string, spoken: readonly string[]): number {
  const t = normalizeEcho(transcript);
  const s = spoken.map(normalizeEcho).join("");
  if (!t || !s) return 0;
  const n = CJK.test(t) ? 2 : 3;
  if ([...t].length < n) return s.includes(t) ? 1 : 0;
  const tg = grams(t, n);
  const sg = grams(s, n);
  let all = 0;
  let both = 0;
  for (const [g, c] of tg) {
    all += c;
    both += Math.min(c, sg.get(g) ?? 0);
  }
  return all ? both / all : 0;
}

/**
 * The page's echo guard with a time window (docs/echo-suppression.md, layer
 * (a)): a sentence this page played whose time overlaps the utterance
 * (`ECHO_SLACK_MS` each side: the room, the VAD's frames, the output latency)
 * is matched by containment (`echoContained`), so a fragment of a long
 * sentence heard back is caught; the old whole-sentence Dice over the last
 * ECHO_WINDOW_MS stays as well. Either at ECHO_SIMILARITY or more drops it.
 */
export const ECHO_SLACK_MS = 1500;

/** One sound the page played: its words and when (page clock). */
export type SaidSpan = { text: string; start: number; end?: number };

export type EchoGuard = EchoScore & {
  /** A sentence was playing during the utterance (no slack). */
  during: boolean;
  /** The containment of the transcript in the sentences overlapping it in time (0 without any). */
  contained: number;
};

/**
 * Judge `transcript`, heard from `from` to `to` (page clock), against what
 * the page said. `now` closes a sentence still playing.
 */
export function echoGuard(
  transcript: string,
  said: readonly SaidSpan[],
  from: number,
  to: number,
  now: number,
  o: { windowMs?: number; slackMs?: number } = {},
): EchoGuard {
  const windowMs = o.windowMs ?? ECHO_WINDOW_MS;
  const slack = o.slackMs ?? ECHO_SLACK_MS;
  const recent = said.filter((r) => (r.end ?? now) >= from - windowMs).map((r) => r.text);
  const during = said.some((r) => r.start <= to && (r.end ?? now) >= from);
  const dice = echoScore(transcript, recent);
  const over = said.filter((r) => r.start <= to + slack && (r.end ?? now) + slack >= from);
  const long = [...normalizeEcho(transcript)].length >= ECHO_MIN_CHARS;
  const raw = over.length && long ? echoContained(transcript, over.map((r) => r.text)) : 0;
  const contained = Math.round(raw * 1000) / 1000;
  if (contained > dice.score)
    return {
      score: contained,
      against: over.map((r) => r.text).join(" "),
      drop: contained >= ECHO_SIMILARITY,
      during,
      contained,
    };
  return { ...dice, during, contained };
}

/**
 * A short, stable hash of one n-gram (FNV-1a, 32 bits, base 36): what a
 * private screen sends instead of its words (play-report.ts), so the hub can
 * still measure containment without any readable text leaving the page.
 */
export function hashGram(g: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < g.length; i++) {
    h ^= g.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** The distinct hashed n-grams of a text, after normalizeEcho (the whole text when shorter than n). */
export function gramHashes(text: string, n: number): string[] {
  return [...new Set([...grams(normalizeEcho(text), n).keys()].map(hashGram))];
}

/**
 * echoContained against hashed n-grams (a private screen's report): the share
 * of the transcript's n-grams, bigrams for CJK and trigrams otherwise, whose
 * hash is in `g2` / `g3`.
 */
export function hashedContained(
  transcript: string,
  g2: ReadonlySet<string>,
  g3: ReadonlySet<string>,
): number {
  const t = normalizeEcho(transcript);
  if (!t) return 0;
  const n = CJK.test(t) ? 2 : 3;
  const set = n === 2 ? g2 : g3;
  if (!set.size) return 0;
  let all = 0;
  let both = 0;
  for (const [g, c] of grams(t, n)) {
    all += c;
    if (set.has(hashGram(g))) both += c;
  }
  return all ? both / all : 0;
}
