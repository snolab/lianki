import { MongoClient } from "mongodb";
import DIE from "phpdie";

const g = global as typeof global & { mongodbClient: MongoClient };
// Allow missing MONGODB_URI in local development (build time)
// In production (Vercel), still require it
const uri = process.env.MONGODB_URI ??
  (process.env.VERCEL ? DIE("missing MONGODB_URI") : "mongodb://localhost:27017/lianki");
export const mongoClient = (g.mongodbClient ??= new MongoClient(uri));
export const db = mongoClient.db();
