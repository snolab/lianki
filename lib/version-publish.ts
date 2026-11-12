import type { VersionNews } from "./smart-refresh";

/** Internal explicit-news protocol; plain build-id publishes remain unchanged. */
export function explicitVersionNews(value: unknown): VersionNews {
  if (!value || typeof value !== "object") throw new Error("invalid version news");
  const v = value as Record<string, unknown>;
  if (typeof v.build !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(v.build))
    throw new Error("build must be 1–64 letters, digits, dots, underscores or hyphens");
  if (
    typeof v.shell !== "boolean" ||
    !v.routes ||
    typeof v.routes !== "object" ||
    Array.isArray(v.routes)
  )
    throw new Error("version news requires shell and routes");
  if (v.force !== undefined && typeof v.force !== "boolean") throw new Error("invalid force");
  for (const [route, changed] of Object.entries(v.routes))
    if (!route.startsWith("/") || route.length > 200 || (changed !== 0 && changed !== 1))
      throw new Error("routes must map paths to 0 or 1");
  return {
    build: v.build,
    ...(v.force === true ? { force: true } : {}),
    shell: v.shell,
    routes: v.routes as Record<string, 0 | 1>,
  };
}
