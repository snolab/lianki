/**
 * Cross-device echo, the chat hub's side (docs/echo-suppression.md, layer (b)
 * and "The verdict, in one place"). His pages report what they read aloud
 * (packages/debug-chat/src/play-report.ts); the hub keeps the reports in
 * memory for voice.echoPlayKeepMs and, for each of his voice lines, asks
 * whether its time overlaps one and its words are inside it. One verdict per
 * line combines that with today's landed-time rule (lib/echo-match.ts).
 *
 * Nothing here stores anything or knows a language. Pure: the Worker imports it.
 */
import {
  echoContained,
  hashedContained,
  normalizeEcho as gramNormalize,
} from "../packages/debug-chat/src/echo";
import type { PlayFrame } from "../packages/debug-chat/src/play-report";
import { containedSimilarity, type EchoHit, normalizeEcho } from "./echo-match";

/** Defaults; the live values are config voice.echo* (lib/config.ts). */
export const ECHO_PLAY_SIMILARITY = 0.6;
export const ECHO_SLACK_MS = 1500;
export const ECHO_PLAY_KEEP_MS = 120_000;
export const ECHO_SHOW_MAX = 50;
/** The widest slack the config takes: the hub's cheap first look uses it. */
export const ECHO_SLACK_MAX = 10_000;
/** Reports kept at most, whatever their age (a runaway page cannot fill the memory). */
export const PLAY_KEEP_MAX = 300;
/** A sentence with no "played" is taken to end this long after it began. */
export const PLAY_OPEN_MAX_MS = 60_000;
/** A page time this far from the hub's is not trusted: the receive time stands in. */
const CLOCK_TRUST_MS = 30_000;
/** Past this length of the transcript (normalized), the n-gram share joins the edit distance. */
const GRAM_FROM_CHARS = 12;
const TEXT_MAX = 2000;
const GRAMS_MAX = 4000;
const REF = /^[A-Za-z0-9_:#.-]{1,80}$/;
const VOICE = /^[A-Za-z0-9_:.-]{1,40}$/;
const HASH = /^[0-9a-z]{1,8}$/;

/** A page's frame, or null for anything that is not a well-formed play report. */
export function parsePlayFrame(raw: unknown): PlayFrame | null {
  if (typeof raw !== "string" || !raw.startsWith('{"type":"play')) return null;
  if (raw.length > 64_000) return null;
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!m || typeof m !== "object" || typeof m.ref !== "string" || !REF.test(m.ref)) return null;
  const time = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
  const synced = m.synced === true ? { synced: true as const } : {};
  if (m.type === "played") {
    const to = time(m.to);
    return to === null ? null : { type: "played", ref: m.ref, to, ...synced };
  }
  if (m.type !== "playing") return null;
  const from = time(m.from);
  if (from === null || typeof m.voice !== "string" || !VOICE.test(m.voice)) return null;
  const str = (v: unknown) =>
    typeof v === "string" && v.trim() ? v.slice(0, TEXT_MAX) : undefined;
  const hashes = (v: unknown) =>
    Array.isArray(v)
      ? v.filter((x): x is string => typeof x === "string" && HASH.test(x)).slice(0, GRAMS_MAX)
      : undefined;
  const text = str(m.text);
  const alt = str(m.alt);
  const g2 = hashes(m.g2);
  const g3 = hashes(m.g3);
  if (!text && !g2?.length && !g3?.length) return null;
  return {
    type: "playing",
    ref: m.ref,
    ...(text ? { text } : {}),
    ...(alt ? { alt } : {}),
    ...(!text && g2?.length ? { g2 } : {}),
    ...(!text && g3?.length ? { g3 } : {}),
    voice: m.voice,
    from,
    ...synced,
  };
}

/** One sentence a page read aloud, on the hub's clock. */
export type PlayReport = {
  /** The page that played it (its socket's page id or label). */
  page: string;
  ref: string;
  text?: string;
  alt?: string;
  g2?: ReadonlySet<string>;
  g3?: ReadonlySet<string>;
  voice: string;
  from: number;
  to?: number;
  /** The page knew the hub's clock: from/to are its; else the receive times, and the slack doubles. */
  synced: boolean;
  /** When the hub heard of it (prunes by this). */
  seen: number;
};

/** A page time on the hub's clock: the page's own, when it is synced and plausible. */
const hubTime = (t: number, synced: boolean | undefined, hubNow: number) =>
  synced && Math.abs(t - hubNow) <= CLOCK_TRUST_MS ? t : hubNow;

/**
 * The hub's memory of play reports: its owner thread's only, never in storage.
 * Pruned on every write and read by age (`keepMs`) and count.
 */
export class PlayStore {
  private reports = new Map<string, PlayReport>();
  constructor(private max = PLAY_KEEP_MAX) {}

  /** A page's frame arrived at `hubNow`. */
  note(page: string, f: PlayFrame, hubNow: number, keepMs: number) {
    this.prune(hubNow, keepMs);
    const key = `${page}\n${f.ref}`;
    if (f.type === "played") {
      const r = this.reports.get(key);
      if (r) r.to = Math.max(r.from, hubTime(f.to, f.synced, hubNow));
      return;
    }
    this.reports.delete(key);
    this.reports.set(key, {
      page,
      ref: f.ref,
      ...(f.text ? { text: f.text } : {}),
      ...(f.alt ? { alt: f.alt } : {}),
      ...(f.g2 ? { g2: new Set(f.g2) } : {}),
      ...(f.g3 ? { g3: new Set(f.g3) } : {}),
      voice: f.voice,
      from: hubTime(f.from, f.synced, hubNow),
      synced: !!f.synced,
      seen: hubNow,
    });
    while (this.reports.size > this.max) {
      const oldest = this.reports.keys().next().value as string;
      this.reports.delete(oldest);
    }
  }

  /** Forget reports older than `keepMs`. */
  prune(hubNow: number, keepMs: number) {
    for (const [k, r] of this.reports) if (hubNow - r.seen > keepMs) this.reports.delete(k);
  }

  get size() {
    return this.reports.size;
  }

  /**
   * The reports whose span, widened by `slackMs` each side (twice that for
   * an unsynced page), overlaps [from, to]; oldest first.
   */
  overlapping(span: { from: number; to: number }, slackMs: number, hubNow: number): PlayReport[] {
    const out: PlayReport[] = [];
    for (const r of this.reports.values()) {
      const slack = r.synced ? slackMs : 2 * slackMs;
      const end = r.to ?? Math.min(hubNow, r.from + PLAY_OPEN_MAX_MS);
      if (r.from - slack <= span.to && end + slack >= span.from) out.push(r);
    }
    return out.sort((a, b) => a.from - b.from);
  }
}

/** The voice-line fields a span is read from (wire.ts VoiceTiming). */
export type SpanTiming = {
  t_speechStart?: number;
  t_speechEnd?: number;
  t_sent?: number;
  audioMs?: number;
};

/**
 * When his utterance was spoken, on the hub's clock, from what the line
 * carries: the page's own hub-clock span (`hubSpan`, from its sync-speak
 * offset) when it is plausible; else its timing moved by the hub's receive
 * time `at` (the gap from speaking to sending is the page's, so no clock is
 * needed); else a wide guess ending at `at`.
 */
export function utteranceSpan(
  at: number,
  timing?: SpanTiming,
  hubSpan?: { from: number; to: number },
): { from: number; to: number; known: boolean } {
  if (
    hubSpan &&
    hubSpan.from <= hubSpan.to &&
    hubSpan.to <= at + CLOCK_TRUST_MS &&
    at - hubSpan.from <= 10 * 60_000
  )
    return { from: hubSpan.from, to: hubSpan.to, known: true };
  const t = timing ?? {};
  if (t.t_sent !== undefined && t.t_speechEnd !== undefined && t.t_sent >= t.t_speechEnd) {
    const to = at - (t.t_sent - t.t_speechEnd);
    const start =
      t.t_speechStart !== undefined && t.t_speechStart <= t.t_speechEnd
        ? to - (t.t_speechEnd - t.t_speechStart)
        : to - (t.audioMs ?? 0);
    // A line resent much later (the outbox after a reconnect): the gap says nothing.
    if (t.t_sent - t.t_speechEnd <= 60_000) return { from: start, to, known: true };
  }
  return { from: at - (t.audioMs ?? 10_000) - 5000, to: at, known: false };
}

export type ReportHit = {
  sim: number;
  /** The voice of the report that matched best ("clone": his cloned voice). */
  voice: string;
  /** The line it read, when the ref names one ("<id>#<n>"). */
  of?: string;
  /** How long the utterance and the matched reports overlap, ms. */
  overlapMs: number;
  /** The best-matching report came from the page that sent the line. */
  samePage: boolean;
};

/** How much of `text` is inside the reports (0..1): the edit distance, and the n-gram share for longer lines. */
function inside(text: string, reports: readonly PlayReport[]): number {
  const plain = reports.filter((r) => r.text);
  let best = 0;
  if (plain.length) {
    const written = plain.map((r) => r.alt ?? r.text!).join(" ");
    const spoken = plain.map((r) => r.text!).join(" ");
    best = Math.max(containedSimilarity(text, spoken), containedSimilarity(text, written));
    if ([...gramNormalize(text)].length >= GRAM_FROM_CHARS)
      best = Math.max(best, echoContained(text, [spoken]), echoContained(text, [written]));
  }
  const hashed = reports.filter((r) => r.g2 || r.g3);
  if (hashed.length) {
    const g2 = new Set(hashed.flatMap((r) => [...(r.g2 ?? [])]));
    const g3 = new Set(hashed.flatMap((r) => [...(r.g3 ?? [])]));
    best = Math.max(best, hashedContained(text, g2, g3));
  }
  return best;
}

/**
 * The play reports his voice line `text` (spoken over `span`) echoes, or
 * undefined: the reports overlapping it in time, joined in order, contain at
 * least `similarity` of it. Lines shorter than `minChars` never match.
 */
export function echoReportMatch(
  text: string,
  reports: readonly PlayReport[],
  span: { from: number; to: number },
  conf: { similarity: number; minChars: number; slackMs: number },
  page?: string,
): ReportHit | undefined {
  if (normalizeEcho(text).length < conf.minChars || !reports.length) return undefined;
  const sim = inside(text, reports);
  if (sim < conf.similarity) return undefined;
  // Which report it was: the one that alone holds the most of it (ties: the latest).
  let top = reports[0]!;
  let topSim = -1;
  for (const r of reports) {
    const s = inside(text, [r]);
    if (s >= topSim) {
      top = r;
      topSim = s;
    }
  }
  const overlap = (r: PlayReport) => {
    const end = r.to ?? span.to;
    return Math.max(0, Math.min(end, span.to) - Math.max(r.from, span.from));
  };
  const of = top.ref.includes("#") ? top.ref.slice(0, top.ref.lastIndexOf("#")) : undefined;
  return {
    sim: Math.round(sim * 1000) / 1000,
    voice: top.voice,
    ...(of ? { of } : {}),
    overlapMs: Math.round(reports.reduce((n, r) => n + overlap(r), 0)),
    samePage: page !== undefined && top.page === page,
  };
}

/** The speaker tag fields the verdict reads (wire.ts SpeakerTag). */
export type VerdictSpeaker = {
  decision: string;
  trust?: string;
  signed?: readonly string[];
  score?: number;
  selfScore?: number;
  selfVoice?: string;
};

/** Signed by the Mac over these very words (the hub verified the proofs): a page can never make one. */
const signedTag = (s?: VerdictSpeaker): boolean =>
  !!s && (s.trust === "signed" || (!s.trust && !!s.signed?.length));

/** How far his print must beat our self print for a "me" to outvote a text match (stt.selfMeMargin). */
export const SELF_ME_MARGIN = 0.1;

/**
 * A clear "me" from the voiceprint: the Mac decided "me" AND signed these
 * very words (the hub verified the proofs). A page can never make one. When
 * the Mac also scored the line against our own voices (`selfScore`, M4), his
 * print must beat it by `selfMeMargin` (docs/echo-suppression.md, layer (b)).
 */
export const strongMe = (s?: VerdictSpeaker, selfMeMargin = SELF_ME_MARGIN): boolean =>
  s?.decision === "me" &&
  signedTag(s) &&
  (s.selfScore === undefined || s.score === undefined || s.score - s.selfScore >= selfMeMargin);

/** Our own TTS voice, heard back (the Mac's self print, M4): signed, so never a page's say-so. */
export const signedSelf = (s?: VerdictSpeaker): boolean => s?.decision === "self" && signedTag(s);

export type EchoLayer = "report" | "landed" | "self";
export type EchoVerdict = {
  kind: "read-aloud" | "other-device" | "self-voice";
  layer: EchoLayer;
  sim: number;
  /** The line it echoed, when known. */
  of?: string;
  voice?: string;
  overlapMs?: number;
  /** Not shown at all (his own words twice); else shown collapsed (flag voice.echo-reports). */
  hidden: boolean;
};

/**
 * The one verdict for a voice line (docs/echo-suppression.md, "The verdict,
 * in one place"), first match wins:
 * 0. the Mac's signed speaker tag says our own TTS voice (`self`, flag
 *    stt.self-voice: `selfOn`) → self-voice (layer "self"), shown collapsed;
 * 1. a play report overlaps in time and holds its words → read-aloud
 *    (layer "report"), unless a strong signed "me" says it was him and the
 *    voice that played was not his clone (which scores as him);
 * 2. today's landed-time rule (echoMatch) → its kind (layer "landed"):
 *    an agent line or a polish read back → read-aloud; his line from his
 *    other device → other-device, hidden;
 * 3. else none: it is his line.
 */
export function echoVerdict<K>(o: {
  report?: ReportHit;
  landed?: EchoHit<K>;
  landedOf?: string;
  speaker?: VerdictSpeaker;
  /** Flag stt.self-voice (default on): off = a "self" tag is no evidence here. */
  selfOn?: boolean;
  /** stt.selfMeMargin. */
  selfMeMargin?: number;
}): EchoVerdict | undefined {
  const r = o.report;
  if (o.selfOn !== false && signedSelf(o.speaker))
    return {
      kind: "self-voice",
      layer: "self",
      sim: o.speaker?.selfScore ?? 0,
      ...(r?.of ? { of: r.of } : o.landedOf ? { of: o.landedOf } : {}),
      ...(o.speaker?.selfVoice ? { voice: o.speaker.selfVoice } : {}),
      ...(r ? { overlapMs: r.overlapMs } : {}),
      hidden: false,
    };
  if (r && !(strongMe(o.speaker, o.selfMeMargin) && r.voice !== "clone"))
    return {
      kind: "read-aloud",
      layer: "report",
      sim: r.sim,
      ...(r.of ? { of: r.of } : {}),
      voice: r.voice,
      overlapMs: r.overlapMs,
      hidden: false,
    };
  const l = o.landed;
  if (l)
    return {
      kind: l.kind,
      layer: "landed",
      sim: Math.round(l.sim * 1000) / 1000,
      ...(o.landedOf ? { of: o.landedOf } : {}),
      hidden: l.kind === "other-device",
    };
  return undefined;
}
