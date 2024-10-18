import { db } from "./db";
import { FSRSNote } from "./fsrs";

export function getFSRSNotesCollection(email: string | undefined) {
  return db.collection<FSRSNote>(
    "FSRSNotes" + (email?.replace(/^/, "@") ?? "")
  );
}
