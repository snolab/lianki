import { notePrefWrite, SYNC_KEY } from "@lianki/ui-state/account";
import { startPrefSync } from "./prefs/client";
import { checkPref } from "./prefs/schema";
import { STT_HOTWORDS_KEY, STT_CORRECTIONS_KEY } from "./stt-glossary";
import type { Correction } from "../vendor/otoji/packages/transcript-glossary/src/index";
import { readGlossaryPref, writeGlossaryPref } from "./stt-glossary-storage";

function owns(userId: string): boolean {
  try {
    return JSON.parse(localStorage.getItem(SYNC_KEY) ?? "null")?.userId === userId;
  } catch {
    return false;
  }
}
export function readSttGlossary(
  userId: string,
): { hotwords: string[]; corrections: Correction[] } | null {
  if (!userId || !owns(userId)) return null;
  try {
    return {
      hotwords:
        (checkPref("stt.hotwords", readGlossaryPref(STT_HOTWORDS_KEY, userId) ?? []) as string[]) ??
        [],
      corrections:
        (checkPref(
          "stt.corrections",
          readGlossaryPref(STT_CORRECTIONS_KEY, userId) ?? [],
        ) as Correction[]) ?? [],
    };
  } catch {
    return { hotwords: [], corrections: [] };
  }
}
/** Explicit preference edit only. No transcript/model output is learned automatically. */
export async function writeSttGlossary(
  userId: string,
  hotwords: unknown,
  corrections: unknown,
): Promise<boolean> {
  const words = checkPref("stt.hotwords", hotwords);
  const pairs = checkPref("stt.corrections", corrections);
  if (!userId || !owns(userId) || words === undefined || pairs === undefined) return false;
  const sync = startPrefSync();
  if (!sync) return false;
  // Establish scan baselines before changing either preference.
  sync.scan();
  try {
    if (!owns(userId)) return false;
    writeGlossaryPref(STT_HOTWORDS_KEY, words, userId);
    writeGlossaryPref(STT_CORRECTIONS_KEY, pairs, userId);
    notePrefWrite();
    await sync.flush();
    if (!owns(userId)) return false;
    const record = JSON.parse(localStorage.getItem(SYNC_KEY) ?? "null");
    if (record?.outbox?.["stt.hotwords"] || record?.outbox?.["stt.corrections"]) return false;
    // The sync engine also removes rejected ops. Confirm actual authenticated rows before success.
    const response = await fetch("/api/prefs", { credentials: "same-origin", cache: "no-store" });
    if (!response.ok || !owns(userId)) return false;
    const saved = await response.json();
    return (
      owns(userId) &&
      saved?.user === userId &&
      JSON.stringify(saved?.prefs?.["stt.hotwords"]?.value) === JSON.stringify(words) &&
      JSON.stringify(saved?.prefs?.["stt.corrections"]?.value) === JSON.stringify(pairs)
    );
  } catch {
    return false;
  }
}
