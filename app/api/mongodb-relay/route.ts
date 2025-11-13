import { db } from "@/app/db";
import makeRelay from "mongodb-rest-relay/lib/server/nextServerlessApp";
export const POST = makeRelay(db);
