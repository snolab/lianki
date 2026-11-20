/** Account-scoped inputs only; no shared vocabulary state and no new context collection. */
import {
  rankGlossary,
  type GlossaryOptions,
  type Correction,
} from "../vendor/otoji/packages/transcript-glossary/src/index";
import { sttHotwordsSchema, sttCorrectionsSchema } from "./stt-glossary";
import type { ConfigValues } from "./config";

type PrefDb = {
  prepare(sql: string): { bind(...values: unknown[]): { all<T>(): Promise<{ results: T[] }> } };
};
export function glossaryOptions(c: ConfigValues): GlossaryOptions {
  return {
    topK: Math.min(c["stt.glossaryTopK"], c["stt.glossaryCapacity"]),
    capacity: c["stt.glossaryCapacity"],
    maxTermChars: c["stt.glossaryTermChars"],
    maxOutputChars: c["stt.glossaryOutputChars"],
    maxContextChars: c["stt.glossaryContextChars"],
    halfLifeMs: c["stt.glossaryHalfLifeMs"],
    fixedWeight: c["stt.glossaryFixedWeight"],
    correctionWeight: c["stt.glossaryCorrectionWeight"],
  };
}
export async function accountGlossary(
  db: PrefDb | undefined | null,
  userId: string,
  context: readonly { text: string; at: number }[],
  config: ConfigValues,
  now = Date.now(),
) {
  let hotwords: string[] = [];
  let corrections: Correction[] = [];
  if (db && userId) {
    try {
      const { results } = await db
        .prepare(
          "SELECT key, value FROM user_prefs WHERE user_id = ? AND key IN ('stt.hotwords', 'stt.corrections')",
        )
        .bind(userId)
        .all<{ key: string; value: string }>();
      for (const row of results) {
        try {
          const value: unknown = JSON.parse(row.value);
          if (row.key === "stt.hotwords") hotwords = sttHotwordsSchema.safeParse(value).data ?? [];
          if (row.key === "stt.corrections")
            corrections = sttCorrectionsSchema.safeParse(value).data ?? [];
        } catch {}
      }
    } catch {}
  }
  return rankGlossary({ hotwords, corrections, context }, glossaryOptions(config), now);
}
