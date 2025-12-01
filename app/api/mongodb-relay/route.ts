import makeRelay from "mongodb-rest-relay/lib/server/nextServerlessApp";
import { db } from "@/app/db";
export const POST = makeRelay(db);
