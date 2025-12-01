import { MongoClient } from "mongodb";
import DIE from "phpdie";

const g = global as typeof global & { mongodbClient: MongoClient };
const uri = process.env.MONGODB_URI ?? DIE("missing MONGODB_URI");
export const mongoClient = (g.mongodbClient ??= new MongoClient(uri));
export const db = mongoClient.db();
