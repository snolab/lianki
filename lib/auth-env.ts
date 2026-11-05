/**
 * Read NODE_ENV at runtime. The bundler (Turbopack/webpack DefinePlugin)
 * replaces the *literal* `process.env.NODE_ENV` with a string at build time; in
 * the production OpenNext build that bakes in "production" and dead-code-
 * eliminates the dev gate below, so a local `wrangler dev` could never re-enable
 * it via `.dev.vars`. A computed key defeats the static replacement, so the gate
 * reflects the actual runtime env. Prod stays safe: the deployed Worker has no
 * `.dev.vars`, so it still resolves "production" and the gate stays off.
 */
export function runtimeNodeEnv(): string | undefined {
  // `globalThis.process` indirection: DefinePlugin only rewrites the literal
  // `process.env.NODE_ENV` member chain, not a dynamic key off globalThis.
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  const key = ["NODE", "ENV"].join("_");
  return proc?.env?.[key];
}

/**
 * Dev-only email+password sign-in/up, so the full flow can be QA'd locally
 * without OAuth, SMTP or Turnstile. Never in production; the sign-in page asks
 * this too, so it only offers a password where one can work.
 *
 * Lives apart from auth-impl.ts so the sign-in page can ask without loading
 * better-auth.
 */
export function passwordAuthEnabled(): boolean {
  // A box signs in through lianki.com only (docs/box-oauth.md).
  if (process.env.LIANKI_BOX_CLIENT_ID) return false;
  return runtimeNodeEnv() !== "production" && process.env.DEV_EMAIL_PASSWORD_AUTH === "1";
}

/**
 * True when the request carries a better-auth session cookie (plain or
 * `__Secure-` prefixed). Without one, `getSession` can only answer null, so
 * callers may skip loading better-auth altogether — the common guest case.
 */
export function hasSessionCookie(headers: Headers): boolean {
  // A box token's signed identity counts too: auth.ts answers it with no cookie.
  if (headers.has("x-lk-box-identity")) return true;
  return headers.get("cookie")?.includes("better-auth.session_token=") ?? false;
}
