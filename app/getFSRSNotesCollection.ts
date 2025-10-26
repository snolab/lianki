import { db } from "./db";
import type { FSRSNote } from "./fsrs";

export function getFSRSNotesCollection(email: string | undefined) {
  return db.collection<FSRSNote>(`FSRSNotes${email?.replace(/^/, "@") ?? ""}`);
}
