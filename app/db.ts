import { MongoClient } from "mongodb";
import DIE from "phpdie";

const g = global as typeof global & { mongodbClient: MongoClient };
const uri = process.env.MONGODB_URI ?? DIE("missing MONGODB_URI");
if (!g.mongodbClient) {
  g.mongodbClient = new MongoClient(uri);
}
export const mongoClient = g.mongodbClient;
export const db = mongoClient.db();
