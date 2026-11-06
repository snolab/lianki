// The Preferences switch for translator's notes in the reader's translations
// (owner, 2026-11-06: "use (...) to explain the cultural difference"; the rule
// is lib/read/translate.ts). On until he says otherwise; docs/prefs-sync.md.
import { notePrefWrite } from "@lianki/ui-state/account";

/** On the account (lib/prefs/bindings.ts): "0" turns the notes off everywhere. */
export const NOTES_KEY = "lk:read-translator-notes";

export function readNotesOn(): boolean {
  try {
    return localStorage.getItem(NOTES_KEY) !== "0";
  } catch {
    return true;
  }
}

export function writeNotesOn(on: boolean) {
  try {
    localStorage.setItem(NOTES_KEY, on ? "1" : "0");
    notePrefWrite();
  } catch {}
}
