import type { Db } from "mongodb";
import type { FSRSNote } from "./fsrs";

let _db: Db | null = null;
const getDb = async () => {
  if (!_db) {
    const { db } = await import("./db");
    _db = db;
  }
  return _db;
};

export async function getFSRSNotesCollection(email: string | undefined) {
  const db = await getDb();
  return db.collection<FSRSNote>(`FSRSNotes${email?.replace(/^/, "@") ?? ""}`);
}
