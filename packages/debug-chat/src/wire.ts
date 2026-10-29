/**
 * The debug chat's wire types and the pure helpers its UI uses. The hub and
 * the sender use them too, through lib/dev-eval.ts (which re-exports them):
 * no imports, so the push Worker can bundle this file.
 */

/** Largest chat message (owner's or agent's), in characters. */
export const MAX_CHAT = 4000;

/**
 * What an approval lets a controller do: "eval" (Allow for 8 hours) runs code
 * and chats; "chat" (Allow chat for 30 days) only chats — it hears the owner's
 * messages and may `say`, but cannot eval.
 */
export type Scope = "eval" | "chat";

/**
 * One line of a chat thread, as the hub stores and sends it. `thread` is
 * "owner" or a friend's user id; `email` is the friend's, on their thread.
 * `label` is the page's path and user agent (or the agent's name).
 */
export type ChatMessage = {
  id: string;
  from: "owner" | "friend" | "agent";
  label: string;
  text: string;
  at: number;
  thread?: string;
  email?: string;
};

/** What the hub tells pages: the pairing waiting for an answer, and the approved sessions. */
export type PairInfo = {
  pair: string;
  code: string;
  label: string;
  at: number;
  until?: number;
  scope?: Scope;
  /** The page ids an approved pairing reaches; absent = all this audience's pages. */
  pages?: string[];
};

/** An open debug page: its socket's id, current label (path…), and when it connected. */
export type PageInfo = { id: string; label: string; at: number };

/**
 * The language to read a reply in, from its script alone: any kana is
 * Japanese, Hangul Korean, other Han Chinese (zh-CN), and everything else
 * English.
 */
export function pickLang(text: string): "ja-JP" | "ko-KR" | "zh-CN" | "en-US" {
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)) return "ja-JP";
  if (/\p{Script=Hangul}/u.test(text)) return "ko-KR";
  if (/\p{Script=Han}/u.test(text)) return "zh-CN";
  return "en-US";
}

/** An installed voice for `lang`: the exact locale first, then the same language. */
/**
 * How natural a voice sounds, higher is better. iOS lists its Eloquence
 * voices (Eddy, Flo, Grandma, …) and the novelty ones (Bahh, Bubbles,
 * Zarvox, …) first for most languages, and marks every voice `default`, so
 * "the first voice of the language" sounds robotic or silly there. Prefer
 * Premium/Enhanced, then the regular named voice (Samantha, Tingting, Kyoko).
 */
export function voiceQuality(v: { voiceURI?: string; name?: string; localService?: boolean }): number {
  const uri = (v.voiceURI ?? "").toLowerCase();
  if (uri.includes("eloquence") || uri.includes("speech.synthesis.voice.")) return 0;
  if (uri.includes("premium")) return 4;
  if (uri.includes("enhanced")) return 3;
  if (uri.includes("siri")) return 3;
  return 2;
}

export function pickVoice<
  V extends { lang: string; default?: boolean; voiceURI?: string; name?: string },
>(voices: readonly V[], lang: string): V | undefined {
  const norm = (l: string) => l.replace(/_/g, "-").toLowerCase();
  const want = norm(lang);
  const base = want.split("-")[0];
  const exact = voices.filter((v) => norm(v.lang) === want);
  const same = voices.filter((v) => norm(v.lang).split("-")[0] === base);
  const pool = exact.length ? exact : same;
  const best = Math.max(-1, ...pool.map(voiceQuality));
  const top = pool.filter((v) => voiceQuality(v) === best);
  return top.find((v) => v.default) ?? top[0];
}

/**
 * A page label ("<path> [pwa ]<user agent>") split for the chat's page list:
 * the path, and a short device hint like "pwa · Android" or "iPhone".
 */
export function pageParts(label: string): { path: string; device: string } {
  const [path = "", ...rest] = label.split(" ");
  const ua = rest.join(" ");
  const pwa = rest[0] === "pwa";
  const device =
    [
      ["iPhone", /iPhone/],
      ["iPad", /iPad/],
      ["Android", /Android/],
      ["Mac", /Macintosh|Mac OS X/],
      ["Windows", /Windows/],
      ["Linux", /Linux|X11/],
    ].find(([, re]) => (re as RegExp).test(ua))?.[0] ?? "";
  return {
    path: path.startsWith("/") ? path : "/",
    device: [pwa ? "pwa" : "", device as string].filter(Boolean).join(" · "),
  };
}

/** What Allow grants, in one sentence (the requester declared its scope when it knocked). */
export function pairSentence(p: Pick<PairInfo, "label" | "scope">, friend: boolean): string {
  if (friend) return `${p.label} wants to preview a change on this page for 1 hour.`;
  return p.scope === "chat"
    ? `${p.label} wants to chat with you for 30 days.`
    : `${p.label} wants to run code on your debug pages for 8 hours.`;
}

/** The pairing modal's Allow button, for the pages ticked. */
export function allowLabel(ticked: number, total: number, selfTicked: boolean): string {
  if (total > 1 && ticked === total) return "Authorize all pages";
  if (ticked === 1 && selfTicked) return "Authorize this page";
  return ticked === 1 ? "Authorize 1 page" : `Authorize ${ticked} pages`;
}
