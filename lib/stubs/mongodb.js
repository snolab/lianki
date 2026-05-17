// Build-time stub for the `mongodb` driver, used ONLY in the Cloudflare build
// (next.config.mjs aliases `mongodb` here when CF_BUILD=1).
//
// The deployed Worker always runs with DB_BACKEND=d1, so every MongoDB code
// path is dead — the driver is pure bundle weight. This stub satisfies the
// `MongoClient` / `ObjectId` / `GridFSBucket` value imports so modules load;
// any method call (which would only happen on a mis-routed mongo path) throws.

function stubbed() {
  throw new Error("mongodb is stubbed in the Cloudflare build (DB_BACKEND=d1)");
}

const collectionStub = new Proxy({}, { get: () => stubbed });
const dbStub = { collection: () => collectionStub };

export class MongoClient {
  db() {
    return dbStub;
  }
  connect() {
    return stubbed();
  }
  close() {}
}

export class ObjectId {
  static isValid() {
    return false;
  }
  toString() {
    return "";
  }
}

export class GridFSBucket {}

export default { MongoClient, ObjectId, GridFSBucket };
