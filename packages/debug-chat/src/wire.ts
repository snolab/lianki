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
 * Who wrote a line, as far as the hub knows, for the chat's avatars. Never
 * the email: `id` is a short hash of the user id (or of the email when there
 * is no id), so the fallback avatar keeps one colour without exposing it.
 */
export type Sender = {
  /** hashId(user id), the fallback avatar's colour seed. */
  id?: string;
  /** Display name, for the avatar's alt text and initial. */
  name?: string;
  /**
   * Picture URLs in fallback order: the app's own avatar, then the sign-in
   * provider's image. Each that fails to load falls through to the next, and
   * after the last to the initial in a coloured circle.
   */
  avatars?: string[];
};

/**
 * One line of a chat thread, as the hub stores and sends it. `thread` is
 * "owner" or a friend's user id; `email` is the friend's, on their thread.
 * `label` is the page's path and user agent (or the agent's name). `sender`
 * (optional; absent on older lines and on the agent's) draws the avatar.
 */
export type ChatMessage = {
  id: string;
  from: "owner" | "friend" | "agent";
  label: string;
  text: string;
  at: number;
  thread?: string;
  email?: string;
  sender?: Sender;
};

/**
 * Longest avatar URL the hub keeps; longer ones are dropped. Google's and
 * GitHub's are about 100. Bounded because a page's socket attachment (which
 * holds its Sender) must stay under 2 KB.
 */
export const MAX_AVATAR_URL = 300;
/** Longest display name the hub keeps. */
export const MAX_SENDER_NAME = 80;

/** A short, stable, non-reversible-enough hash (FNV-1a, 32 bits, base 36). */
export function hashId(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** An avatar URL worth keeping: https only, bounded. */
export function avatarUrl(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !raw || raw.length > MAX_AVATAR_URL) return undefined;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" ? u.href : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The Sender for a signed-in user: the id seed hashed from the user id (or
 * the email, lower-cased, when there is no id), never the raw email; the
 * name cleaned; the pictures that are https URLs, in the order given.
 */
export function senderOf(who: {
  userId?: string;
  email?: string;
  name?: string | null;
  avatars?: readonly (string | null | undefined)[];
}): Sender {
  const key = who.userId || who.email?.trim().toLowerCase() || "";
  const name = (who.name ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim()
    .slice(0, MAX_SENDER_NAME);
  const avatars = (who.avatars ?? []).map(avatarUrl).filter((u): u is string => !!u);
  return {
    ...(key ? { id: hashId(key) } : {}),
    ...(name ? { name } : {}),
    ...(avatars.length ? { avatars: [...new Set(avatars)].slice(0, 2) } : {}),
  };
}

/** The fallback avatar's letter: the name's first character (a whole grapheme), upper-cased. */
export function initialOf(name: string | undefined): string {
  const s = (name ?? "").trim();
  if (!s) return "?";
  const Seg = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
  const first = Seg
    ? (new Seg(undefined, { granularity: "grapheme" }).segment(s)[Symbol.iterator]().next().value
        ?.segment ?? s[0])
    : Array.from(s)[0];
  return first.toLocaleUpperCase();
}

/** Relative luminance (WCAG) of an oklch colour, clamped into sRGB. */
export function oklchLuminance(l: number, c: number, hDeg: number): number {
  const h = (hDeg * Math.PI) / 180;
  const a = c * Math.cos(h);
  const b = c * Math.sin(h);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  const r = clamp(4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_);
  const g = clamp(-1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_);
  const bl = clamp(-0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_);
  return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
}

/** WCAG contrast ratio of two relative luminances. */
export const contrastRatio = (y1: number, y2: number) =>
  (Math.max(y1, y2) + 0.05) / (Math.min(y1, y2) + 0.05);

/** The fallback avatar's lightness and chroma: oklch(0.7 0.12 <hue>). */
const AVATAR_L = 0.7;
const AVATAR_C = 0.12;
/** The two letter colours tried on it: near-black and white. */
const INK = [
  { css: "oklch(0.2 0 0)", y: oklchLuminance(0.2, 0, 0) },
  { css: "oklch(1 0 0)", y: 1 },
];

/**
 * The fallback avatar's colours for a seed (a Sender id, or any stable
 * string): the hue from a hash, so a person keeps one colour; the letter in
 * whichever ink contrasts more (at least 4.5:1 for every hue).
 */
export function avatarColors(seed: string): { bg: string; fg: string; hue: number } {
  const hue = parseInt(hashId(`avatar:${seed}`), 36) % 360;
  const y = oklchLuminance(AVATAR_L, AVATAR_C, hue);
  const ink = INK.reduce((best, i) =>
    contrastRatio(i.y, y) > contrastRatio(best.y, y) ? i : best,
  );
  return { bg: `oklch(${AVATAR_L} ${AVATAR_C} ${hue})`, fg: ink.css, hue };
}

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
export function pickVoice<V extends { lang: string; default?: boolean }>(
  voices: readonly V[],
  lang: string,
): V | undefined {
  const norm = (l: string) => l.replace(/_/g, "-").toLowerCase();
  const want = norm(lang);
  const base = want.split("-")[0];
  const exact = voices.filter((v) => norm(v.lang) === want);
  const same = voices.filter((v) => norm(v.lang).split("-")[0] === base);
  const pool = exact.length ? exact : same;
  return pool.find((v) => v.default) ?? pool[0];
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
