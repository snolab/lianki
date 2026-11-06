/**
 * The auth facade every route imports. Deliberately light: better-auth itself
 * lives in ./auth-impl and is loaded by dynamic import on first use.
 *
 * Why: a static import put better-auth + zod (~680 KB minified) into a merged
 * Turbopack chunk per route — 13+ near-identical copies in the Worker bundle,
 * and the Worker parses its whole bundle on an isolate's first request. Behind
 * `import()` it is one shared async chunk, loaded once per isolate and only by
 * requests that actually need auth.
 */
import type { Auth } from "./auth-impl";
import { refreshOwners } from "./lib/owner-store";

export type { Auth };
export { hasSessionCookie, passwordAuthEnabled } from "./lib/auth-env";

let impl: Promise<typeof import("./auth-impl")> | undefined;
const loadImpl = () => (impl ??= import("./auth-impl"));

/** The better-auth instance for the active DB backend (built once per isolate). */
export async function getAuth(): Promise<Auth> {
  return (await loadImpl()).getAuth();
}

/**
 * `auth.api.<endpoint>(…)` keeps working at every call site: each endpoint is
 * async already, so it is forwarded once the implementation has loaded.
 */
export const auth: Pick<Auth, "api"> = {
  api: new Proxy({} as Auth["api"], {
    get:
      (_target, endpoint) =>
      async (...args: unknown[]) => {
        const api = (await getAuth()).api as Record<PropertyKey, (...a: unknown[]) => unknown>;
        const out = await api[endpoint](...args);
        // isOwner() is synchronous and answers from a snapshot of site_role
        // (lib/owner.ts): have it fresh before a signed-in user is handed back.
        // A guest costs nothing; a failed read means nobody is the owner.
        if (endpoint === "getSession" && (out as { user?: unknown } | null)?.user)
          await refreshOwners();
        return out;
      },
  }),
};
