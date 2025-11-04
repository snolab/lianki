import type { Db } from "mongodb";
import makeRelay from "mongodb-rest-relay/lib/server/nextServerlessApp";
import type { NextRequest } from "next/server";

// Lazy load db to avoid build-time connection issues
let _db: Db | null = null;
const getDb = async () => {
  if (!_db) {
    const { db } = await import("@/app/db");
    _db = db;
  }
  return _db;
};

export const POST = async (req: NextRequest) => {
  try {
    const db = await getDb();
    return makeRelay(db)(req);
  } catch {
    return new Response("Database connection error", { status: 500 });
  }
};
