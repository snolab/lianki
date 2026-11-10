/**
 * The owner's voiceprint, the page's side (docs/local-stt.md, "Voiceprint"):
 * enrolment on this device, the "delete my voiceprint" control, and the
 * speaker tags that ride on voice lines. The print lives on his Mac, beside
 * the local STT server (scripts/local-stt/voiceprint.py,
 * ~/.config/lianki-stt/voiceprints); the page sends the audio of the
 * sentences he reads only to that server, over the same socket as speech, and
 * never to lianki.com, the cloud STT or the clip sink. With the flag
 * `stt.voiceprint-cloud`, "Save to my account" copies the print's FEATURES
 * (numbers, never audio) into his own account, encrypted, after his passkey
 * (app/api/my/voiceprint, lib/voiceprint-cloud.ts); "Restore" brings them back.
 *
 * Consent: nothing is captured for enrolment until he taps "I agree, start"
 * on the consent card, which says what is kept and where. `consent()` is the
 * only way into the recording step, and the server refuses an enrolment
 * without `consent: true` as well. Deleting is a tap too, confirmed. Voice
 * commands can do neither (docs/dev-debug-widget.md: turning recording on is
 * always a tap).
 *
 * Pure: the socket and the mic are injected, so all of it is unit-tested.
 */
import type { EnrolSentence, LocalFinal } from "./local-stt";
import { type SpeakerTag, combineSpeaker } from "./wire";

/** localStorage: this device's slug, when the guess from the user agent is wrong. */
export const VOICE_DEVICE_KEY = "lk:agent-voice-device";

/** This device's slug for the store ("iphone", "android", "mac", …): one print per device. */
export function deviceSlug(ua: string, override?: string | null): string {
  if (override && /^[a-z0-9][a-z0-9-]{0,31}$/.test(override)) return override;
  if (/iPhone/.test(ua)) return "iphone";
  if (/iPad/.test(ua)) return "ipad";
  if (/Android/.test(ua)) return "android";
  if (/Macintosh|Mac OS X/.test(ua)) return "mac";
  if (/Windows/.test(ua)) return "windows";
  if (/Linux|X11/.test(ua)) return "linux";
  return "other";
}

/**
 * What he reads at enrolment. In his three languages, since the print should
 * hear how he speaks each of them (mostly Chinese, as he does), 3-6 s each,
 * and not translated: they are reading material, not interface. Plain words,
 * no numbers or product names, so a misheard word is not a misread sentence.
 */
export const ENROL_SENTENCES: readonly string[] = [
  "今天的天气不错，我想出去走一走。",
  "这个周末我打算在家里好好休息一下。",
  "请把桌子上的那本书递给我，谢谢。",
  "我们下午三点在车站门口见面吧。",
  "学习一门新的语言需要耐心和坚持。",
  "早上喝一杯热茶，整个人都精神了。",
  "麻烦你帮我看一下这个问题怎么解决。",
  "昨天晚上下了一场很大的雨。",
  "我最近在读一本关于历史的书。",
  "超市里的水果比上个星期便宜了一些。",
  "如果明天有空的话，我们一起去吃饭吧。",
  "这条路一直往前走，就能看到那家咖啡店。",
  "今日はいい天気なので、少し散歩に行きます。",
  "駅の前で待っているので、着いたら連絡してください。",
  "この本はとても面白くて、一晩で読みました。",
  "明日の朝は早く起きなければなりません。",
  "I would like a cup of coffee and a glass of water, please.",
  "The library is open until nine o'clock in the evening.",
  "We walked along the river and talked about the weekend.",
  "Could you tell me how to get to the train station?",
];
/** Kept at least / at most (scripts/local-stt/voiceprint.py ENROL_MIN, ENROL_MAX). */
export const ENROL_MIN = 10;
export const ENROL_MAX = 20;

/** Letters only, lower case: punctuation, spaces and width do not count. */
const letters = (s: string) =>
  s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");

/**
 * The heard text is this sentence (loosely: SenseVoice gets words wrong in
 * noise, and a homophone is still the sentence): at least half of the
 * sentence's characters, in order (LCS). Empty text never matches.
 */
export function matchesPrompt(heard: string, prompt: string): boolean {
  const a = letters(heard);
  const b = letters(prompt);
  if (!a || !b) return false;
  const prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let diag = 0;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j]!;
      prev[j] = a[i - 1] === b[j - 1] ? diag + 1 : Math.max(prev[j]!, prev[j - 1]!);
      diag = up;
    }
  }
  return prev[b.length]! >= Math.ceil(b.length * 0.5);
}

// ---------------------------------------------------------------- tags on voice lines
type Noted = { tag?: SpeakerTag; proof?: string };
/** The tags of the utterances in the draft since the last send (page-wide: a hot swap keeps them). */
const TAGS_KEY = "__lkSpeakerTags";
const tagList = (): Noted[] => {
  const g = globalThis as unknown as Record<string, Noted[] | undefined>;
  return (g[TAGS_KEY] ??= []);
};
/**
 * An utterance's final landed in the draft: its tag and the Mac's signed proof
 * (or none: the cloud, or no check on the Mac).
 */
export function noteSpeaker(tag: SpeakerTag | undefined, proof?: string): void {
  const l = tagList();
  l.push({ tag, proof });
  if (l.length > 50) l.splice(0, l.length - 50);
}
/**
 * The line is sent: what the page saw (`tag`, the weakest; "unknown" when an
 * utterance had none) and the proofs it passes on. Only the hub's check of the
 * proofs (lib/speaker-proof.ts) puts a tag on the stored line: a line with an
 * unproven utterance gets none there.
 */
export function takeSpeaker(): { tag?: SpeakerTag; proofs?: string[] } {
  const l = tagList().splice(0);
  if (!l.some((n) => n.tag)) return {};
  const tags = l.map((n) => n.tag);
  const tag = tags.some((t) => !t)
    ? { ...combineSpeaker(tags)!, decision: "unknown" as const, reason: "untagged" }
    : combineSpeaker(tags);
  const proofs = l.every((n) => n.proof) ? l.map((n) => n.proof!) : undefined;
  return { tag, ...(proofs ? { proofs } : {}) };
}
/** Typed text replaced the dictation: the tags no longer describe the draft. */
export function clearSpeaker(): void {
  tagList().splice(0);
}

// ---------------------------------------------------------------- the filter
// "Only my voice" (docs/local-stt.md): the Mac drops finals that do not match
// his print. It is the /dev/flags switch and this device's pause; the tally
// below is what he sees of it, on this device only: counts and the last reason,
// never any text. Not a security gate: voice approves nothing either way.

/** localStorage: "off" pauses the filter on this device, whatever the flag says. */
export const VOICE_FILTER_KEY = "lk:agent-voice-filter";
/** localStorage: today's tally on this device (FilterTally). */
export const VOICE_FILTERED_KEY = "lk:agent-voice-filtered";
/** How long the flag's answer is kept: at most this after a change, at the next utterance. */
export const FILTER_FLAG_TTL_MS = 30_000;

export type FilterTally = {
  /** Local date, YYYY-MM-DD: the counts are for this day. */
  day: string;
  /** Stopped by the filter. */
  n: number;
  /** Would have been stopped, while the filter was not on (the line still landed). */
  would: number;
  reason?: string;
  score?: number;
};
export type FilterInfo = {
  /** The /dev/flags switch. */
  flag: boolean;
  paused: boolean;
  /** The Mac's word: "on", "no-print" (this device has none), "off" (its check is off or broken). */
  state: string;
  tally: FilterTally;
};

const today = () => new Date().toLocaleDateString("en-CA");
const store = () => {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
};
export function readTally(): FilterTally {
  const fresh: FilterTally = { day: today(), n: 0, would: 0 };
  try {
    const t = JSON.parse(store()?.getItem(VOICE_FILTERED_KEY) ?? "null") as FilterTally | null;
    if (t && t.day === fresh.day && typeof t.n === "number" && typeof t.would === "number") return t;
  } catch {}
  return fresh;
}
const filteredSubs = new Set<() => void>();
/** A stopped final, for the mic's note; returns an unsubscribe. */
export function subscribeFiltered(f: () => void): () => void {
  filteredSubs.add(f);
  return () => void filteredSubs.delete(f);
}
/** Count one final: stopped, or (the filter not on) one it would have stopped. Never any text. */
export function noteFiltered(kind: "filtered" | "would", v: { reason?: string; score?: number }): FilterTally {
  const t = readTally();
  if (kind === "filtered") t.n++;
  else t.would++;
  if (v.reason) t.reason = v.reason;
  if (typeof v.score === "number") t.score = v.score;
  try {
    store()?.setItem(VOICE_FILTERED_KEY, JSON.stringify(t));
  } catch {}
  if (kind === "filtered") for (const f of filteredSubs) f();
  return t;
}
/** Count a final's verdict and log it (never its text). True: the filter stopped it, so it goes nowhere. */
export function filterVerdict(
  f: Pick<LocalFinal, "filtered" | "wouldFilter" | "speaker">,
  durationMs: number,
  log?: (ev: Record<string, unknown>) => void,
): boolean {
  if (f.filtered) {
    const { n } = noteFiltered("filtered", f.filtered);
    log?.({ ev: "voice-filtered", durationMs, n, ...f.filtered });
    return true;
  }
  if (f.wouldFilter) {
    const score = f.speaker?.score;
    const { would } = noteFiltered("would", { reason: f.wouldFilter, score });
    log?.({ ev: "voice-would-filter", durationMs, would, reason: f.wouldFilter, score });
  }
  return false;
}
export function filterPaused(): boolean {
  try {
    return store()?.getItem(VOICE_FILTER_KEY) === "off";
  } catch {
    return false;
  }
}
export function setFilterPaused(on: boolean): void {
  try {
    if (on) store()?.setItem(VOICE_FILTER_KEY, "off");
    else store()?.removeItem(VOICE_FILTER_KEY);
  } catch {}
}
/** The /dev/flags switch (owner only: anyone else, and any failure, reads as off). */
export async function filterFlag(f: typeof fetch = fetch): Promise<boolean> {
  try {
    const r = await f("/api/dev/voice-filter", { headers: { accept: "application/json" } });
    return r.ok && (await r.json()).on === true;
  } catch {
    return false;
  }
}
/**
 * For the mic's socket (local-stt.ts `filter`): whether the filter is on for
 * the next utterance. Asked at each utterance, never by a timer; a pause counts
 * at once, a flag change after at most FILTER_FLAG_TTL_MS.
 */
export function filterSwitch(ask: () => Promise<boolean> = filterFlag, now: () => number = Date.now) {
  let at = -Infinity;
  let last: Promise<boolean> = Promise.resolve(false);
  return (): Promise<boolean> | boolean => {
    if (filterPaused()) return false;
    if (now() - at >= FILTER_FLAG_TTL_MS) {
      at = now();
      last = ask().catch(() => false);
    }
    return last;
  };
}

// ---------------------------------------------------------------- the enrolment card
export type PrintInfo = { device: string; model: string; n: number; updated?: string; audio?: boolean };

export type EnrolView =
  | { step: "closed" }
  /** Asking the Mac what is enrolled. */
  | { step: "loading" }
  /** What is enrolled, with Enrol and Delete. `local`: false when the Mac's check is off or unreachable. */
  | {
      step: "status";
      prints: PrintInfo[];
      local: boolean;
      filter?: FilterInfo;
      /** The copy in his account (undefined: the feature is off for this account). */
      cloud?: CloudInfo;
      /** The last save, restore or delete of the account copy. */
      cloudOp?: CloudOp;
    }
  /** Before anything is recorded: what is kept, where; a tap to agree. */
  | { step: "consent"; keepAudio: boolean }
  /** Reading: sentence `index`, `kept` so far, and why the last one was not kept. */
  | { step: "recording"; index: number; kept: number; again?: AgainReason; heard?: string }
  | { step: "saving"; kept: number }
  | { step: "saved"; kept: number; cloud?: CloudInfo; cloudOp?: CloudOp }
  /** What the delete will reach: the Mac (when it answered), the account copy (when there is one). */
  | { step: "confirm-delete"; local?: boolean; cloud?: CloudInfo }
  | {
      step: "deleted";
      files: number;
      cloudError?: string;
      /**
       * His recordings in My Files → Voiceprint: offered for deletion by a
       * separate tap (never deleted with the voiceprint itself).
       */
      recordings?: { n: number; state: "offer" | "busy" | "done" | "failed"; error?: string };
      /**
       * The enrolment recordings kept on the Mac (`<device>.audio/`): never
       * deleted with the print (owner, 2026-11-11). Offered by a separate
       * question, kept unless he taps "delete them" (and the passkey, or the window).
       */
      mac?: { n: number; state: "offer" | "busy" | "done" | "kept" | "failed"; error?: string };
    }
  /** "Test my voiceprint": he speaks, the Mac scores it; nothing is kept. */
  | {
      step: "test";
      /** The mic is routed to the test (false: starting, or the mic was refused). */
      listening: boolean;
      results: TestResult[];
      tally: TestTally;
      bands?: Record<string, ModelBands>;
      filter?: FilterInfo;
      error?: string;
    }
  | { step: "error"; error: string };

/** The decision's thresholds for one model, as the Mac reports them (voiceprint.py bands_info). */
export type ModelBands = {
  minSpeechS: number;
  minSnrDb: number;
  bands: { minS: number; me: number; other: number }[];
  provisional?: boolean;
};
/**
 * The bands in docs/local-stt.md ("Verification"), for a Mac that does not
 * report its own yet: the page never decides, it only shows what was used.
 */
export const DEFAULT_BANDS: Record<string, ModelBands> = {
  campp: {
    minSpeechS: 1.5,
    minSnrDb: 10,
    bands: [
      { minS: 1.5, me: 0.28, other: 0.18 },
      { minS: 3, me: 0.3, other: 0.2 },
    ],
  },
};
/** The band a final of `speechS` seconds was judged by (null: too short for any). */
export function bandFor(b: ModelBands | undefined, speechS: number | undefined) {
  if (!b || typeof speechS !== "number") return null;
  let out: ModelBands["bands"][number] | null = null;
  for (const x of b.bands) if (speechS >= x.minS) out = x;
  return out;
}
export type TestTally = { me: number; other: number; unknown: number };
/** One test line: the Mac's verdict on it (never its text or audio). */
export type TestResult = {
  decision: "me" | "other" | "unknown" | "unreachable";
  score?: number;
  model?: string;
  device?: string;
  reason?: string;
  speechS?: number;
  snrDb?: number;
  /** The "only my voice" filter stopped it (on), or would have (off). */
  filtered?: "stopped" | "would";
};
/** A final of the test as shown: the speaker tag, the filter's word; text and audio dropped. */
export function testResult(f: LocalFinal | null): TestResult {
  const s = f?.speaker;
  if (!f || !s) return { decision: "unreachable" };
  return {
    decision: s.decision,
    ...(typeof s.score === "number" ? { score: s.score } : {}),
    ...(s.model ? { model: s.model } : {}),
    ...(s.device ? { device: s.device } : {}),
    ...(s.reason ? { reason: s.reason } : {}),
    ...(typeof s.speechS === "number" ? { speechS: s.speechS } : {}),
    ...(typeof s.snrDb === "number" ? { snrDb: s.snrDb } : {}),
    ...(f.filtered ? { filtered: "stopped" as const } : f.wouldFilter ? { filtered: "would" as const } : {}),
  };
}
/** How many test lines the panel keeps on screen (the tally counts them all). */
export const TEST_SHOWN = 5;

/** An enrolment under way: sentences being recorded or saved, lost if the page goes (lib/page-dirty.ts). */
export const enrolBusy = (v: EnrolView) => v.step === "recording" || v.step === "saving";

/** A failed read of the account copy reads as "none" (it never blocks the panel). */
const orNull = () => null;
const orNone = (): StoredRecording[] => [];
const ignore = () => {};

/** How long the Mac may take to hand over the features and the kept recordings (a few MB). */
export const EXPORT_TIMEOUT_MS = 60_000;

/** The account copy: device prints saved there (features only, never audio). */
export type CloudInfo = {
  prints: { device: string; model: string; n: number; updatedAt?: string }[];
  /** His enrolment recordings kept in My Files → Voiceprint (how many). */
  recordings?: number;
  /** Who computes features from recordings (config voiceprint.extractor). */
  extractor?: string;
};
export type CloudOp =
  | { kind: "save" | "restore" | "recompute"; state: "busy" }
  | { kind: "save" | "restore" | "recompute"; state: "done"; n: number; files?: number }
  | { kind: "save" | "restore" | "recompute" | "delete"; state: "failed"; error: string };

/** One of his recordings in My Files (GET /api/import/files?source=voiceprint). */
export type StoredRecording = { id: string; name: string };
/** A recording the Mac kept (`<device>.audio/NN.wav`), handed over by the ticketed export. */
export type MacRecording = { device: string; name: string; created?: string | null; wav: string };

/**
 * The name a recording gets in My Files: device, enrolment date, sentence
 * number ("voiceprint iphone 2026-11-10 01.wav"). The same recording always
 * gets the same name, so saving again never stores it twice.
 */
export function recordingName(r: Pick<MacRecording, "device" | "name" | "created">): string {
  const day = typeof r.created === "string" && /^\d{4}-\d{2}-\d{2}/.test(r.created) ? r.created.slice(0, 10) : "undated";
  const nn = /^(\d{2})\.wav$/.exec(r.name)?.[1] ?? "00";
  return `voiceprint ${r.device} ${day} ${nn}.wav`;
}
/** The device a My Files recording belongs to, from its name (recordingName). */
export const recordingDevice = (name: string) =>
  /^voiceprint ([a-z0-9][a-z0-9-]{0,31}) /.exec(name)?.[1] ?? null;

/** A 16-bit mono WAV (as voiceprint.py writes them) as samples in -1..1; null if not one. */
export function wavSamples(buf: ArrayBuffer): Float32Array | null {
  const v = new DataView(buf);
  if (buf.byteLength < 44 || v.getUint32(0, false) !== 0x52494646 || v.getUint32(8, false) !== 0x57415645)
    return null;
  let off = 12;
  let fmtOk = false;
  while (off + 8 <= buf.byteLength) {
    const id = v.getUint32(off, false);
    const size = v.getUint32(off + 4, true);
    const body = off + 8;
    if (id === 0x666d7420) {
      // "fmt ": PCM, mono, 16 kHz, 16 bit
      fmtOk =
        v.getUint16(body, true) === 1 &&
        v.getUint16(body + 2, true) === 1 &&
        v.getUint32(body + 4, true) === 16_000 &&
        v.getUint16(body + 14, true) === 16;
    } else if (id === 0x64617461) {
      if (!fmtOk) return null;
      const n = Math.floor(Math.min(size, buf.byteLength - body) / 2);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = v.getInt16(body + i * 2, true) / 32768;
      return out;
    }
    off = body + size + (size % 2);
  }
  return null;
}

/**
 * Computing features from recordings (owner, 2026-11-10): one interface, so
 * the Mac (the first and, in development, only implementation) can later be
 * replaced by a cloud worker, chosen by config (`voiceprint.extractor`). It
 * returns the features (export form) and the approval lianki.com takes to
 * store them.
 */
export type FeatureExtractor = {
  id: string;
  extract(
    device: string,
    clips: Float32Array[],
  ): Promise<{ prints: Record<string, unknown>[]; ticket: string; kept: number }>;
};

/** What leaves the Mac for the account: features only (lib/voiceprint-cloud.ts PRINT_KEYS). */
export const CLOUD_PRINT_KEYS = [
  "device",
  "model",
  "dim",
  "n",
  "created",
  "updated",
  "self",
  "speechS",
  "centroid",
  "embeddings",
] as const;
/** Exactly the feature keys of a print, whatever else the Mac or the account sent. */
export function featuresOnly(p: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of CLOUD_PRINT_KEYS) if (k in p && p[k] !== undefined) out[k] = p[k];
  return out;
}

/** The account side (app/api/my/voiceprint): own rows only; writes carry a passkey ticket. */
export type CloudDeps = {
  /** The account's rows, or null when the feature is off for this account (404). */
  list(): Promise<CloudInfo | null>;
  /** Every row with its features (the session only). */
  features(): Promise<Record<string, unknown>[]>;
  put(ticket: string, prints: Record<string, unknown>[]): Promise<number>;
  delete(ticket: string, device: string): Promise<number>;
  /** My Files → Voiceprint: his recordings (own files only, same-origin writes). */
  recordings: {
    list(): Promise<StoredRecording[]>;
    upload(name: string, bytes: Uint8Array): Promise<void>;
    download(id: string): Promise<ArrayBuffer>;
    delete(id: string): Promise<void>;
  };
};

export type AgainReason = "short" | "noise" | "mismatch" | "text" | "unreachable";

/** What the card needs of the page (the local STT socket, the mic session). */
export type EnrolDeps = {
  /** A voiceprint request to the Mac (local-stt.ts request on the panel's own socket). */
  request(
    msg: Record<string, unknown>,
    o?: { timeoutMs?: number },
  ): Promise<Record<string, unknown>>;
  /**
   * One enrolment sentence from a recording (re-compute): streamed to the Mac
   * on the panel's socket as if just read; its final carries the verdict.
   */
  utter?(audio: Float32Array, enrolment: string): Promise<LocalFinal>;
  /**
   * A voiceprint ticket from lianki.com for this op (app/api/dev/voiceprint-ticket):
   * status with the owner session; enrol and delete only after the owner's
   * passkey with Face ID / Touch ID (webauthn.ts). The Mac takes no op without one.
   */
  ticket(
    op: "status" | "enrol" | "delete" | "delete-audio" | "export" | "restore",
    device: string,
    o?: { keepAudio?: boolean },
  ): Promise<string>;
  /**
   * "Test my voiceprint": on, each utterance goes to the Mac as a plain final
   * (scored against this device's print) and only to `onFinal`: never the
   * draft, the cloud or the clip sink, so nothing is kept; off, back to the chat.
   */
  testCapture?(on: boolean, onFinal: (f: Promise<LocalFinal> | null) => void): Promise<void> | void;
  /** This device's slug. */
  device: string;
  /**
   * Route the mic's utterances to the enrolment (on) or back to the chat
   * (off); `on` also turns the mic on if it was off (the tap on "I agree" is
   * the gesture getUserMedia needs).
   */
  capture(
    on: boolean,
    onFinal: (f: Promise<LocalFinal> | null) => void,
    id?: string,
  ): Promise<void> | void;
  /** The "Only my voice" line of the panel: `state` is the Mac's word, in its status answer. */
  filterInfo?(state: string): Promise<FilterInfo>;
  /** The copy in his account; absent: no such feature on this page. */
  cloud?: CloudDeps;
  log?: (ev: Record<string, unknown>) => void;
};

/**
 * The card's state machine. Every step that captures audio or changes the
 * print is a method the card calls from a tap; nothing here starts by
 * itself, except the save once ENROL_MAX sentences are kept.
 */
export function createEnrolment(d: EnrolDeps, onChange: (v: EnrolView) => void) {
  let view: EnrolView = { step: "closed" };
  /** Bumped when the card closes or restarts: an answer for an older run is ignored. */
  let run = 0;
  /** The open enrolment's id on the Mac (from its start answer). */
  let eid = "";
  /** The Mac's decision thresholds, from its last status answer (the test shows them). */
  let bands: Record<string, ModelBands> = DEFAULT_BANDS;
  /** The test mode holds the mic (testCapture on). */
  let testing = false;
  const stopTest = () => {
    if (!testing) return;
    testing = false;
    try {
      void d.testCapture?.(false, () => {});
    } catch {}
  };
  const cancelOnMac = () => {
    if (!eid) return;
    const id = eid;
    eid = "";
    void d.request({ t: "enrol", op: "cancel", enrolment: id }).catch(() => {});
  };
  const set = (v: EnrolView) => {
    view = v;
    onChange(v);
  };
  const fail = (e: unknown) => set({ step: "error", error: String((e as Error)?.message ?? e).slice(0, 120) });
  const ok = (r: Record<string, unknown>) => {
    if (r.ok !== true) throw new Error(typeof r.error === "string" ? r.error : "refused");
    return r;
  };
  const stopCapture = () => {
    try {
      void d.capture(false, () => {});
    } catch {}
  };

  const onFinal = (my: number) => async (p: Promise<LocalFinal> | null) => {
    if (my !== run || view.step !== "recording") return;
    const v = view;
    if (!p) return set({ ...v, again: "unreachable", heard: undefined });
    let f: LocalFinal;
    try {
      f = await p;
    } catch {
      if (my === run && view.step === "recording") set({ ...view, again: "unreachable", heard: undefined });
      return;
    }
    if (my !== run || view.step !== "recording") return;
    const cur = view;
    const e: EnrolSentence | undefined = f.enrol;
    const prompt = ENROL_SENTENCES[cur.index % ENROL_SENTENCES.length]!;
    d.log?.({ ev: "voiceprint-sentence", ok: !!e?.ok, reason: e?.reason, n: e?.n });
    if (!e?.ok) {
      const r = e?.reason;
      const again: AgainReason = r === "noise" ? "noise" : r === "mismatch" ? "mismatch" : r === "short" ? "short" : "unreachable";
      return set({ ...cur, again, heard: f.text });
    }
    // Kept by the Mac; the text check is the page's: a line that is not the
    // sentence still teaches his voice, so it is kept, but the card asks
    // again for this one (and moves on after a second try).
    const kept = e.n;
    const textOk = matchesPrompt(f.text, prompt);
    const next = textOk || cur.again === "text" ? cur.index + 1 : cur.index;
    if (kept >= ENROL_MAX || (next >= ENROL_SENTENCES.length && kept >= ENROL_MIN)) return void save(my, kept);
    set({ step: "recording", index: next, kept, ...(textOk || next !== cur.index ? {} : { again: "text" as const }), heard: f.text });
  };

  const save = async (my: number, kept: number) => {
    if (kept < ENROL_MIN) return;
    stopCapture();
    set({ step: "saving", kept });
    try {
      const r = ok(await d.request({ t: "enrol", op: "commit", enrolment: eid }));
      eid = "";
      if (my !== run) return;
      d.log?.({ ev: "voiceprint-saved", n: r.n });
      const cloud = (await d.cloud?.list().catch(orNull)) ?? undefined;
      if (my !== run) return;
      set({ step: "saved", kept: typeof r.n === "number" ? r.n : kept, ...(cloud ? { cloud } : {}) });
      // The account copy is on for him: save it there too, at once (his passkey again).
      if (cloud) await saveToAccount(my);
    } catch (e) {
      if (my === run) fail(e);
    }
  };

  /** The account copy's state on the current view (status or saved). */
  const setCloud = (my: number, o: { op?: CloudOp; cloud?: CloudInfo }) => {
    if (my !== run || (view.step !== "status" && view.step !== "saved")) return;
    set({ ...view, ...(o.op ? { cloudOp: o.op } : {}), ...(o.cloud ? { cloud: o.cloud } : {}) });
  };
  const errText = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 120);
  /**
   * "Save to my account": one passkey approval; the Mac hands over the
   * features (numbers only) and the recordings it kept (the opt-in audio);
   * lianki.com keeps the features encrypted, and the recordings go to My
   * Files → Voiceprint (his private file store), each once (by name). Nothing
   * on the Mac is moved or deleted.
   */
  const saveToAccount = async (my: number) => {
    const cl = d.cloud;
    if (!cl) return;
    setCloud(my, { op: { kind: "save", state: "busy" } });
    try {
      const ticket = await d.ticket("export", "*");
      if (my !== run) return;
      const r = ok(
        await d.request(
          { t: "voiceprint", op: "export", device: "*", ticket, recordings: true },
          { timeoutMs: EXPORT_TIMEOUT_MS },
        ),
      );
      const prints = (Array.isArray(r.prints) ? (r.prints as Record<string, unknown>[]) : []).map(
        featuresOnly,
      );
      if (!prints.length) throw new Error("nothing on the Mac to save");
      const n = await cl.put(ticket, prints);
      d.log?.({ ev: "voiceprint-cloud-saved", n });
      const files = await uploadRecordings(
        cl,
        Array.isArray(r.recordings) ? (r.recordings as MacRecording[]) : [],
      );
      const cloud = (await cl.list().catch(orNull)) ?? undefined;
      setCloud(my, { op: { kind: "save", state: "done", n, files }, cloud });
    } catch (e) {
      setCloud(my, { op: { kind: "save", state: "failed", error: errText(e) } });
    }
  };
  /** The Mac's kept recordings into My Files → Voiceprint, skipping those already there. */
  const uploadRecordings = async (cl: CloudDeps, recs: MacRecording[]) => {
    if (!recs.length) return 0;
    const have = new Set((await cl.recordings.list()).map((f) => f.name));
    let n = 0;
    for (const rec of recs) {
      if (typeof rec?.wav !== "string" || typeof rec.device !== "string") continue;
      const name = recordingName(rec);
      if (have.has(name)) continue;
      const bin = atob(rec.wav);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      if (!wavSamples(bytes.buffer)) continue; // only the Mac's own 16 kHz mono wavs
      await cl.recordings.upload(name, bytes);
      have.add(name);
      n++;
    }
    d.log?.({ ev: "voiceprint-recordings-saved", n });
    return n;
  };
  /**
   * The Mac as the feature extractor (config voiceprint.extractor = "mac"):
   * a passkey enrol ticket for the device, an enrolment fed with the
   * recordings instead of live reading (the same checks per sentence), saved
   * on the Mac, and its new features handed back under that approval.
   */
  const macExtractor: FeatureExtractor = {
    id: "mac",
    async extract(device, clips) {
      if (!d.utter) throw new Error("the Mac cannot take recordings here");
      const ticket = await d.ticket("enrol", device, { keepAudio: false });
      const st = ok(
        await d.request({ t: "enrol", op: "start", device, consent: true, keepAudio: false, ticket }),
      );
      const id = String(st.enrolment ?? "");
      if (!id) throw new Error("no enrolment");
      let kept = 0;
      try {
        for (const c of clips) {
          const f = await d.utter(c, id);
          if (f.enrol?.ok) kept = f.enrol.n;
          if (kept >= ENROL_MAX) break;
        }
        if (kept < ENROL_MIN) throw new Error(`only ${kept} of the recordings were usable`);
        const r = ok(await d.request({ t: "enrol", op: "commit", enrolment: id, export: true }));
        const prints = (Array.isArray(r.prints) ? (r.prints as Record<string, unknown>[]) : []).map(
          featuresOnly,
        );
        return { prints, ticket, kept };
      } catch (e) {
        void d.request({ t: "enrol", op: "cancel", enrolment: id }).catch(ignore);
        throw e;
      }
    },
  };
  const extractors: Record<string, FeatureExtractor> = { mac: macExtractor };
  /**
   * "Re-compute from my recordings" (a future model, a new Mac): the
   * recordings in My Files → Voiceprint, through the configured extractor,
   * stored as the device's new features on the Mac and in the account.
   */
  const recompute = async (my: number, extractorId: string) => {
    const cl = d.cloud;
    if (!cl) return;
    setCloud(my, { op: { kind: "recompute", state: "busy" } });
    try {
      const ex = extractors[extractorId];
      if (!ex) throw new Error(`no extractor "${extractorId}"`);
      const byDevice = new Map<string, StoredRecording[]>();
      for (const f of await cl.recordings.list()) {
        const dev = recordingDevice(f.name);
        if (dev) byDevice.set(dev, [...(byDevice.get(dev) ?? []), f]);
      }
      if (!byDevice.size) throw new Error("no recordings in My Files");
      let n = 0;
      for (const [device, files] of byDevice) {
        const clips: Float32Array[] = [];
        for (const f of files.sort((a, b) => a.name.localeCompare(b.name))) {
          const s = wavSamples(await cl.recordings.download(f.id));
          if (s) clips.push(s);
        }
        if (my !== run) return;
        const out = await ex.extract(device, clips);
        if (!out.prints.length) throw new Error("no features came back");
        n += await cl.put(out.ticket, out.prints);
      }
      d.log?.({ ev: "voiceprint-recomputed", n });
      const cloud = (await cl.list().catch(orNull)) ?? undefined;
      setCloud(my, { op: { kind: "recompute", state: "done", n }, cloud });
    } catch (e) {
      setCloud(my, { op: { kind: "recompute", state: "failed", error: errText(e) } });
    }
  };
  /** "Restore from my account": the account's features back onto the Mac (a new Mac). */
  const restoreFromAccount = async (my: number) => {
    const cl = d.cloud;
    if (!cl) return;
    setCloud(my, { op: { kind: "restore", state: "busy" } });
    try {
      const ticket = await d.ticket("restore", "*");
      if (my !== run) return;
      const prints = (await cl.features()).filter((p) => !p.unreadable).map(featuresOnly);
      if (!prints.length) throw new Error("nothing in the account to restore");
      const r = ok(await d.request({ t: "voiceprint", op: "restore", device: "*", ticket, prints }));
      const n = Array.isArray(r.restored) ? r.restored.length : prints.length;
      d.log?.({ ev: "voiceprint-cloud-restored", n });
      if (my !== run) return;
      await api.open();
      if (view.step === "status") set({ ...view, cloudOp: { kind: "restore", state: "done", n } });
    } catch (e) {
      setCloud(my, { op: { kind: "restore", state: "failed", error: errText(e) } });
    }
  };

  const api = {
    view: () => view,
    /** The menu's "Voiceprint": what is enrolled. */
    async open() {
      const my = ++run;
      stopTest();
      set({ step: "loading" });
      try {
        // A read-only owner ticket: the Mac answers nothing without one.
        const ticket = await d.ticket("status", "*");
        const r = await d.request({ t: "voiceprint", op: "status", ticket });
        if (my !== run) return;
        const prints = Array.isArray(r.prints) ? (r.prints as PrintInfo[]) : [];
        bands =
          r.bands && typeof r.bands === "object" && !Array.isArray(r.bands)
            ? (r.bands as Record<string, ModelBands>)
            : DEFAULT_BANDS;
        // Never in the way of the rest of the panel.
        const filter = await d.filterInfo?.(String(r.filter ?? "off")).catch(() => undefined);
        if (my !== run) return;
        const cloud = (await d.cloud?.list().catch(orNull)) ?? undefined;
        if (my !== run) return;
        set({
          step: "status",
          prints,
          local: r.ok === true,
          ...(filter ? { filter } : {}),
          ...(cloud ? { cloud } : {}),
        });
      } catch {
        if (my !== run) return;
        // The Mac unreachable: the account copy still shows (and can be deleted).
        const cloud = (await d.cloud?.list().catch(orNull)) ?? undefined;
        if (my === run) set({ step: "status", prints: [], local: false, ...(cloud ? { cloud } : {}) });
      }
    },
    /** "Save to my account" (a tap: the passkey prompt follows). */
    saveToAccount() {
      if ((view.step === "status" && view.local && view.cloud) || (view.step === "saved" && view.cloud))
        void saveToAccount(run);
    },
    /** "Re-compute from my recordings" (a tap: the passkey prompt follows, per device). */
    recompute() {
      if (view.step === "status" && view.local && view.cloud?.recordings)
        void recompute(run, view.cloud.extractor ?? "mac");
    },
    /**
     * After deleting the voiceprint: the separate offer to delete his
     * recordings in My Files too (a tap; never part of the voiceprint delete).
     */
    async deleteRecordings() {
      if (view.step !== "deleted" || view.recordings?.state !== "offer" || !d.cloud) return;
      const my = run;
      const base = view;
      set({ ...base, recordings: { ...base.recordings!, state: "busy" } });
      try {
        const files = await d.cloud.recordings.list();
        for (const f of files) await d.cloud.recordings.delete(f.id);
        d.log?.({ ev: "voiceprint-recordings-deleted", n: files.length });
        if (my === run) set({ ...base, recordings: { n: files.length, state: "done" } });
      } catch (e) {
        if (my === run)
          set({ ...base, recordings: { ...base.recordings!, state: "failed", error: errText(e) } });
      }
    },
    /** "Restore from my account" (a tap: the passkey prompt follows). */
    restoreFromAccount() {
      if (view.step === "status" && view.local && view.cloud?.prints.length)
        void restoreFromAccount(run);
    },
    /** The panel's switch: pause the filter on this device. Counts from the next utterance. */
    pauseFilter(on: boolean) {
      setFilterPaused(on);
      if (view.step === "status" && view.filter) set({ ...view, filter: { ...view.filter, paused: on } });
    },
    /** "Enrol this device": the consent card, nothing recorded yet. */
    enrol() {
      if (view.step !== "status" || !view.local) return;
      set({ step: "consent", keepAudio: false });
    },
    /** The consent card's switch: also keep the sentences' audio on the Mac (off by default). */
    keepAudio(on: boolean) {
      if (view.step === "consent") set({ step: "consent", keepAudio: on });
    },
    /**
     * The tap on "I agree, start": the only way into recording. It asks for
     * the owner's passkey (Face ID / Touch ID) first; lianki.com turns that
     * into a one-time ticket for enrolling this device, and only then does
     * the Mac open an enrolment.
     */
    async consent() {
      if (view.step !== "consent") return;
      const keepAudio = view.keepAudio;
      const my = ++run;
      try {
        // keepAudio is part of the approval: the Mac refuses a start that differs.
        const ticket = await d.ticket("enrol", d.device, { keepAudio });
        if (my !== run) return;
        const r = ok(
          await d.request({ t: "enrol", op: "start", device: d.device, consent: true, keepAudio, ticket }),
        );
        if (typeof r.enrolment !== "string") throw new Error("no enrolment");
        eid = r.enrolment;
        if (my !== run) return cancelOnMac();
        d.log?.({ ev: "voiceprint-enrol", device: d.device, keepAudio });
        set({ step: "recording", index: 0, kept: 0 });
        await d.capture(true, onFinal(my), eid);
      } catch (e) {
        if (my === run) {
          stopCapture();
          // The Mac may have opened it already: drop it there, unsaved.
          cancelOnMac();
          fail(e);
        }
      }
    },
    /** Skip the sentence shown (hard to read, a word he does not know). */
    skip() {
      if (view.step !== "recording") return;
      const next = view.index + 1;
      if (next >= ENROL_SENTENCES.length && view.kept >= ENROL_MIN) return void save(run, view.kept);
      // Short of ENROL_MIN after the last sentence: round again from the first.
      set({ step: "recording", index: next, kept: view.kept });
    },
    /** "Save voiceprint" (enabled from ENROL_MIN on). */
    save() {
      if (view.step === "recording" && view.kept >= ENROL_MIN) void save(run, view.kept);
    },
    /**
     * "Test my voiceprint" (a tap: the mic's gesture): each line he (or
     * someone else) says is scored by the Mac against this device's print and
     * shown here at once: the score, the decision and the thresholds behind it,
     * the speech seconds and SNR, a running tally. Only the verdict is kept,
     * in this panel's memory; the text and the audio go nowhere.
     */
    async test() {
      if (view.step !== "status" || !view.local || !d.testCapture) return;
      const filter = view.filter;
      const my = ++run;
      const tally: TestTally = { me: 0, other: 0, unknown: 0 };
      set({ step: "test", listening: false, results: [], tally, bands, ...(filter ? { filter } : {}) });
      const onFinal = async (p: Promise<LocalFinal> | null) => {
        if (my !== run || view.step !== "test") return;
        let f: LocalFinal | null = null;
        try {
          f = p ? await p : null;
        } catch {
          f = null;
        }
        if (my !== run || view.step !== "test") return;
        const r = testResult(f);
        const cur = view;
        const t = { ...cur.tally };
        if (r.decision !== "unreachable") t[r.decision]++;
        d.log?.({ ev: "voiceprint-test", decision: r.decision, score: r.score, reason: r.reason });
        set({ ...cur, results: [r, ...cur.results].slice(0, TEST_SHOWN), tally: t });
      };
      try {
        testing = true;
        await d.testCapture(true, onFinal);
        const v = api.view(); // the view since (TS keeps the narrowing from above)
        if (my === run && v.step === "test") set({ ...v, listening: true });
      } catch (e) {
        testing = false;
        const v = api.view();
        if (my === run && v.step === "test") set({ ...v, error: errText(e) });
      }
    },
    /** "Done" in the test: the mic back to the chat, the status again. */
    endTest() {
      if (view.step !== "test") return;
      stopTest();
      void api.open();
    },
    /** "Delete my voiceprint": asks once more. */
    askDelete() {
      if (view.step === "status")
        set({ step: "confirm-delete", local: view.local, ...(view.cloud ? { cloud: view.cloud } : {}) });
    },
    /**
     * The confirming tap: every device's print on the Mac and the copy in his
     * account; never the voice clips, and never the recordings: those kept on
     * the Mac and those in My Files are each asked about separately afterwards
     * (owner, 2026-11-11). One passkey approval covers both halves (the Mac and
     * lianki.com each spend the ticket once).
     */
    async confirmDelete() {
      if (view.step !== "confirm-delete") return;
      const { local, cloud } = view;
      const my = ++run;
      try {
        // The owner's passkey again: deleting needs its own one-time ticket.
        const ticket = await d.ticket("delete", "*");
        if (my !== run) return;
        let files = 0;
        let macKept = 0;
        let macError: unknown = null;
        if (local !== false) {
          try {
            const r = ok(await d.request({ t: "voiceprint", op: "delete", device: "*", ticket }));
            files = typeof r.deleted === "number" ? r.deleted : 0;
            // The recordings kept on the Mac stay; how many, for the separate question.
            macKept = typeof r.recordings === "number" ? r.recordings : 0;
          } catch (e) {
            macError = e;
          }
        }
        let cloudError: string | undefined;
        if (cloud && d.cloud) {
          try {
            await d.cloud.delete(ticket, "*");
          } catch (e) {
            cloudError = errText(e);
          }
        }
        if (my !== run) return;
        if (macError) throw macError;
        d.log?.({ ev: "voiceprint-deleted", files, ...(cloud ? { cloud: !cloudError } : {}) });
        // His recordings in My Files stay unless he says so: offered, never deleted here.
        const recs = d.cloud ? await d.cloud.recordings.list().catch(orNone) : [];
        if (my !== run) return;
        set({
          step: "deleted",
          files,
          ...(cloudError ? { cloudError } : {}),
          ...(recs.length ? { recordings: { n: recs.length, state: "offer" as const } } : {}),
          ...(macKept > 0 ? { mac: { n: macKept, state: "offer" as const } } : {}),
        });
      } catch (e) {
        if (my === run) fail(e);
      }
    },
    /**
     * After the print is deleted: the separate question about the recordings
     * kept on the Mac. Only this tap deletes them (its own delete-audio
     * ticket: the passkey, or the window); the default is to keep them.
     */
    async deleteMacRecordings() {
      if (view.step !== "deleted" || view.mac?.state !== "offer") return;
      const my = run;
      const base = view;
      set({ ...base, mac: { ...base.mac!, state: "busy" } });
      try {
        const ticket = await d.ticket("delete-audio", "*");
        const r = ok(await d.request({ t: "voiceprint", op: "delete-audio", device: "*", ticket }));
        const n = typeof r.deleted === "number" ? r.deleted : 0;
        d.log?.({ ev: "voiceprint-mac-recordings-deleted", n });
        if (my === run && view.step === "deleted") set({ ...view, mac: { n, state: "done" } });
      } catch (e) {
        if (my === run && view.step === "deleted")
          set({ ...view, mac: { ...base.mac!, state: "offer", error: errText(e) } });
      }
    },
    /** "Keep them": the recordings stay on the Mac (the default); the question goes away. */
    keepMacRecordings() {
      if (view.step === "deleted" && view.mac?.state === "offer")
        set({ ...view, mac: { n: view.mac.n, state: "kept" } });
    },
    /** Cancel, ✕, or a panel closing: an enrolment under way is dropped on the Mac, unsaved. */
    close() {
      const was = view.step;
      run++;
      if (was === "recording" || was === "saving") stopCapture();
      stopTest();
      cancelOnMac();
      set({ step: "closed" });
    },
  };
  return api;
}
export type Enrolment = ReturnType<typeof createEnrolment>;
