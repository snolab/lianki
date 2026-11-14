/** Explicit launcher configuration only; incoming request headers never feed this allowlist. */
export function devOrigins(env) {
  if (
    env.NODE_ENV !== "development" ||
    (env.LIANKI_DEV_WHOLE_PAGE !== "1" && env.LIANKI_DEVBOX !== "1")
  )
    return [];
  const hosts = env.BETTER_AUTH_BASE_URL ? [new URL(env.BETTER_AUTH_BASE_URL).hostname] : [];
  if (
    env.LIANKI_DEV_WHOLE_PAGE === "1" &&
    env.LIANKI_DEV_PUBLIC_HOST &&
    /^([a-z0-9-]+\.lianki\.com|[a-z0-9-]+\.trycloudflare\.com)$/.test(env.LIANKI_DEV_PUBLIC_HOST)
  )
    hosts.push(env.LIANKI_DEV_PUBLIC_HOST);
  return [...new Set(hosts)];
}
