import { db } from "./db-edge";
import { FSRSNote } from "./fsrs";

export function getFSRSNotesCollection(email: string | undefined) {
  return db.collection<FSRSNote>(
    "FSRSNotes" + (email?.replace(/^/, "@") ?? "")
  );
}
