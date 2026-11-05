import { PROFILE } from "./config";

export type NameResult = { ok: true; name: string } | { ok: false; error: "empty" | "too-long" };

/**
 * A display name as stored: NFC, line breaks and tabs become spaces, control
 * and bidi-override characters go (they can make a name read backwards in
 * someone else's view), runs of spaces collapse, the ends are trimmed.
 * Joiners stay: emoji and several scripts need them.
 */
export function cleanName(raw: unknown): NameResult {
  if (typeof raw !== "string") return { ok: false, error: "empty" };
  const name = raw
    .normalize("NFC")
    .replace(/[\t\n\v\f\r\u0085\u2028\u2029]/g, " ")
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!name) return { ok: false, error: "empty" };
  if ([...name].length > PROFILE.nameMaxChars) return { ok: false, error: "too-long" };
  return { ok: true, name };
}
