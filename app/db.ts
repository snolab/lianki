import { MongoClient } from "mongodb";
import DIE from "phpdie";

const g = global as typeof global & { mongodbClient: MongoClient };
const uri =
  process.env.MONGODB_URI ??
  (process.env.NODE_ENV === "production"
    ? DIE("missing MONGODB_URI")
    : "mongodb://localhost:27017/test");
if (!g.mongodbClient) {
  g.mongodbClient = new MongoClient(uri);
}
export const mongoClient = g.mongodbClient;
export const db = mongoClient.db();
