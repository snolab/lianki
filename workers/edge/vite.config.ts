/**
 * The spike's build (docs/framework-migration.md, section 7). The aliases are
 * the whole seam between lib/ and "not Next":
 *
 * - `@opennextjs/cloudflare`: lib/d1 reads its bindings through
 *   getCloudflareContext; here that is the AsyncLocalStorage in src/context.ts.
 * - `better-auth/next-js`: nextCookies only serves server actions.
 * - `mongodb`, `node:sqlite`: the same stubs next.config.mjs aliases for the
 *   Cloudflare build. This Worker runs DB_BACKEND=d1 only.
 */
import { fileURLToPath } from "node:url";
import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

const at = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [
    cloudflare({
      // SPIKE_CONFIG: the bindings-free deployment that measures cold start.
      configPath: process.env.SPIKE_CONFIG ?? "./wrangler.jsonc",
      // scripts/compare-local.ts shares one local D1 with the main Worker.
      persistState: process.env.EDGE_PERSIST ? { path: process.env.EDGE_PERSIST } : true,
    }),
  ],
  resolve: {
    alias: [
      { find: /^@\//, replacement: at("../../") },
      // The root's tsconfig paths; packages/* are not linked into node_modules.
      { find: /^@lianki\/core$/, replacement: at("../../packages/core/src/index.ts") },
      { find: /^@lianki\/core\/(.*)$/, replacement: at("../../packages/core/src/") + "$1.ts" },
      { find: "@opennextjs/cloudflare", replacement: at("./src/context.ts") },
      { find: "better-auth/next-js", replacement: at("./src/shims/better-auth-next-js.ts") },
      { find: "mongodb", replacement: at("../../lib/stubs/mongodb.js") },
      { find: "node:sqlite", replacement: at("../../lib/stubs/node-sqlite.js") },
    ],
  },
});
