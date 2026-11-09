/**
 * The text avatar's content (app/components/UserAvatar.tsx): the first
 * letter of the name, and a hue that is the same for the same name.
 */

/** The name's first grapheme, upper-cased; "?" for an empty name. */
export function avatarInitial(name: string | null | undefined): string {
  const s = (name ?? "").trim();
  if (!s) return "?";
  const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const first = seg.segment(s)[Symbol.iterator]().next().value?.segment ?? s[0];
  return first.toLocaleUpperCase();
}

/** A stable hue (0–359) from the name, for the background in oklch(). */
export function avatarHue(name: string | null | undefined): number {
  let h = 0;
  for (const ch of name ?? "") h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return h % 360;
}
