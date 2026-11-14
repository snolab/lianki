/**
 * A mini app's manifest and file (docs/mini-apps.md, "What a mini app is"):
 * slug rules, manifest parsing and the HTML checks the publish route runs.
 * Pure and client-safe, so the dev publish script checks before it sends.
 */
import { type CapabilityId, isCapability } from "./capabilities";

/** Lowercase ASCII and hyphens, 1–40, no leading/trailing/double hyphen (docs/url-principles.md rule 4). */
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SLUG_MAX = 40;
/** Paths under /m that are not apps. */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  "sdk",
  "sdk-js",
  "presets",
  "new",
  "api",
  "edit",
  "settings",
]);

export const isSlug = (v: unknown): v is string =>
  typeof v === "string" && v.length <= SLUG_MAX && SLUG_RE.test(v) && !RESERVED_SLUGS.has(v);

export const NAME_MAX = 60;
export const ICON_MAX = 8;
export const DEFAULT_ICON = "▦";

export type Manifest = {
  slug: string;
  name: string;
  /** One short glyph (an emoji or a character), shown in the list and the prompt. */
  icon: string;
  /** major.minor.patch, bumped by the publisher; shown, never compared. */
  version: string;
  /** What the app may ask for; anything else is refused without a prompt. */
  permissions: CapabilityId[];
};

/** One line, no control or bidi characters, trimmed. */
function clean(raw: unknown, max: number): string | null {
  if (typeof raw !== "string") return null;
  const s = raw
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return s && [...s].length <= max ? s : null;
}

export function parseManifest(
  raw: unknown,
): { ok: true; manifest: Manifest } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return { ok: false, error: "manifest-required" };
  const m = raw as Record<string, unknown>;
  if (!isSlug(m.slug)) return { ok: false, error: "bad-slug" };
  const name = clean(m.name, NAME_MAX);
  if (!name) return { ok: false, error: "bad-name" };
  const icon = m.icon === undefined ? DEFAULT_ICON : clean(m.icon, ICON_MAX);
  if (!icon) return { ok: false, error: "bad-icon" };
  const version = m.version === undefined ? "0.1.0" : m.version;
  if (typeof version !== "string" || !/^\d{1,4}\.\d{1,4}\.\d{1,6}$/.test(version))
    return { ok: false, error: "bad-version" };
  const perms = m.permissions === undefined ? [] : m.permissions;
  if (!Array.isArray(perms) || perms.length > 16) return { ok: false, error: "bad-permissions" };
  const permissions: CapabilityId[] = [];
  for (const p of perms) {
    if (!isCapability(p)) return { ok: false, error: "unknown-permission" };
    if (!permissions.includes(p)) permissions.push(p);
  }
  return { ok: true, manifest: { slug: m.slug, name, icon, version, permissions } };
}

/** The app's one file: text, within the byte cap, and an HTML document. */
export function checkHtml(
  html: unknown,
  maxBytes: number,
): { ok: true; bytes: number } | { ok: false; error: string; max?: number } {
  if (typeof html !== "string" || !html.trim()) return { ok: false, error: "html-required" };
  const bytes = new TextEncoder().encode(html).length;
  if (bytes > maxBytes) return { ok: false, error: "too-big", max: maxBytes };
  if (html.includes("\u0000")) return { ok: false, error: "not-html" };
  if (!/<(?:!doctype\s+html|html|head|body|script|div|main|canvas)\b/i.test(html))
    return { ok: false, error: "not-html" };
  return { ok: true, bytes };
}
