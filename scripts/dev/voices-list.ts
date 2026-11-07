/**
 * `eval.ts voices` (and `lianki-dev voices`): the voice ids a chat line may
 * name with `say --voice` (packages/debug-chat/src/voices.ts parseLineVoice).
 * The device voices are read from the owner's open pages over the eval
 * channel (one read, never a loop); the cloud ones are data. Pure apart from
 * the probe's text, so unit/voices-list.test.ts runs it on fakes.
 */
import { type VoiceLike, cloudVoiceIds, deviceVoiceIds } from "@/packages/debug-chat/src/voices";

/**
 * Runs on the page (an eval function body): its speechSynthesis voices,
 * waiting once for `voiceschanged` (iOS and Chrome list none at first).
 * Reads only; changes nothing and plays nothing.
 */
export const VOICES_PROBE = `const s = globalThis.speechSynthesis;
if (!s) return { voices: [], note: "no speechSynthesis on this page" };
let v = s.getVoices();
if (!v.length) {
  await new Promise((r) => { s.addEventListener("voiceschanged", r, { once: true }); setTimeout(r, 1500); });
  v = s.getVoices();
}
return { voices: v.map((x) => ({ name: x.name, lang: x.lang, voiceURI: x.voiceURI, default: x.default })) };`;

/** One page's eval result, as eval-socket.ts run() gives it. */
export type ProbeResult = Record<string, unknown>;

export type VoicesReport = {
  type: "voices";
  pages: {
    label: string;
    ok: boolean;
    error?: string;
    note?: string;
    device?: ReturnType<typeof deviceVoiceIds>;
  }[];
  cloud: ReturnType<typeof cloudVoiceIds>;
  usage: string;
};

export const VOICES_USAGE =
  'say --voice <id> "text": main|calm|bright, device:<name>, melo:<lang>, aura:<speaker>, eleven:<id> (local:<name> reserved)';

/** The report: each page's device voices as ids (zh, ja, en first), and the cloud list. */
export function voicesReport(results: readonly ProbeResult[] | null): VoicesReport {
  const pages = (results ?? []).map((r) => {
    const label = typeof r.label === "string" ? r.label : "";
    if (r.ok !== true) return { label, ok: false, error: String(r.error ?? "no result") };
    const v = (r.value ?? {}) as { voices?: unknown; note?: unknown };
    const list = Array.isArray(v.voices)
      ? (v.voices as unknown[]).filter(
          (x): x is VoiceLike =>
            !!x &&
            typeof (x as VoiceLike).lang === "string" &&
            typeof (x as VoiceLike).name === "string",
        )
      : [];
    return {
      label,
      ok: true,
      ...(typeof v.note === "string" ? { note: v.note } : {}),
      device: deviceVoiceIds(list),
    };
  });
  return { type: "voices", pages, cloud: cloudVoiceIds(), usage: VOICES_USAGE };
}
