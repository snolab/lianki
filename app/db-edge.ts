import type { MongoClient } from "mongodb";
import RelayMongoClient from "mongodb-rest-relay";
import DIE from "phpdie";

const g = global as typeof global & { mongodbClient: MongoClient };
const endpoint = "/api/mongodb-relay";
const uri =
  process.env.VERCEL_URL?.replace(/.*/, (s) => `https://${s}${endpoint}`) ??
  process.env.MONGODB_RELAY_ORIGIN?.replace(/.*/, (s) => s + endpoint) ??
  DIE("Missing MONGODB_RELAY_URI");

if (!g.mongodbClient) {
  g.mongodbClient = new RelayMongoClient(uri) as unknown as MongoClient;
}
export const mongoClient = g.mongodbClient;
export const db = mongoClient.db("brainstorm");

// export const db = MongoDB.connect({
//   //   baseUrl: process.env.MONGODB_API_Url,
//   //   apiKey: process.env.MONGODB_API_ApiKey,
//   clusterName: "snolab-dev-cluster-ae17e5e",
//   baseUrl: "",
//   apiKey: "",
//   dbName: "brainstorm",
//   schemaBuilder: () => ({}),
// });

// import KeyvMongo from "@keyv/mongo";
// import Keyv from "keyv";
// import { initClient } from "mongo-http";
// import DIE from "phpdie";
// // const g = global as typeof global & { mongodbClient: MongoClient };
// const MONGODB_URI = process.env.MONGODB_RELAY_URI ?? DIE("!");
// export const mongoClient = initClient({apiKey: "asdf",appId: 'asdf'});
// export const db = mongoClient.db();
// const store = new KeyvMongo(MONGODB_URI, { collection: "kv" });
// export const kv = new Keyv({ store });

// // if (import.meta.main) {
// //     db.collections
// // }
