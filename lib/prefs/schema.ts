/**
 * The preferences that follow the account (docs/prefs-sync.md): every server
 * key, with the zod schema that both the route and the client check a value
 * against. A key that is not here is refused by the server and never sent.
 *
 * Values are booleans, enums, numbers in range, app paths and catalog URLs.
 * Nothing free-form: no device URL, tailnet host, file path or typed text can
 * pass any schema here (unit/prefs-schema.test.ts probes every key).
 *
 * One exception, by the owner (2026-11-05 14:25 JST): `byok.backend`, the
 * user's own AI backend (docs/byok.md) — provider, base URL and model, only
 * when they tick 「同步到我的账号」. Only that exact shape passes, its URL
 * under lib/byok/config.ts's rules; the server stores it and never fetches
 * it. The API key has no key here: it never leaves the device.
 *
 * A second, by the owner (2026-11-06): `titles.rules`, the patterns that clean
 * notification prefixes out of page titles (docs/title-clean.md). A pattern is
 * short text in a restricted syntax and a host names a public site, because
 * per-site patterns are the point; device and tailnet hosts do not pass.
 *
 * A field whose shape changes gets a new key (`swipe-feel.tweaks2`); the old
 * row is then simply no longer read.
 */
import { z } from "zod";
import { allImmersionSites, IMMERSION_LANGUAGES } from "@/lib/immersion-sites";
import { FEEL_RANGES } from "@/lib/words/swipe-feel";
import { BLOG_LOCALES } from "@/lib/constants";
import { TEXT_MAX, TEXT_MIN } from "@/lib/text-size-boot";
import { cleanBackend } from "@/lib/byok/config";
import {
  isTitleHost,
  isTitlePattern,
  TITLE_HOST_MAX,
  TITLE_PATTERN_MAX,
  TITLE_RULES_ADD_MAX,
  TITLE_RULES_OFF_MAX,
} from "@lianki/core/titleClean";

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
/** A text size (lib/text-size.ts): a factor in range, in steps of 0.05. */
const textScale = z
  .number()
  .min(TEXT_MIN)
  .max(TEXT_MAX)
  .refine((v) => Math.abs(v * 20 - Math.round(v * 20)) < 1e-6);

/** Nothing that names a place: a scheme, a host, a path. */
const placeLike = (s: string) => /:\/\/|\.ts\.net|localhost|127\.0\.0\.1|\/|\.\w{2,}$/i.test(s);
/**
 * The reader's sense picks (lib/read/sense-pick.ts): "word@sentence-hash" →
 * "lang\tterm", a word and a dictionary term — at most PICKS_MAX of them.
 */
const sensePicks = z
  .record(
    z
      .string()
      .max(80)
      .regex(/^[^\t\n]+@[0-9a-f]{8}$/),
    z
      .string()
      .max(60)
      .regex(/^[a-z]{2,3}\t[^\t\n]+$/),
  )
  .refine((m) => Object.keys(m).length <= 24)
  .refine((m) => !Object.entries(m).some(([k, v]) => placeLike(k) || placeLike(v)));
/** Materials he said no to tidying (lib/read/polish-offer.ts): ids, under the 2 KB cap. */
const polishSkips = z.array(z.string().regex(/^[A-Za-z0-9_-]{1,40}$/)).max(40);
/** A BYOK backend exactly as lib/byok/config.ts cleans it (no key field can pass). */
const byokBackend = z
  .object({
    provider: z.string().max(40),
    baseUrl: z.string().max(300),
    model: z.string().max(120),
  })
  .strict()
  .refine((b) => {
    const c = cleanBackend(b);
    return !!c && c.baseUrl === b.baseUrl && c.provider === b.provider && c.model === b.model;
  });

/** The difference from the default title rules (@lianki/core/titleClean). */
const titleRules = z
  .object({
    off: z.array(z.string().regex(/^[0-9a-f]{8}$/)).max(TITLE_RULES_OFF_MAX),
    add: z
      .array(
        z
          .object({
            host: z.string().max(TITLE_HOST_MAX).refine(isTitleHost),
            pattern: z.string().max(TITLE_PATTERN_MAX).refine(isTitlePattern),
          })
          .strict(),
      )
      .max(TITLE_RULES_ADD_MAX),
  })
  .strict();

export const PREF_SCHEMAS = {
  // /words study settings
  "words.showAll": z.boolean(),
  "words.readAloud": z.boolean(),
  "words.serverVoice": z.boolean(),
  "words.speakOnSwipe": z.boolean(),
  "words.gradeTones": z.boolean(),
  "words.voiceMode": z.boolean(),
  "words.swipeMirror": z.boolean(),
  // the swipe (Experimental)
  "swipe.variant": z.enum(["js", "native"]),
  "swipe-feel.preset": z.enum(["light", "heavy"]),
  "swipe-feel.tweaks": feelTweaks,
  // appearance, language, navigation
  "motion.animations": z.enum(["off", "on"]),
  "ui.paper": z.enum(["a", "b", "c", "e"]),
  "text-size.ui": textScale,
  "text-size.chat": textScale,
  "text-size.cards": textScale,
  "text-size.read": textScale,
  "ui.locale": z.enum(BLOG_LOCALES as unknown as [string, ...string[]]),
  "nav-pins.pinned": z.array(appPath).max(12),
  "home.lang": z.enum(IMMERSION_CODES),
  "home.pins": z.array(catalogUrl).max(100),
  "lab.immersionLangs": z.array(z.enum(IMMERSION_CODES)).max(IMMERSION_CODES.length),
  "lab.immersionTranspose": z.boolean(),
  // /read: which language's entry a word means where it stands
  "read.sensePicks": sensePicks,
  // /read: the offer to tidy a raw transcript, off for good or for some texts
  "read.polishOffer": z.boolean(),
  "read.translatorNotes": z.boolean(),
  "read.polishSkips": polishSkips,
  // /vibe: a language's share of a conversation, in percent, before lines go into it
  "vibe.translateMinPct": z.number().int().min(1).max(99),
  // page titles: cleaning notification prefixes
  "titles.rules": titleRules,
  // the chat's voice (packages/debug-chat); echo cancel stays on the device
  "chat-voice.rate": z.union([z.literal(1), z.literal(1.25), z.literal(1.5), z.literal(2)]),
  "chat-voice.out": z.enum(["speech", "cloud"]),
  "chat-voice.speak": z.boolean(),
  // The voice cues' two switches (packages/debug-chat cues.ts).
  "chat-voice.cueSend": z.boolean(),
  "chat-voice.cueSpeech": z.boolean(),
  // the user's own AI backend (not the key), when they sync it; null: not synced
  "byok.backend": z.union([z.null(), byokBackend]),
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
