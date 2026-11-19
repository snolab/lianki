/** Lianki account preference shape. Ranking and prompt policy belong to Otoji. */
import { z } from "zod";
export const STT_HOTWORDS_KEY = "lk:stt-hotwords";
export const STT_CORRECTIONS_KEY = "lk:stt-corrections";
// Persistence/wire ceilings fit prefs-sync's existing 2 KiB per-value limit.
export const sttTermSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[\p{L}\p{M}\p{N} _'’.-]+$/u)
  .refine((s) => !/\.\p{L}{2,}$|localhost|^(?:\d{1,3}\.){3}\d{1,3}$/iu.test(s));
export const sttHotwordsSchema = z.array(sttTermSchema).max(24);
export const sttCorrectionsSchema = z
  .array(
    z
      .object({
        heard: sttTermSchema,
        corrected: sttTermSchema,
        at: z.number().int().nonnegative().safe(),
      })
      .strict(),
  )
  .max(12);
