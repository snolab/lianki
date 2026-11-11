import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { compareExports, exportNames } from "@/scripts/ci/worker-exports";

/** The shape of OpenNext's .open-next/worker.js (1.20) and of wrangler's bundle of worker.ts. */
const ARTIFACT = `import { runWithCloudflareRequestContext } from "./cloudflare/init.js";
//@ts-expect-error: Will be resolved by wrangler build
export { DOQueueHandler } from "./.build/durable-objects/queue.js";
//@ts-expect-error: Will be resolved by wrangler build
export { DOShardedTagCache } from "./.build/durable-objects/sharded-tag-cache.js";
//@ts-expect-error: Will be resolved by wrangler build
export { BucketCachePurge } from "./.build/durable-objects/bucket-cache-purge.js";
export default {
    async fetch(request, env, ctx) {},
};`;
const BUNDLE = `var DebugSessions = class extends WorkerEntrypoint {};
export {
  BucketCachePurge,
  DOQueueHandler,
  DOShardedTagCache,
  DebugSessions,
  worker_default2 as default
};
//# sourceMappingURL=worker.js.map`;

describe("check-worker-exports", () => {
  it("reads re-exports, aliases, default and declarations", () => {
    expect([...exportNames(ARTIFACT)].sort()).toEqual([
      "BucketCachePurge",
      "DOQueueHandler",
      "DOShardedTagCache",
      "default",
    ]);
    expect([...exportNames(BUNDLE)].sort()).toEqual([
      "BucketCachePurge",
      "DOQueueHandler",
      "DOShardedTagCache",
      "DebugSessions",
      "default",
    ]);
    expect([
      ...exportNames(
        "export class A {}\nexport async function b() {}\nexport const c = 1; export {};",
      ),
    ]).toEqual(["A", "b", "c"]);
    // A minified bundle: one line, its exports the clause that ends the file.
    const minified =
      "var a=`export{nope as x}`;class Q{}var w={};export{b as BucketCachePurge,Q as DebugSessions,w as default};\n//# sourceMappingURL=worker.js.map\n";
    expect([...exportNames(minified)].sort()).toEqual([
      "BucketCachePurge",
      "DebugSessions",
      "default",
    ]);
    // Indented text inside an embedded source is not a top-level export.
    expect([
      ...exportNames("var s = `\n  export function middleware() {}\n`;\nexport { x };"),
    ]).toEqual(["x"]);
  });

  it("the bundle must be the artifact's set plus DebugSessions, exactly", () => {
    expect(compareExports(exportNames(ARTIFACT), exportNames(BUNDLE))).toEqual({
      missing: [],
      extra: [],
    });
    const lost = BUNDLE.replace("  DOQueueHandler,\n", "").replace(
      "worker_default2 as default",
      "",
    );
    expect(compareExports(exportNames(ARTIFACT), exportNames(lost))).toEqual({
      missing: ["DOQueueHandler", "default"],
      extra: [],
    });
    expect(
      compareExports(exportNames(ARTIFACT), new Set([...exportNames(BUNDLE), "Stray"])),
    ).toEqual({ missing: [], extra: ["Stray"] });
  });

  it("worker.ts re-exports the whole build and spreads its default handler", () => {
    const src = readFileSync("worker.ts", "utf8");
    expect(src).toContain('export * from "./.open-next/worker.js";');
    // The whole handler, with fetch wrapped only by the live-page check and the
    // session block on account writes
    // (lib/live-view/page-proxy.ts), which hands everything else to OpenNext.
    expect(src).toContain("export default {\n  ...handler,\n  fetch(");
    expect(src).toContain(
      'if (!mayBeLive(req.url, req.headers.get("cookie")) && !mayBeBlockedWrite(req))\n    return nextFetch(req, env, ctx);',
    );
    expect(src).toContain("export class DebugSessions");
  });
});
