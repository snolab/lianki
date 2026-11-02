/**
 * The preferences that follow the account (docs/prefs-sync.md): every server
 * key, with the zod schema that both the route and the client check a value
 * against. A key that is not here is refused by the server and never sent.
 *
 * Values are booleans, enums, numbers in range, app paths and catalog URLs.
 * Nothing free-form: no device URL, tailnet host, file path or typed text can
 * pass any schema here (unit/prefs-schema.test.ts probes every key).
 *
 * A field whose shape changes gets a new key (`swipe-feel.tweaks2`); the old
 * row is then simply no longer read.
 */
import { z } from "zod";
import { allImmersionSites, IMMERSION_LANGUAGES } from "@/lib/immersion-sites";
import { FEEL_RANGES } from "@/lib/words/swipe-feel";
import { BLOG_LOCALES } from "@/lib/constants";

// ── Limits ────────────────────────────────────────────────────────────────

/** JSON of one value. */
export const MAX_VALUE_BYTES = 2048;
/** Ops in one PATCH. */
export const MAX_OPS = 50;
/** One PATCH body. */
export const MAX_BODY_BYTES = 16 * 1024;
/** Rows one account may hold. */
export const MAX_ROWS = 100;
/** A client clock this far ahead of the server's is clamped to the server's now. */
export const MAX_CLOCK_AHEAD_MS = 60_000;

// ── Value schemas ─────────────────────────────────────────────────────────

/** An app path: one slash, no host, nothing that looks like one. */
export const appPath = z
  .string()
  .max(300)
  .regex(/^\/(?!\/)[A-Za-z0-9/_\-?=&%~+,]*$/)
  .refine((p) => !p.includes("://") && !/\.ts\.net|localhost|127\.0\.0\.1/i.test(p));

const IMMERSION_CODES = IMMERSION_LANGUAGES.map((l) => l.code) as [string, ...string[]];
/** The public sites of the immersion matrix (lib/immersion-sites.ts): the only URLs a pref may hold. */
export const CATALOG_URLS: ReadonlySet<string> = new Set(allImmersionSites().map((s) => s.url));
const catalogUrl = z.string().refine((u) => CATALOG_URLS.has(u));

const tweakShape: Record<string, z.ZodType> = {};
for (const [k, r] of Object.entries(FEEL_RANGES)) {
  tweakShape[k] = (r === null ? z.boolean() : z.number().min(r[0]).max(r[1])).optional();
}
const feelTweaks = z.object(tweakShape).strict();

export const PREF_SCHEMAS = {
  // /words study settings
  "words.showAll": z.boolean(),
  "words.readAloud": z.boolean(),
  "words.serverVoice": z.boolean(),
  "words.speakOnSwipe": z.boolean(),
  "words.gradeTones": z.boolean(),
  "words.paperScrolls": z.boolean(),
  // the swipe (Experimental)
  "swipe.variant": z.enum(["js", "native"]),
  "swipe-feel.preset": z.enum(["light", "heavy"]),
  "swipe-feel.tweaks": feelTweaks,
  // appearance, language, navigation
  "motion.animations": z.enum(["off", "on"]),
  "ui.paper": z.enum(["a", "b", "c", "e"]),
  "ui.locale": z.enum(BLOG_LOCALES as unknown as [string, ...string[]]),
  "nav-pins.pinned": z.array(appPath).max(12),
  "home.lang": z.enum(IMMERSION_CODES),
  "home.pins": z.array(catalogUrl).max(100),
  "lab.immersionLangs": z.array(z.enum(IMMERSION_CODES)).max(IMMERSION_CODES.length),
  "lab.immersionTranspose": z.boolean(),
  // the chat's voice (packages/debug-chat); echo cancel stays on the device
  "chat-voice.rate": z.union([z.literal(1), z.literal(1.25), z.literal(1.5), z.literal(2)]),
  "chat-voice.out": z.enum(["speech", "cloud"]),
  "chat-voice.speak": z.boolean(),
} as const satisfies Record<string, z.ZodType>;

export type PrefKey = keyof typeof PREF_SCHEMAS;

export const PREF_KEYS = Object.keys(PREF_SCHEMAS) as PrefKey[];

export const isPrefKey = (k: unknown): k is PrefKey =>
  typeof k === "string" && Object.prototype.hasOwnProperty.call(PREF_SCHEMAS, k);

/** A value for `key` that passes its schema and the size cap, or undefined. */
export function checkPref(key: string, value: unknown): unknown {
  if (!isPrefKey(key)) return undefined;
  const r = PREF_SCHEMAS[key].safeParse(value);
  if (!r.success) return undefined;
  const json = JSON.stringify(r.data);
  if (json === undefined || json.length > MAX_VALUE_BYTES) return undefined;
  return r.data;
}

// ── Clocks ────────────────────────────────────────────────────────────────

/**
 * A preference's HLC: as sync-merge-rules.md's, with the device id limited to
 * lowercase letters and digits, so JS and SQLite order ties the same way
 * (byte order; compareHLC's localeCompare could disagree with SQL on `-`).
 */
export type PrefHlc = { timestamp: number; counter: number; deviceId: string };

export const prefHlc = z.object({
  timestamp: z.number().int().nonnegative(),
  counter: z.number().int().nonnegative().max(1e6),
  deviceId: z.string().regex(/^[a-z0-9]{8,40}$/),
});

export function comparePrefHlc(a: PrefHlc | undefined, b: PrefHlc | undefined): number {
  if (!a) return b ? -1 : 0;
  if (!b) return 1;
  if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
  if (a.counter !== b.counter) return a.counter - b.counter;
  return a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : 0;
}

/** One write: a key, its value and its clock. */
export const prefOp = z.object({ key: z.string().max(64), value: z.unknown(), hlc: prefHlc });
export type PrefOp = { key: string; value: unknown; hlc: PrefHlc };

export const patchBody = z.object({ ops: z.array(prefOp).max(MAX_OPS) });

/** One stored row, as the route returns it. */
export type PrefRow = { value: unknown; hlc: PrefHlc };
