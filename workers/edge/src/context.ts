/**
 * What `@opennextjs/cloudflare` gives lib/d1 under OpenNext, without Next: the
 * current request's bindings. vite.config.ts aliases that package to this file,
 * so lib/d1, auth-impl.ts and lib/repos run here unchanged.
 */
import { AsyncLocalStorage } from "node:async_hooks";

type CloudflareContext = {
  env: unknown;
  ctx: { waitUntil(p: Promise<unknown>): void };
  cf: unknown;
};

const store = new AsyncLocalStorage<CloudflareContext>();

export const runWithCloudflareContext = <T>(context: CloudflareContext, fn: () => T): T =>
  store.run(context, fn);

export function getCloudflareContext(): CloudflareContext {
  const context = store.getStore();
  if (!context) throw new Error("getCloudflareContext outside a request");
  return context;
}
