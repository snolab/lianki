#!/usr/bin/env node
/**
 * Local development MongoDB — a single-node **replica set** on a fixed port.
 *
 *   bun run dev:db        # foreground; Ctrl-C to stop
 *
 * A replica set (not a standalone) is required because better-auth's MongoDB
 * adapter uses multi-document transactions. This uses `mongodb-memory-server`
 * (already a dev dependency), so no system `mongod` install is needed; it
 * downloads a mongod binary on first run and caches it.
 *
 * Pair it with `.env.local` (see `.env.local.example`):
 *   MONGODB_URI=mongodb://127.0.0.1:27018/lianki-dev?replicaSet=rs0
 *
 * Override the port with DEV_MONGO_PORT.
 */
import { MongoMemoryReplSet } from "mongodb-memory-server";

const port = Number(process.env.DEV_MONGO_PORT || 27018);

const rs = await MongoMemoryReplSet.create({
  replSet: { count: 1, name: "rs0" },
  instanceOpts: [{ port }],
});

const uri = `mongodb://127.0.0.1:${port}/lianki-dev?replicaSet=rs0`;
console.log(`▶ local MongoDB replica set ready`);
console.log(`  MONGODB_URI=${uri}`);
console.log(`  (Ctrl-C to stop)`);

const stop = async () => {
  try {
    await rs.stop();
  } catch {}
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
// Keep the process alive.
setInterval(() => {}, 1 << 30);
