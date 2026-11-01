/**
 * The owner's voiceprint, the page's side (docs/local-stt.md, "Voiceprint"):
 * enrolment on this device, the "delete my voiceprint" control, and the
 * speaker tags that ride on voice lines. The print itself lives only on his
 * Mac, beside the local STT server (scripts/local-stt/voiceprint.py,
 * ~/.config/lianki-stt/voiceprints); the page only sends the audio of the
 * sentences he reads to that server, over the same socket as speech, and
 * never to lianki.com, the cloud STT or the clip sink.
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

// ---------------------------------------------------------------- the enrolment card
export type PrintInfo = { device: string; model: string; n: number; updated?: string; audio?: boolean };

export type EnrolView =
  | { step: "closed" }
  /** Asking the Mac what is enrolled. */
  | { step: "loading" }
  /** What is enrolled, with Enrol and Delete. `local`: false when the Mac's check is off or unreachable. */
  | { step: "status"; prints: PrintInfo[]; local: boolean }
  /** Before anything is recorded: what is kept, where; a tap to agree. */
  | { step: "consent"; keepAudio: boolean }
  /** Reading: sentence `index`, `kept` so far, and why the last one was not kept. */
  | { step: "recording"; index: number; kept: number; again?: AgainReason; heard?: string }
  | { step: "saving"; kept: number }
  | { step: "saved"; kept: number }
  | { step: "confirm-delete" }
  | { step: "deleted"; files: number }
  | { step: "error"; error: string };

export type AgainReason = "short" | "noise" | "mismatch" | "text" | "unreachable";

/** What the card needs of the page (the local STT socket, the mic session). */
export type EnrolDeps = {
  /** A voiceprint request to the Mac (local-stt.ts request on the panel's own socket). */
  request(msg: Record<string, unknown>): Promise<Record<string, unknown>>;
  /**
   * A voiceprint ticket from lianki.com for this op (app/api/dev/voiceprint-ticket):
   * status with the owner session; enrol and delete only after the owner's
   * passkey with Face ID / Touch ID (webauthn.ts). The Mac takes no op without one.
   */
  ticket(
    op: "status" | "enrol" | "delete",
    device: string,
    o?: { keepAudio?: boolean },
  ): Promise<string>;
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
      set({ step: "saved", kept: typeof r.n === "number" ? r.n : kept });
    } catch (e) {
      if (my === run) fail(e);
    }
  };

  return {
    view: () => view,
    /** The menu's "Voiceprint": what is enrolled. */
    async open() {
      const my = ++run;
      set({ step: "loading" });
      try {
        // A read-only owner ticket: the Mac answers nothing without one.
        const ticket = await d.ticket("status", "*");
        const r = await d.request({ t: "voiceprint", op: "status", ticket });
        if (my !== run) return;
        const prints = Array.isArray(r.prints) ? (r.prints as PrintInfo[]) : [];
        set({ step: "status", prints, local: r.ok === true });
      } catch {
        if (my === run) set({ step: "status", prints: [], local: false });
      }
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
    /** "Delete my voiceprint": asks once more. */
    askDelete() {
      if (view.step === "status") set({ step: "confirm-delete" });
    },
    /** The confirming tap: every device's print and any kept audio; never the voice clips. */
    async confirmDelete() {
      if (view.step !== "confirm-delete") return;
      const my = ++run;
      try {
        // The owner's passkey again: deleting needs its own one-time ticket.
        const ticket = await d.ticket("delete", "*");
        if (my !== run) return;
        const r = ok(await d.request({ t: "voiceprint", op: "delete", device: "*", ticket }));
        if (my !== run) return;
        d.log?.({ ev: "voiceprint-deleted", files: r.deleted });
        set({ step: "deleted", files: typeof r.deleted === "number" ? r.deleted : 0 });
      } catch (e) {
        if (my === run) fail(e);
      }
    },
    /** Cancel, ✕, or a panel closing: an enrolment under way is dropped on the Mac, unsaved. */
    close() {
      const was = view.step;
      run++;
      if (was === "recording" || was === "saving") stopCapture();
      cancelOnMac();
      set({ step: "closed" });
    },
  };
}
export type Enrolment = ReturnType<typeof createEnrolment>;
