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
import { BOX_IDENTITY_HEADER } from "./lib/box-oauth/identity";
import { refreshOwners } from "./lib/owner-store";
import { refreshPermissions } from "./lib/permission-store";

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
        // A box token's request (lib/box-oauth/gate.ts): that account, or nobody.
        // There is no cookie on it to fall back to.
        if (endpoint === "getSession") {
          const headers = (args[0] as { headers?: Headers } | undefined)?.headers;
          if (headers?.has(BOX_IDENTITY_HEADER)) {
            const { boxSessionFrom } = await import("./lib/box-oauth/app-session");
            const box = await boxSessionFrom(headers);
            if (box) await Promise.all([refreshOwners(), refreshPermissions()]);
            return box;
          }
        }
        const api = (await getAuth()).api as Record<PropertyKey, (...a: unknown[]) => unknown>;
        const out = await api[endpoint](...args);
        // isAdmin()/isDev() are synchronous and answer from a snapshot of the
        // grants (lib/permissions.ts; step a also of site_role, lib/owner.ts):
        // have it fresh before a signed-in user is handed back. A guest costs
        // nothing; a failed read means nobody holds anything.
        if (endpoint === "getSession" && (out as { user?: unknown } | null)?.user)
          await Promise.all([refreshOwners(), refreshPermissions()]);
        return out;
      },
  }),
};
